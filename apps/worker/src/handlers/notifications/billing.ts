import {
  NOTIFICATION_QUEUES,
  invoiceIssuedJob,
  paymentReceiptJob,
  planConsentRequestJob,
  refundProcessedJob,
} from "@dentalos/validation";
import { PAYMENT_METHOD_LABEL, fmtDate, fmtMoney } from "./format";
import {
  dispatch,
  enqueueForPatient,
  loadBranch,
  loadPatientContact,
  loadSettings,
} from "./outbox";
import { type HandlerCtx, log, registerWork } from "./work";

/**
 * Receipt-type notifications enqueued by other modules by QUEUE NAME with ids only (billing: invoice issued, payment
 * RECORDED, refund PROCESSED; plans: consent requested). Each handler re-derives its message from the source rows (a job
 * is a nudge), skips quietly when the source is not in the expected state, and is idempotent through the outbox key.
 * Values are display strings only: no clinical content, no plan item names, no card data.
 */
export async function registerBillingHandlers(ctx: HandlerCtx) {
  await registerWork(ctx, NOTIFICATION_QUEUES.INVOICE_ISSUED, invoiceIssuedJob, async (c) => {
    const { invoiceId } = c.env.data;
    const row = await c.tx(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || !inv.number || inv.status === "DRAFT" || inv.status === "VOID") {
        log("info", "invoice notification skipped (not issued)", { invoiceId });
        return null;
      }
      const [patient, branch, settings] = await Promise.all([
        loadPatientContact(tx, inv.patientId),
        loadBranch(tx, inv.branchId),
        loadSettings(tx, c.env.tenantId),
      ]);
      if (!patient || !branch) return null;
      const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
        patient,
        actorId: c.env.actorId,
        branchId: inv.branchId,
        templateCode: "INVOICE_ISSUED",
        idempotencyKey: `invoice-issued:${inv.id}`,
        source: "invoice.issued",
        refType: "invoice",
        refId: inv.id,
        variables: {
          patientName: patient.displayName,
          invoiceNumber: inv.number,
          invoiceDate: fmtDate(inv.issuedAt ?? new Date(), branch.timeZone),
          totalAmount: fmtMoney(inv.totalPaise),
          balanceAmount: fmtMoney(inv.balancePaise),
          dueDate: inv.dueDate ? fmtDate(inv.dueDate, "UTC") : "on receipt",
          branchName: branch.name,
        },
      });
      if (!r.ok) {
        log("warn", "invoice notification not created", { invoiceId, reason: r.reason });
        return null;
      }
      return r.created ? r.row : null;
    });
    if (row) await dispatch(c, row);
  });

  await registerWork(ctx, NOTIFICATION_QUEUES.PAYMENT_RECEIPT, paymentReceiptJob, async (c) => {
    const { paymentId } = c.env.data;
    const row = await c.tx(async (tx) => {
      const pay = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!pay || pay.status !== "RECORDED" || !pay.receiptNumber) {
        log("info", "receipt notification skipped (payment not recorded)", { paymentId });
        return null;
      }
      const [patient, branch, settings, alloc] = await Promise.all([
        loadPatientContact(tx, pay.patientId),
        loadBranch(tx, pay.branchId),
        loadSettings(tx, c.env.tenantId),
        tx.paymentAllocation.findFirst({
          where: { paymentId: pay.id, amountPaise: { gt: 0 } },
          orderBy: { createdAt: "asc" },
          include: { invoice: { select: { number: true, balancePaise: true } } },
        }),
      ]);
      if (!patient || !branch) return null;
      const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
        patient,
        actorId: c.env.actorId,
        branchId: pay.branchId,
        templateCode: "PAYMENT_RECEIPT",
        idempotencyKey: `payment-receipt:${pay.id}`,
        source: "payment.recorded",
        refType: "payment",
        refId: pay.id,
        variables: {
          patientName: patient.displayName,
          receiptNumber: pay.receiptNumber,
          paidAmount: fmtMoney(pay.amountPaise),
          paymentMethod: PAYMENT_METHOD_LABEL[pay.method] ?? pay.method,
          paymentDate: fmtDate(pay.receivedAt, branch.timeZone),
          // Advance payments have no invoice: the placeholders then render as "-" instead of being missing.
          invoiceNumber: alloc?.invoice.number ?? "advance",
          balanceAmount: alloc ? fmtMoney(alloc.invoice.balancePaise) : "-",
          branchName: branch.name,
        },
      });
      if (!r.ok) {
        log("warn", "receipt notification not created", { paymentId, reason: r.reason });
        return null;
      }
      return r.created ? r.row : null;
    });
    if (row) await dispatch(c, row);
  });

  await registerWork(ctx, NOTIFICATION_QUEUES.REFUND_PROCESSED, refundProcessedJob, async (c) => {
    const { refundId } = c.env.data;
    const row = await c.tx(async (tx) => {
      const rf = await tx.refund.findUnique({
        where: { id: refundId },
        include: { payment: { select: { receiptNumber: true } } },
      });
      if (!rf || rf.status !== "PROCESSED") {
        log("info", "refund notification skipped (not processed)", { refundId });
        return null;
      }
      const [patient, branch, settings] = await Promise.all([
        loadPatientContact(tx, rf.patientId),
        loadBranch(tx, rf.branchId),
        loadSettings(tx, c.env.tenantId),
      ]);
      if (!patient || !branch) return null;
      const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
        patient,
        actorId: c.env.actorId,
        branchId: rf.branchId,
        templateCode: "REFUND_PROCESSED",
        idempotencyKey: `refund-processed:${rf.id}`,
        source: "refund.processed",
        refType: "refund",
        refId: rf.id,
        variables: {
          patientName: patient.displayName,
          refundAmount: fmtMoney(rf.amountPaise),
          refundDate: fmtDate(rf.processedAt ?? new Date(), branch.timeZone),
          receiptNumber: rf.payment.receiptNumber ?? "-",
          branchName: branch.name,
        },
      });
      if (!r.ok) {
        log("warn", "refund notification not created", { refundId, reason: r.reason });
        return null;
      }
      return r.created ? r.row : null;
    });
    if (row) await dispatch(c, row);
  });

  /**
   * Plan-consent request: the message carries a link and the plan title only (never items / prices / diagnoses).
   * The link base comes from PATIENT_PORTAL_URL; without it `consentLink` stays empty, so a template that uses the
   * placeholder fails loudly at send time (template_variables_missing) instead of sending a broken link.
   */
  await registerWork(
    ctx,
    NOTIFICATION_QUEUES.PLAN_CONSENT_REQUEST,
    planConsentRequestJob,
    async (c) => {
      const { planId, planVersion } = c.env.data;
      const row = await c.tx(async (tx) => {
        const plan = await tx.treatmentPlan.findUnique({ where: { id: planId } });
        if (!plan || plan.status === "CANCELLED" || plan.status === "DRAFT") {
          log("info", "plan consent request skipped (plan not presented)", { planId });
          return null;
        }
        const [patient, branch, settings] = await Promise.all([
          loadPatientContact(tx, plan.patientId),
          loadBranch(tx, plan.branchId),
          loadSettings(tx, c.env.tenantId),
        ]);
        if (!patient || !branch) return null;
        const base = process.env.PATIENT_PORTAL_URL?.replace(/\/+$/, "");
        const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
          patient,
          actorId: c.env.actorId,
          branchId: plan.branchId,
          templateCode: "PLAN_CONSENT_REQUEST",
          idempotencyKey: `plan-consent:${plan.id}:${planVersion}`,
          source: "plan.consent_requested",
          refType: "plan",
          refId: plan.id,
          variables: {
            patientName: patient.displayName,
            planTitle: plan.title,
            branchName: branch.name,
            branchPhone: branch.phone,
            consentLink: base ? `${base}/consent/${plan.id}?v=${planVersion}` : "",
          },
        });
        if (!r.ok) {
          log("warn", "plan consent request not created", { planId, reason: r.reason });
          return null;
        }
        return r.created ? r.row : null;
      });
      if (row) await dispatch(c, row);
    },
  );
}
