import { type Patient, Prisma, PrismaClient, withTenant } from "@dentalos/db";
import {
  type CreatePatientRequest,
  type SearchPatientsQuery,
  type UpdatePatientRequest,
  type VerifyIdentityRequest,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import { EventBus } from "../realtime/event-bus";
import { LIKELY_THRESHOLD } from "./duplicate-scoring";
import {
  type DuplicateMatch,
  DuplicatesService,
  probeFrom,
  probeOfPatient,
} from "./duplicates.service";
import { LIFECYCLE_TRANSITIONS, type LifecycleStage, canTransition } from "./lifecycle";
import {
  findActivePatient,
  findPatientOr404,
  toDate,
  toResponse,
  toSummary,
} from "./patient-common";

const IDENTITY_FIELDS = ["firstName", "middleName", "lastName", "phone", "email", "dob"] as const;

const badRequest = (path: string, message: string) =>
  new BadRequestException({ error: "validation_failed", issues: [{ path, message }] });

@Injectable()
export class PatientsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
    private readonly duplicates: DuplicatesService,
  ) {}

  /**
   * Registers a patient (any intake type). URGENT intake needs only a first name and is never held
   * up by the duplicate warning (likely pairs still go to the review queue). Other intakes need a
   * phone or email, and likely duplicates return 409 until the caller sets `acknowledgeDuplicates`.
   */
  async create(p: Principal, body: CreatePatientRequest) {
    // Patients are tenant-shared, but the registering branch must be one the caller works at.
    assertCan(p, "branch:read", { branchId: body.originBranchId });
    if (body.intakeType !== "URGENT" && !body.phone && !body.email)
      throw badRequest("phone", "Phone or email required unless intake is URGENT");
    const probe = probeFrom(body);

    const { patient, likely, enquiryId } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const branch = await tx.branch.findUnique({ where: { id: body.originBranchId } });
        if (!branch) throw new NotFoundException({ error: "branch_not_found" });
        if (!branch.active) throw new ConflictException({ error: "branch_inactive" });
        if (body.enquiryId) {
          const e = await tx.patientEnquiry.findUnique({ where: { id: body.enquiryId } });
          if (!e) throw new NotFoundException({ error: "enquiry_not_found" });
          if (e.status === "CONVERTED")
            throw new ConflictException({ error: "enquiry_already_converted" });
        }
        const matches = await this.duplicates.findMatches(tx, p.tenantId, probe);
        const likely = matches.filter((m) => m.score >= LIKELY_THRESHOLD);
        if (likely.length > 0 && !body.acknowledgeDuplicates && body.intakeType !== "URGENT")
          throw new ConflictException({ error: "possible_duplicates", matches: likely });

        const patient = await tx.patient.create({
          data: {
            tenantId: p.tenantId,
            originBranchId: body.originBranchId,
            firstName: body.firstName,
            middleName: body.middleName,
            lastName: body.lastName,
            preferredName: body.preferredName,
            dob: body.dob ? toDate(body.dob) : null,
            sex: body.sex,
            phone: body.phone,
            altPhone: body.altPhone,
            email: body.email,
            addressLine1: body.addressLine1,
            addressLine2: body.addressLine2,
            city: body.city,
            state: body.state,
            postalCode: body.postalCode,
            country: body.country,
            nameNormalized: probe.nameNormalized,
            phoneNormalized: probe.phoneNormalized,
            emailNormalized: probe.emailNormalized,
            intakeType: body.intakeType,
            createdBy: p.userId,
          },
        });
        await this.duplicates.persistLikely(tx, p.tenantId, patient.id, likely);
        if (body.enquiryId) {
          // Conditional update closes the race where two staff convert the same enquiry.
          const n = await tx.patientEnquiry.updateMany({
            where: { id: body.enquiryId, status: { not: "CONVERTED" } },
            data: { status: "CONVERTED", convertedPatientId: patient.id, convertedAt: new Date() },
          });
          if (n.count !== 1) throw new ConflictException({ error: "enquiry_already_converted" });
        }
        return { patient, likely, enquiryId: body.enquiryId };
      },
      { actorId: p.userId },
    );

    const branchId = patient.originBranchId;
    await this.audit.record(p, {
      action: "patient.create",
      resource: "patient",
      resourceId: patient.id,
      branchId,
      outcome: "success",
    });
    if (likely.length > 0)
      await this.audit.record(p, {
        action: body.acknowledgeDuplicates
          ? "patient.duplicates_acknowledged"
          : "patient.duplicates_flagged",
        resource: "patient",
        resourceId: patient.id,
        branchId,
        outcome: "success",
      });
    if (enquiryId)
      await this.audit.record(p, {
        action: "enquiry.convert",
        resource: "patient_enquiry",
        resourceId: enquiryId,
        branchId,
        outcome: "success",
      });
    this.bus.publish({
      tenantId: p.tenantId,
      branchId,
      type: "patient.created",
      data: { id: patient.id },
    });
    return { ...toResponse(patient), possibleDuplicates: summariseMatches(likely) };
  }

  async get(p: Principal, id: string) {
    const patient = await withTenant(this.prisma, p.tenantId, (tx) => findPatientOr404(tx, id));
    return toResponse(patient);
  }

  async update(p: Principal, id: string, body: UpdatePatientRequest) {
    const { patient, likely } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await findActivePatient(tx, id);
        if (body.lifecycleStage) assertTransition(cur.lifecycleStage, body.lifecycleStage);
        const { lifecycleStage, dob, ...rest } = body;
        const data: Prisma.PatientUncheckedUpdateInput = { ...stripUndefined(rest) };
        if (lifecycleStage) data.lifecycleStage = lifecycleStage;
        if (dob !== undefined) data.dob = toDate(dob);
        const identityChanged = IDENTITY_FIELDS.some((f) => body[f] !== undefined);
        if (identityChanged) {
          data.nameNormalized = normalizeName(
            body.firstName ?? cur.firstName,
            body.middleName ?? cur.middleName,
            body.lastName ?? cur.lastName,
          );
          data.phoneNormalized = normalizePhoneIN(body.phone ?? cur.phone);
          data.emailNormalized = normalizeEmail(body.email ?? cur.email);
        }
        const patient = await tx.patient.update({ where: { id }, data });
        let likely: DuplicateMatch[] = [];
        if (identityChanged) {
          const matches = await this.duplicates.findMatches(
            tx,
            p.tenantId,
            probeOfPatient(patient),
            [id],
          );
          likely = matches.filter((m) => m.score >= LIKELY_THRESHOLD);
          await this.duplicates.persistLikely(tx, p.tenantId, id, likely);
        }
        return { patient, likely };
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.update",
      resource: "patient",
      resourceId: id,
      outcome: "success",
    });
    this.bus.publish({ tenantId: p.tenantId, type: "patient.updated", data: { id } });
    return { ...toResponse(patient), possibleDuplicates: summariseMatches(likely) };
  }

  async transition(p: Principal, id: string, stage: LifecycleStage) {
    const { patient, from } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await findActivePatient(tx, id);
        assertTransition(cur.lifecycleStage, stage);
        const patient = await tx.patient.update({ where: { id }, data: { lifecycleStage: stage } });
        return { patient, from: cur.lifecycleStage };
      },
      { actorId: p.userId },
    );
    if (from !== stage)
      await this.audit.record(p, {
        action: "patient.lifecycle",
        resource: "patient",
        resourceId: id,
        outcome: "success",
      });
    return toResponse(patient);
  }

  /** Stores method, document type and at most the last 4 characters — never a full id number. */
  async verifyIdentity(p: Principal, id: string, body: VerifyIdentityRequest) {
    if (body.method === "IN_PERSON_DOCUMENT" && !body.documentType)
      throw badRequest("documentType", "Document type required for in-person verification");
    if (body.documentLast4 && !body.documentType)
      throw badRequest("documentType", "Document type required with documentLast4");
    const patient = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, id);
        return tx.patient.update({
          where: { id },
          data: {
            identityVerifiedAt: new Date(),
            identityVerifiedBy: p.userId,
            identityVerificationMethod: body.method,
            identityDocumentType: body.documentType ?? null,
            identityDocumentLast4: body.documentLast4 ?? null,
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.identity.verify",
      resource: "patient",
      resourceId: id,
      outcome: "success",
    });
    return toResponse(patient);
  }

  /**
   * Search/filter with keyset pagination over (rank, createdAt, id). Free text `q` matches MRN,
   * phone, email exactly (rank 3), name/phone substrings (rank 2) or name trigram similarity
   * (rank 1, pg_trgm `%`). Merged tombstones are excluded unless `includeMerged`.
   */
  async search(p: Principal, q: SearchPatientsQuery) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const conds: Prisma.Sql[] = [Prisma.sql`"tenantId" = ${p.tenantId}::uuid`];
      if (!q.includeMerged) conds.push(Prisma.sql`"mergedIntoId" IS NULL`);
      if (q.phone) conds.push(Prisma.sql`"phoneNormalized" = ${normalizePhoneIN(q.phone)}`);
      if (q.email) conds.push(Prisma.sql`"emailNormalized" = ${normalizeEmail(q.email)}`);
      if (q.dob) conds.push(Prisma.sql`dob = ${q.dob}::date`);
      if (q.originBranchId) conds.push(Prisma.sql`"originBranchId" = ${q.originBranchId}::uuid`);
      if (q.lifecycleStage)
        conds.push(Prisma.sql`"lifecycleStage" = ${q.lifecycleStage}::"PatientLifecycleStage"`);
      if (q.intakeType) conds.push(Prisma.sql`"intakeType" = ${q.intakeType}::"IntakeType"`);

      let rank = Prisma.sql`0`;
      if (q.q) {
        const { exact, partial, fuzzy } = textArms(q.q);
        const any = [...exact, ...partial, ...fuzzy];
        if (any.length === 0) return { items: [], nextCursor: null };
        conds.push(Prisma.sql`(${Prisma.join(any, " OR ")})`);
        const or = (xs: Prisma.Sql[]) =>
          xs.length ? Prisma.sql`(${Prisma.join(xs, " OR ")})` : Prisma.sql`false`;
        rank = Prisma.sql`CASE WHEN ${or(exact)} THEN 3 WHEN ${or(partial)} THEN 2 ELSE 1 END`;
      }
      const after = cursor
        ? Prisma.sql`WHERE (s.rank, s."createdAt", s.id) < (${cursor.r}::int, ${cursor.c}::timestamp, ${cursor.i}::uuid)`
        : Prisma.empty;
      const rows = await tx.$queryRaw<{ id: string; rank: number; created: string }[]>(Prisma.sql`
        SELECT s.id::text AS id, s.rank, to_char(s."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created
        FROM (
          SELECT id, "createdAt", (${rank})::int AS rank FROM "Patient"
          WHERE ${Prisma.join(conds, " AND ")}
        ) s
        ${after}
        ORDER BY s.rank DESC, s."createdAt" DESC, s.id DESC
        LIMIT ${q.limit + 1}`);
      const pageRows = rows.slice(0, q.limit);
      const byId = new Map<string, Patient>(
        (await tx.patient.findMany({ where: { id: { in: pageRows.map((r) => r.id) } } })).map(
          (x) => [x.id, x],
        ),
      );
      const items = pageRows.flatMap((r) => {
        const x = byId.get(r.id);
        return x ? [toSummary(x)] : [];
      });
      const last = pageRows.at(-1);
      const nextCursor =
        rows.length > q.limit && last
          ? encodeCursor(Number(last.rank), last.created, last.id)
          : null;
      return { items, nextCursor };
    });
  }
}

