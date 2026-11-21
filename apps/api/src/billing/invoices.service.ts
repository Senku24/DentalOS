import { type Prisma, PrismaClient, type Tx } from "@dentalos/db";
import {
  type CreateInvoiceFromPlanRequest,
  type CreateInvoiceRequest,
  type EstimateQuery,
  type InvoiceLineInput,
  type IssueInvoiceRequest,
  type ListInvoicesQuery,
  NOTIFICATION_QUEUES,
  type ResolvedBillingSettings,
  type SetInvoiceDiscountRequest,
  type UpdateInvoiceLineRequest,
  type UpdateInvoiceRequest,
  type VoidInvoiceRequest,
  amountInWordsINR,
  checkDiscount,
  computeInvoiceTotals,
  financialYearOf,
  formatInvoiceNumber,
  isAdHocLine,
  lineTaxRateBp,
  maxDiscountBpForRoles,
  planSnapshot,
  summarizeTax,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { effectivePrice, overridesFor } from "../catalog/pricing";
import { JobQueueService } from "../common/job-queue.service";
import { assertCan, branchWhere, withBranchScope } from "../common/principal";
import { findActivePatient } from "../patients/patient-common";
import {
  advisoryLock,
  allocateSeq,
  badRequest,
  conflict,
  dayAfter,
  dayStartInZone,
  decodeCursor,
  encodeCursor,
  findInvoiceScoped,
  fireAndLog,
  loadBranchSettings,
  loadInvoiceDetail,
  localDatePlus,
  lockInvoice,
  notFound,
  runTx,
  toInvoiceSummary,
} from "./billing-common";
import {
  type InvoiceDiscountState,
  NO_INVOICE_DISCOUNT,
  discountError,
  recomputeDraft,
} from "./invoice-calc";

/** Plan items that may be invoiced (ADR 0004 §1.3). */
const BILLABLE_PLAN_ITEM_STATUSES = ["ACCEPTED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"] as const;
const dateOnlyToDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

interface LineCtx {
  tx: Tx;
  p: Principal;
  invoice: {
    id: string;
    patientId: string;
    branchId: string;
    planId: string | null;
    encounterId: string | null;
  };
  settings: ResolvedBillingSettings;
  canDiscount: boolean;
  maxBp: number;
  overrides?: Awaited<ReturnType<typeof overridesFor>>;
}

/**
 * Invoices: DRAFT editing, discounts, GST, issue (gap-free number), void, print data, estimates (ADR 0004 §1-§3).
 * Issued invoices are never edited: the DB's `invoice_guard` refuses it, and corrections are credit / debit notes.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  private record(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "invoice",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }

  // -------------------------------------------------------------------------------------------
  // Line building
  // -------------------------------------------------------------------------------------------

  private async lineCtx(
    tx: Tx,
    p: Principal,
    invoice: LineCtx["invoice"],
    settings: ResolvedBillingSettings,
  ): Promise<LineCtx> {
    return {
      tx,
      p,
      invoice,
      settings,
      canDiscount: can(p, "discount:apply", { branchId: invoice.branchId }),
      maxBp: maxDiscountBpForRoles(p.roles, settings.discountLimitsBp),
    };
  }

  private checkLineDiscount(
    ctx: LineCtx,
    discount: { kind: "PERCENT"; percentBp: number } | { kind: "AMOUNT"; amountPaise: number },
    base: number,
    reason: string | null | undefined,
  ): number {
    const r = checkDiscount({
      discount,
      basePaise: base,
      reason,
      canApply: ctx.canDiscount,
      maxPercentBp: ctx.maxBp,
    });
    if (!r.ok) discountError(r.error);
    return r.amountPaise;
  }

  /** Server-priced line: catalogue (branch effective price), plan item (frozen estimate) or ad hoc (caller price). */
  private async buildLine(
    ctx: LineCtx,
    input: InvoiceLineInput,
    lineNo: number,
  ): Promise<Prisma.InvoiceLineUncheckedCreateInput> {
    const { tx, p, invoice, settings } = ctx;
    let serviceId = input.serviceId;
    let quantity = input.quantity;
    let unitPricePaise = input.unitPricePaise ?? 0;
    let toothCode = input.toothCode ?? null;
    let planItemId: string | null = null;

    if (input.planItemId) {
      const item = await tx.planItem.findFirst({
        where: { id: input.planItemId, patientId: invoice.patientId },
      });
      if (!item) throw notFound("plan_item_not_found");
      if (!invoice.planId || item.planId !== invoice.planId)
        throw conflict("plan_item_plan_mismatch");
      if (!(BILLABLE_PLAN_ITEM_STATUSES as readonly string[]).includes(item.status))
        throw conflict("plan_item_not_billable", { status: item.status });
      const billed = await tx.invoiceLine.findFirst({
        where: { planItemId: item.id, invoice: { status: { not: "VOID" } } },
        select: { id: true },
      });
      if (billed) throw conflict("plan_item_already_billed");
      planItemId = item.id;
      serviceId = item.serviceId;
      quantity = item.quantity;
      unitPricePaise = item.estimatePricePaise;
      toothCode = toothCode ?? item.toothCode;
    }

    let description = input.description ?? "";
    let hsnSac: string | null = null;
    let taxRateBp = 0;
    let serviceCategoryId: string | null = null;
    if (serviceId) {
      const service = await tx.service.findUnique({ where: { id: serviceId } });
      if (!service) throw notFound("service_not_found");
      if (!service.active && !planItemId) throw conflict("service_inactive");
      if (!planItemId) {
        ctx.overrides ??= await overridesFor(tx, p.tenantId, invoice.branchId, undefined);
        unitPricePaise = effectivePrice(
          service,
          invoice.branchId,
          ctx.overrides.get(service.id),
        ).pricePaise;
      }
      description = input.description ?? service.name;
      hsnSac = service.hsnSac;
      taxRateBp = lineTaxRateBp(service, settings.defaultGstRateBp);
      serviceCategoryId = service.categoryId;
    }

    let dentistUserId = input.dentistUserId ?? null;
    let encounterId = input.encounterId ?? null;
    let procedureRecordId: string | null = null;
    if (input.procedureRecordId) {
      const proc = await tx.procedureRecord.findFirst({
        where: { id: input.procedureRecordId, patientId: invoice.patientId },
      });
      if (!proc) throw notFound("procedure_not_found");
      if (proc.status !== "COMPLETED")
        throw conflict("procedure_not_billable", { status: proc.status });
      procedureRecordId = proc.id;
      encounterId = encounterId ?? proc.encounterId;
      dentistUserId = dentistUserId ?? proc.performedBy;
    }
    encounterId = encounterId ?? invoice.encounterId;
    if (encounterId) {
      const enc = await tx.encounter.findFirst({ where: { id: encounterId } });
      if (!enc || !can(p, "clinical:read", { branchId: enc.branchId }))
        throw notFound("encounter_not_found");
      if (enc.patientId !== invoice.patientId)
        throw conflict("link_patient_mismatch", { field: "encounterId" });
      dentistUserId = dentistUserId ?? enc.treatingDentistUserId;
    }

    const grossPaise = quantity * unitPricePaise;
    let discountPaise = 0;
    let discountReason: string | null = null;
    if (input.discount) {
      discountPaise = this.checkLineDiscount(ctx, input.discount, grossPaise, input.discountReason);
      discountReason = discountPaise > 0 ? (input.discountReason ?? null) : null;
    }

    return {
      tenantId: p.tenantId,
      invoiceId: invoice.id,
      patientId: invoice.patientId,
      lineNo,
      serviceId: serviceId ?? null,
      serviceCategoryId,
      description,
      hsnSac,
      quantity,
      unitPricePaise,
      grossPaise,
      discountPaise,
      discountReason,
      allocatedDiscountPaise: 0,
      taxableValuePaise: 0,
      taxRateBp,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      totalPaise: 0,
      planItemId,
      procedureRecordId,
      encounterId,
      dentistUserId,
      toothCode,
    };
  }

  /** Applies (or clears) the invoice-level discount on a DRAFT whose lines are already inserted. */
  /** Validates the discount and returns the state to persist (written with the totals by `recomputeDraft`). */
  private async resolveInvoiceDiscount(
    tx: Tx,
    p: Principal,
    inv: { id: string; branchId: string },
    settings: ResolvedBillingSettings,
    discount: SetInvoiceDiscountRequest["discount"],
    reason: string | undefined,
  ): Promise<InvoiceDiscountState> {
    if (discount === null) return NO_INVOICE_DISCOUNT;
    const lines = await tx.invoiceLine.findMany({ where: { invoiceId: inv.id } });
    const base = lines.reduce((a, l) => a + l.quantity * l.unitPricePaise - l.discountPaise, 0);
    const r = checkDiscount({
      discount,
      basePaise: base,
      reason,
      canApply: can(p, "discount:apply", { branchId: inv.branchId }),
      maxPercentBp: maxDiscountBpForRoles(p.roles, settings.discountLimitsBp),
    });
    if (!r.ok) discountError(r.error);
    if (r.amountPaise === 0) return NO_INVOICE_DISCOUNT;
    return {
      amountPaise: r.amountPaise,
      percentBp: discount.kind === "PERCENT" ? discount.percentBp : null,
      reason: reason ?? null,
      appliedBy: p.userId,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------------------------

  async create(p: Principal, body: CreateInvoiceRequest) {
    assertCan(p, "invoice:write", { branchId: body.branchId });
    const hasDiscount = body.invoiceDiscount !== undefined;
    const res = await runTx(this.prisma, p, async (tx) => {
      await findActivePatient(tx, body.patientId);
      const { settings } = await loadBranchSettings(tx, p.tenantId, body.branchId);
      if (body.encounterId) {
        const enc = await tx.encounter.findUnique({ where: { id: body.encounterId } });
        if (!enc || !can(p, "clinical:read", { branchId: enc.branchId }))
          throw notFound("encounter_not_found");
        if (enc.patientId !== body.patientId)
          throw conflict("link_patient_mismatch", { field: "encounterId" });
      }
      let planVersion: number | null = null;
      if (body.planId) {
        const plan = await tx.treatmentPlan.findFirst({ where: { id: body.planId } });
        if (!plan || !can(p, "plan:read", { branchId: plan.branchId }))
          throw notFound("plan_not_found");
        if (plan.patientId !== body.patientId)
          throw conflict("link_patient_mismatch", { field: "planId" });
        planVersion = plan.currentVersion >= 1 ? plan.currentVersion : null;
        await advisoryLock(tx, `plan_bill:${body.planId}`);
      }
      const inv = await tx.invoice.create({
        data: {
          tenantId: p.tenantId,
          branchId: body.branchId,
          patientId: body.patientId,
          taxInclusive: settings.taxInclusive,
          placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? null,
          dueDate: body.dueDate ? dateOnlyToDate(body.dueDate) : null,
          notes: body.notes || null,
          encounterId: body.encounterId ?? null,
          planId: body.planId ?? null,
          planVersion,
          subtotalPaise: 0,
          totalPaise: 0,
          balancePaise: 0,
          createdBy: p.userId,
        },
      });
      const ctx = await this.lineCtx(tx, p, inv, settings);
      for (const [i, input] of (body.lines ?? []).entries())
        await tx.invoiceLine.create({ data: await this.buildLine(ctx, input, i + 1) });
      const discountState = hasDiscount
        ? await this.resolveInvoiceDiscount(
            tx,
            p,
            inv,
            settings,
            body.invoiceDiscount ?? null,
            body.discountReason,
          )
        : undefined;
      await recomputeDraft(tx, p.tenantId, inv.id, settings, discountState);
      return loadInvoiceDetail(tx, inv.id);
    });
    await this.record(p, "invoice.create", res.id, res.branchId);
    if (res.invoiceDiscountPaise > 0 || res.lines.some((l) => l.discountPaise > 0))
      await this.record(p, "invoice.discount", res.id, res.branchId);
    return res;
  }

  /** Invoice from the plan's accepted / completed items at their frozen estimate price (ADR §1.3). */
  async createFromPlan(p: Principal, body: CreateInvoiceFromPlanRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const plan = await tx.treatmentPlan.findFirst({
        where: withBranchScope(p, { id: body.planId }),
      });
      if (!plan) throw notFound("plan_not_found");
      assertCan(p, "invoice:write", { branchId: plan.branchId });
      await findActivePatient(tx, plan.patientId);
      const { settings } = await loadBranchSettings(tx, p.tenantId, plan.branchId);
      await advisoryLock(tx, `plan_bill:${plan.id}`);

      const items = await tx.planItem.findMany({
        where: {
          planId: plan.id,
          ...(body.planItemIds ? { id: { in: body.planItemIds } } : {}),
        },
        orderBy: [{ phase: "asc" }, { sequence: "asc" }, { id: "asc" }],
      });
      if (body.planItemIds) {
        const missing = body.planItemIds.filter((id) => !items.some((i) => i.id === id));
        if (missing.length > 0) throw notFound("plan_item_not_found");
        const notBillable = items.filter(
          (i) => !(BILLABLE_PLAN_ITEM_STATUSES as readonly string[]).includes(i.status),
        );
        if (notBillable.length > 0)
          throw conflict("plan_item_not_billable", { planItemIds: notBillable.map((i) => i.id) });
      }
      const candidates = items.filter((i) =>
        (BILLABLE_PLAN_ITEM_STATUSES as readonly string[]).includes(i.status),
      );
      const billed = await tx.invoiceLine.findMany({
        where: {
          planItemId: { in: candidates.map((i) => i.id) },
          invoice: { status: { not: "VOID" } },
        },
        select: { planItemId: true },
      });
      const billedIds = new Set(billed.map((b) => b.planItemId));
      if (body.planItemIds && candidates.some((i) => billedIds.has(i.id)))
        throw conflict("plan_item_already_billed");
      const toBill = candidates.filter((i) => !billedIds.has(i.id));
      if (toBill.length === 0) throw conflict("plan_nothing_to_bill");

      const inv = await tx.invoice.create({
        data: {
          tenantId: p.tenantId,
          branchId: plan.branchId,
          patientId: plan.patientId,
          taxInclusive: settings.taxInclusive,
          placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? null,
          dueDate: body.dueDate ? dateOnlyToDate(body.dueDate) : null,
          notes: body.notes || null,
          encounterId: body.encounterId ?? null,
          planId: plan.id,
          planVersion: plan.currentVersion >= 1 ? plan.currentVersion : null,
          subtotalPaise: 0,
          totalPaise: 0,
          balancePaise: 0,
          createdBy: p.userId,
        },
      });
      const ctx = await this.lineCtx(tx, p, inv, settings);
      for (const [i, item] of toBill.entries()) {
        // Attribution follows the clinical record: the latest COMPLETED procedure done for this plan item.
        const proc = await tx.procedureRecord.findFirst({
          where: { planItemId: item.id, patientId: plan.patientId, status: "COMPLETED" },
          orderBy: { performedAt: "desc" },
        });
        const line = await this.buildLine(
          ctx,
          {
            planItemId: item.id,
            quantity: item.quantity,
            ...(proc ? { procedureRecordId: proc.id } : {}),
          },
          i + 1,
        );
        await tx.invoiceLine.create({ data: line });
      }
      await recomputeDraft(tx, p.tenantId, inv.id, settings);
      return loadInvoiceDetail(tx, inv.id);
    });
    await this.record(p, "invoice.create", res.id, res.branchId);
    return res;
  }

  // -------------------------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------------------------

  async list(p: Principal, q: ListInvoicesQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.InvoiceWhereInput[] = [branchWhere(p)];
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.planId) and.push({ planId: q.planId });
      if (q.status) and.push({ status: q.status });
      if (q.q) and.push({ number: { startsWith: q.q } });
      if (q.from || q.to) {
        const range = {
          ...(q.from ? { gte: dayStartInZone(q.from) } : {}),
          ...(q.to ? { lt: dayStartInZone(dayAfter(q.to)) } : {}),
        };
        and.push({ OR: [{ issuedAt: range }, { issuedAt: null, createdAt: range }] });
      }
      if (q.overdue) {
        and.push({
          status: { in: ["ISSUED", "PARTIALLY_PAID"] },
          balancePaise: { gt: 0 },
          dueDate: { lt: dayStartInZone(localDatePlus(new Date(), "Asia/Kolkata", 0)) },
        });
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        and.push({
          OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
        });
      }
      const rows = await tx.invoice.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        include: { patient: { select: { firstName: true, lastName: true } } },
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toInvoiceSummary),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  async get(p: Principal, id: string) {
    return runTx(this.prisma, p, async (tx) => {
      await findInvoiceScoped(tx, p, id);
      return loadInvoiceDetail(tx, id);
    });
  }

  /** Everything a printable tax invoice needs. `copy` = DUPLICATE once the invoice was printed before. */
  async print(p: Principal, id: string) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await findInvoiceScoped(tx, p, id);
      if (inv.status === "DRAFT" || !inv.number) throw conflict("invoice_not_issued");
      const detail = await loadInvoiceDetail(tx, id);
      const [tenant, branch, patient, prints] = await Promise.all([
        tx.tenant.findUnique({ where: { id: p.tenantId } }),
        tx.branch.findUnique({ where: { id: inv.branchId } }),
        tx.patient.findUnique({ where: { id: inv.patientId } }),
        tx.auditEvent.count({
          where: {
            tenantId: p.tenantId,
            resource: "invoice",
            resourceId: id,
            action: "invoice.print",
          },
        }),
      ]);
      if (!branch || !patient) throw notFound("invoice_not_found");
      const settingsName = (tenant?.settings as { displayName?: string } | null)?.displayName;
      return {
        invoice: detail,
        supplier: {
          name: settingsName ?? tenant?.name ?? "",
          branchName: branch.name,
          branchCode: branch.code,
          gstin: inv.supplierGstin,
          stateCode: inv.supplierStateCode,
          addressLines: [
            branch.addressLine1,
            branch.addressLine2,
            [branch.city, branch.state, branch.postalCode].filter(Boolean).join(", "),
          ].filter((l): l is string => Boolean(l)),
          phone: branch.phone,
        },
        patient: {
          name: `${patient.firstName} ${patient.lastName ?? ""}`.trim(),
          phone: patient.phone,
          mrn: patient.mrn,
        },
        taxSummary: summarizeTax(detail.lines),
        amountInWords: amountInWordsINR(inv.totalPaise),
        copy: prints > 0 ? ("DUPLICATE" as const) : ("ORIGINAL" as const),
      };
    });
    await this.record(p, "invoice.print", id, res.invoice.branchId);
    return res;
  }

  /** Plan items at a plan version's frozen prices, with the same GST maths as an invoice. Nothing is stored. */
  async estimate(p: Principal, q: EstimateQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const plan = await tx.treatmentPlan.findFirst({
        where: withBranchScope(p, { id: q.planId }),
      });
      if (!plan) throw notFound("plan_not_found");
      assertCan(p, "plan:read", { branchId: plan.branchId });
      assertCan(p, "billing:read", { branchId: plan.branchId });
      const { settings } = await loadBranchSettings(tx, p.tenantId, plan.branchId);

      type Item = {
        id: string;
        serviceId: string;
        toothCode: number | null;
        quantity: number;
        estimatePricePaise: number;
        status: string;
        name?: string;
      };
      let version = plan.currentVersion;
      let items: Item[];
      if (q.planVersion !== undefined && q.planVersion !== plan.currentVersion) {
        const v = await tx.treatmentPlanVersion.findFirst({
          where: { planId: plan.id, version: q.planVersion },
        });
        const snap = v ? planSnapshot.safeParse(v.snapshot) : null;
        if (!v || !snap?.success) throw notFound("plan_version_not_found");
        version = v.version;
        items = snap.data.items.map((i) => ({ ...i, name: i.serviceName }));
      } else {
        items = await tx.planItem.findMany({
          where: { planId: plan.id },
          orderBy: [{ phase: "asc" }, { sequence: "asc" }, { id: "asc" }],
        });
      }
      const services = await tx.service.findMany({
        where: { id: { in: [...new Set(items.map((i) => i.serviceId))] } },
      });
      const svc = new Map(services.map((s) => [s.id, s]));
      const counted = items.filter((i) => i.status !== "REJECTED" && i.status !== "CANCELLED");
      const totals = computeInvoiceTotals({
        lines: counted.map((i) => ({
          quantity: i.quantity,
          unitPricePaise: i.estimatePricePaise,
          taxRateBp: lineTaxRateBp(svc.get(i.serviceId), settings.defaultGstRateBp),
        })),
        taxInclusive: settings.taxInclusive,
        interState: false,
      });
      const billed = await tx.invoiceLine.findMany({
        where: { planItemId: { in: items.map((i) => i.id) }, invoice: { status: { not: "VOID" } } },
        select: { planItemId: true },
      });
      const billedIds = new Set(billed.map((b) => b.planItemId));
      const lines = items.map((i) => {
        const idx = counted.indexOf(i);
        const a = idx >= 0 ? totals.lines[idx] : undefined;
        return {
          planItemId: i.id,
          serviceId: i.serviceId,
          description: i.name ?? svc.get(i.serviceId)?.name ?? "",
          toothCode: i.toothCode,
          quantity: i.quantity,
          unitPricePaise: i.estimatePricePaise,
          grossPaise: i.quantity * i.estimatePricePaise,
          taxRateBp: a?.taxRateBp ?? 0,
          taxPaise: a ? a.cgstPaise + a.sgstPaise + a.igstPaise : 0,
          totalPaise: a?.totalPaise ?? 0,
          status: i.status,
          billed: billedIds.has(i.id),
        };
      });
      return {
        planId: plan.id,
        planVersion: version,
        patientId: plan.patientId,
        branchId: plan.branchId,
        taxInclusive: settings.taxInclusive,
        lines,
        subtotalPaise: totals.subtotalPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // DRAFT edits
  // -------------------------------------------------------------------------------------------

  /** Locks the invoice and proves it is an editable DRAFT in the caller's scope. */
  private async editableDraft(tx: Tx, p: Principal, id: string) {
    const inv = await findInvoiceScoped(tx, p, id);
    assertCan(p, "invoice:write", { branchId: inv.branchId });
    await lockInvoice(tx, id);
    const fresh = await tx.invoice.findUniqueOrThrow({ where: { id } });
    if (fresh.status !== "DRAFT") throw conflict("invoice_immutable", { status: fresh.status });
    return fresh;
  }

  async update(p: Principal, id: string, body: UpdateInvoiceRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      await tx.invoice.update({
        where: { id },
        data: {
          ...(body.dueDate !== undefined
            ? { dueDate: body.dueDate ? dateOnlyToDate(body.dueDate) : null }
            : {}),
          ...(body.placeOfSupplyStateCode !== undefined
            ? { placeOfSupplyStateCode: body.placeOfSupplyStateCode }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        },
      });
      await recomputeDraft(tx, p.tenantId, id, settings);
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.update", id, res.branchId);
    return res;
  }

  async setDiscount(p: Principal, id: string, body: SetInvoiceDiscountRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      const state = await this.resolveInvoiceDiscount(
        tx,
        p,
        inv,
        settings,
        body.discount,
        body.reason,
      );
      await recomputeDraft(tx, p.tenantId, id, settings, state);
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.discount", id, res.branchId);
    return res;
  }

  async addLine(p: Principal, id: string, input: InvoiceLineInput) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      if (inv.planId) await advisoryLock(tx, `plan_bill:${inv.planId}`);
      const agg = await tx.invoiceLine.aggregate({
        where: { invoiceId: id },
        _max: { lineNo: true },
      });
      const ctx = await this.lineCtx(tx, p, inv, settings);
      await tx.invoiceLine.create({
        data: await this.buildLine(ctx, input, (agg._max.lineNo ?? 0) + 1),
      });
      await recomputeDraft(tx, p.tenantId, id, settings);
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.update", id, res.branchId);
    if (input.discount) await this.record(p, "invoice.discount", id, res.branchId);
    return res;
  }

  async updateLine(p: Principal, id: string, lineId: string, body: UpdateInvoiceLineRequest) {
    let discounted = false;
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId: id } });
      if (!line) throw notFound("invoice_line_not_found");
      if (body.unitPricePaise !== undefined && !isAdHocLine(line))
        throw badRequest("price_override_not_allowed");

      const quantity = body.quantity ?? line.quantity;
      const unitPricePaise = body.unitPricePaise ?? line.unitPricePaise;
      const gross = quantity * unitPricePaise;
      const ctx = await this.lineCtx(tx, p, inv, settings);
      let discountPaise = line.discountPaise;
      let discountReason = line.discountReason;
      const repriced = quantity !== line.quantity || unitPricePaise !== line.unitPricePaise;
      if (body.discount === null) {
        discountPaise = 0;
        discountReason = null;
      } else if (body.discount !== undefined) {
        const reason = body.discountReason ?? line.discountReason;
        discountPaise = this.checkLineDiscount(ctx, body.discount, gross, reason);
        discountReason = discountPaise > 0 ? (reason ?? null) : null;
        discounted = discountPaise > 0;
      } else if (repriced && line.discountPaise > 0) {
        // Re-pricing a discounted line re-applies its discount: same permission, reason and limit, on the new base.
        discountPaise = this.checkLineDiscount(
          ctx,
          { kind: "AMOUNT", amountPaise: line.discountPaise },
          gross,
          line.discountReason,
        );
        discounted = true;
      } else if (body.discountReason !== undefined && line.discountPaise > 0) {
        if (body.discountReason === null) throw badRequest("discount_reason_required");
        discountReason = body.discountReason;
      }
      await tx.invoiceLine.update({
        where: { id: lineId },
        data: {
          quantity,
          unitPricePaise,
          grossPaise: gross,
          discountPaise,
          discountReason,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.dentistUserId !== undefined ? { dentistUserId: body.dentistUserId } : {}),
          ...(body.toothCode !== undefined ? { toothCode: body.toothCode } : {}),
        },
      });
      await recomputeDraft(tx, p.tenantId, id, settings);
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.update", id, res.branchId);
    if (discounted) await this.record(p, "invoice.discount", id, res.branchId);
    return res;
  }

  async deleteLine(p: Principal, id: string, lineId: string) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId: id } });
      if (!line) throw notFound("invoice_line_not_found");
      await tx.invoiceLine.delete({ where: { id: lineId } });
      await recomputeDraft(tx, p.tenantId, id, settings);
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.update", id, res.branchId);
    return res;
  }

  // -------------------------------------------------------------------------------------------
  // Issue / void
  // -------------------------------------------------------------------------------------------

  /**
   * DRAFT -> ISSUED in ONE transaction: lock + validate, re-derive the GST of the lines from the current supplier
   * state, `allocate_document_seq` (the counter row stays locked until commit: gap-free), freeze the invoice, ledger.
   */
  async issue(p: Principal, id: string, body: IssueInvoiceRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await this.editableDraft(tx, p, id);
      const { branch, settings } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
      const lineCount = await tx.invoiceLine.count({ where: { invoiceId: id } });
      if (lineCount === 0) throw conflict("invoice_empty");
      await recomputeDraft(tx, p.tenantId, id, settings);
      const fresh = await tx.invoice.findUniqueOrThrow({ where: { id } });

      const now = new Date();
      const fy = financialYearOf(now, branch.timezone);
      const seq = await allocateSeq(tx, p.tenantId, branch.id, "INV", fy);
      const number = formatInvoiceNumber(branch.code, fy, seq);
      const dueDate = body.dueDate
        ? dateOnlyToDate(body.dueDate)
        : (fresh.dueDate ??
          dateOnlyToDate(localDatePlus(now, branch.timezone, settings.invoiceDueDays)));
      await tx.invoice.update({
        where: { id },
        data: {
          status: fresh.totalPaise === 0 ? "PAID" : "ISSUED",
          number,
          issuedAt: now,
          issuedBy: p.userId,
          dueDate,
          supplierGstin: settings.gstin,
          supplierStateCode: settings.stateCode,
          placeOfSupplyStateCode: fresh.placeOfSupplyStateCode ?? settings.stateCode,
        },
      });
      await tx.financeLedgerEntry.create({
        data: {
          tenantId: p.tenantId,
          branchId: fresh.branchId,
          patientId: fresh.patientId,
          kind: "INVOICE",
          amountPaise: fresh.totalPaise,
          invoiceId: id,
          occurredAt: now,
          createdBy: p.userId,
        },
      });
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.issue", id, res.branchId);
    fireAndLog(
      "invoice-issued",
      this.jobs.enqueue(NOTIFICATION_QUEUES.INVOICE_ISSUED, {
        tenantId: p.tenantId,
        actorId: p.userId,
        source: "billing",
        idempotencyKey: `invoice-issued:${id}`,
        data: { invoiceId: id },
      }),
    );
    return res;
  }

  /** DRAFT, or an unpaid un-adjusted ISSUED invoice, with a reason. The number of a void invoice is never reused. */
  async void(p: Principal, id: string, body: VoidInvoiceRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const inv = await findInvoiceScoped(tx, p, id);
      assertCan(p, "invoice:write", { branchId: inv.branchId });
      await lockInvoice(tx, id);
      const cur = await tx.invoice.findUniqueOrThrow({ where: { id } });
      if (cur.status === "VOID") throw conflict("invoice_invalid_transition", { status: "VOID" });
      if (cur.status !== "DRAFT" && cur.status !== "ISSUED")
        throw conflict("invoice_not_voidable", { status: cur.status });
      if (cur.paidPaise !== 0 || cur.adjustmentPaise !== 0) throw conflict("invoice_not_voidable");
      const now = new Date();
      await tx.invoice.update({
        where: { id },
        data: { status: "VOID", voidReason: body.reason, voidedBy: p.userId, voidedAt: now },
      });
      if (cur.status === "ISSUED")
        await tx.financeLedgerEntry.create({
          data: {
            tenantId: p.tenantId,
            branchId: cur.branchId,
            patientId: cur.patientId,
            kind: "INVOICE_VOID",
            amountPaise: -cur.totalPaise,
            invoiceId: id,
            occurredAt: now,
            createdBy: p.userId,
          },
        });
      return loadInvoiceDetail(tx, id);
    });
    await this.record(p, "invoice.void", id, res.branchId);
    return res;
  }
}
