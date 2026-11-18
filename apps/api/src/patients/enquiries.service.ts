import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ConvertEnquiryRequest,
  type CreateEnquiryRequest,
  type ListEnquiriesQuery,
  type UpdateEnquiryRequest,
  normalizePhoneIN,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import { isUuid } from "./duplicates.service";
import { findActivePatient, toEnquiryResponse } from "./patient-common";
import { PatientsService } from "./patients.service";

/** Minimal lead capture (PRD 4.2: "not a full CRM"): create, list, status, convert. */
@Injectable()
export class EnquiriesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly patients: PatientsService,
  ) {}

  async create(p: Principal, body: CreateEnquiryRequest) {
    if (body.branchId) assertCan(p, "branch:read", { branchId: body.branchId });
    const e = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        if (body.branchId && !(await tx.branch.findUnique({ where: { id: body.branchId } })))
          throw new NotFoundException({ error: "branch_not_found" });
        return tx.patientEnquiry.create({
          data: {
            tenantId: p.tenantId,
            branchId: body.branchId,
            name: body.name,
            phone: body.phone,
            phoneNormalized: normalizePhoneIN(body.phone),
            email: body.email,
            source: body.source,
            areaOfInterest: body.areaOfInterest,
            notes: body.notes,
            createdBy: p.userId,
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "enquiry.create",
      resource: "patient_enquiry",
      resourceId: e.id,
      branchId: e.branchId ?? undefined,
      outcome: "success",
    });
    return toEnquiryResponse(e);
  }

  /** Branch-restricted principals see enquiries for their branches plus unassigned ones. */
  async list(p: Principal, q: ListEnquiriesQuery) {
    if (q.branchId) assertCan(p, "branch:read", { branchId: q.branchId });
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const and: Prisma.PatientEnquiryWhereInput[] = [];
      if (!p.orgWide) and.push({ OR: [{ branchId: null }, { branchId: { in: p.branchScope } }] });
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.status) and.push({ status: q.status });
      if (q.q) {
        const phone = normalizePhoneIN(q.q);
        and.push({
          OR: [
            { name: { contains: q.q, mode: "insensitive" } },
            ...(phone ? [{ phoneNormalized: phone }] : []),
            ...(q.q.includes("@")
              ? [{ email: { equals: q.q, mode: "insensitive" as const } }]
              : []),
          ],
        });
      }
      const rows = await tx.patientEnquiry.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor && isUuid(q.cursor) ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      const items = rows.slice(0, q.limit).map(toEnquiryResponse);
      return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  async get(p: Principal, id: string) {
    return toEnquiryResponse(
      await withTenant(this.prisma, p.tenantId, (tx) => this.findInScope(tx, p, id)),
    );
  }

  async update(p: Principal, id: string, body: UpdateEnquiryRequest) {
    const e = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await this.findInScope(tx, p, id);
        if (cur.status === "CONVERTED")
          throw new ConflictException({ error: "enquiry_already_converted" });
        return tx.patientEnquiry.update({
          where: { id },
          data: { status: body.status, areaOfInterest: body.areaOfInterest, notes: body.notes },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "enquiry.update",
      resource: "patient_enquiry",
      resourceId: id,
      branchId: e.branchId ?? undefined,
      outcome: "success",
    });
    return toEnquiryResponse(e);
  }

  /**
   * New patient: delegates to PatientsService.create (duplicate check first; 409 with matches unless
   * acknowledged). Existing patient: links the enquiry to it (typical after the check found a match).
   */
  async convert(p: Principal, id: string, body: ConvertEnquiryRequest) {
    await withTenant(this.prisma, p.tenantId, (tx) => this.findInScope(tx, p, id));
    if (!("existingPatientId" in body)) {
      const patient = await this.patients.create(p, { ...body, enquiryId: id });
      return { enquiryId: id, patientId: patient.id, created: true, patient };
    }
    const patientId = body.existingPatientId;
    await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        const n = await tx.patientEnquiry.updateMany({
          where: { id, status: { not: "CONVERTED" } },
          data: { status: "CONVERTED", convertedPatientId: patientId, convertedAt: new Date() },
        });
        if (n.count !== 1) throw new ConflictException({ error: "enquiry_already_converted" });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "enquiry.convert",
      resource: "patient_enquiry",
      resourceId: id,
      outcome: "success",
    });
    return { enquiryId: id, patientId, created: false };
  }

  private async findInScope(tx: Tx, p: Principal, id: string) {
    const e = await tx.patientEnquiry.findUnique({ where: { id } });
    // Out-of-scope branch enquiries are reported as missing (do not leak existence).
    if (!e || (e.branchId && !p.orgWide && !p.branchScope.includes(e.branchId)))
      throw new NotFoundException({ error: "enquiry_not_found" });
    return e;
  }
}