function textArms(text: string) {
  const exact: Prisma.Sql[] = [Prisma.sql`mrn = ${text}`];
  const partial: Prisma.Sql[] = [];
  const fuzzy: Prisma.Sql[] = [];
  const phone = normalizePhoneIN(text);
  if (phone) exact.push(Prisma.sql`"phoneNormalized" = ${phone}`);
  if (text.includes("@")) exact.push(Prisma.sql`"emailNormalized" = ${normalizeEmail(text)}`);
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 4) partial.push(Prisma.sql`"phoneNormalized" LIKE ${`%${digits}%`}`);
  // normalizeName leaves only letters, digits and single spaces, so no LIKE metacharacters remain.
  const name = normalizeName(text);
  if (name && !/^\d+$/.test(name)) {
    partial.push(Prisma.sql`"nameNormalized" LIKE ${`%${name}%`}`);
    fuzzy.push(Prisma.sql`"nameNormalized" % ${name}`);
  }
  return { exact, partial, fuzzy };
}

function encodeCursor(r: number, c: string, i: string) {
  return Buffer.from(JSON.stringify([r, c, i])).toString("base64url");
}

function decodeCursor(s: string): { r: number; c: string; i: string } {
  try {
    const [r, c, i] = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (
      typeof r === "number" &&
      Number.isInteger(r) &&
      typeof c === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(c) &&
      typeof i === "string" &&
      /^[0-9a-f-]{36}$/i.test(i)
    )
      return { r, c, i };
  } catch {
    // fall through
  }
  throw badRequest("cursor", "Invalid cursor");
}

function assertTransition(from: LifecycleStage, to: LifecycleStage) {
  if (!canTransition(from, to))
    throw new ConflictException({
      error: "invalid_lifecycle_transition",
      from,
      to,
      allowed: LIFECYCLE_TRANSITIONS[from],
    });
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const summariseMatches = (ms: DuplicateMatch[]) =>
  ms.map((m) => ({ patientId: m.patient.id, score: m.score, reasons: m.reasons }));
