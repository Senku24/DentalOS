import { z } from "zod";
import { isoDateTime, optionalText, pageQuery, trimmed, uuid } from "./common";
import { toothCode, toothSurface, toothSurfaces, toothSurfacesRefinement } from "./fdi";
import { consentResponse } from "./patients";
import { type TransitionTable, allowedTransitions, canTransition } from "./state-machine";

// Treatment plans, versions, sessions and versioned consent (PRD 4.5, 7.5). Rules:
// docs/adr/0003-clinical-domain-rules.md (PROPOSED — needs product sign-off).

export const TREATMENT_PLAN_STATUSES = [
  "DRAFT",
  "PRESENTED",
  "ACCEPTED",
  "PARTIALLY_ACCEPTED",
  "REJECTED",
  "COMPLETED",
  "CANCELLED",
] as const;
export type TreatmentPlanStatus = (typeof TREATMENT_PLAN_STATUSES)[number];
export const PLAN_ITEM_STATUSES = [
  "PROPOSED",
  "ACCEPTED",
  "REJECTED",
  "DEFERRED",
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];
export const PLAN_ITEM_SESSION_STATUSES = [
  "PLANNED",
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
] as const;
export const CONSENT_TEMPLATE_TYPES = [
  "TREATMENT_PLAN",
  "PROCEDURE",
  "RADIOGRAPH",
  "CLINICAL_PHOTOGRAPHY",
  "COMMUNICATION",
] as const;
export const SIGNER_RELATIONSHIPS = ["SELF", "GUARDIAN", "REPRESENTATIVE"] as const;
export const PRICE_SOURCES = ["BASE", "OVERRIDE"] as const;

export const treatmentPlanStatus = z.enum(TREATMENT_PLAN_STATUSES);
export const planItemStatus = z.enum(PLAN_ITEM_STATUSES);
export const planItemSessionStatus = z.enum(PLAN_ITEM_SESSION_STATUSES);
export const consentTemplateType = z.enum(CONSENT_TEMPLATE_TYPES);

// ---------------------------------------------------------------------------------------------
// State machines (ADR 0003, proposed)
// ---------------------------------------------------------------------------------------------

/**
 * Item lifecycle. Patient decisions: PROPOSED -> ACCEPTED / REJECTED / DEFERRED. Re-proposal
 * (REJECTED/DEFERRED -> PROPOSED) re-freezes the estimate at the current effective price.
 * SCHEDULED <-> ACCEPTED follows booking/cancelling its appointment. CANCELLED = withdrawn by the
 * clinician (reason required); presented items are cancelled, never deleted (DB trigger).
 */
export const PLAN_ITEM_TRANSITIONS: TransitionTable<PlanItemStatus> = {
  PROPOSED: ["ACCEPTED", "REJECTED", "DEFERRED", "CANCELLED"],
  DEFERRED: ["ACCEPTED", "REJECTED", "PROPOSED", "CANCELLED"],
  REJECTED: ["PROPOSED"],
  ACCEPTED: ["SCHEDULED", "IN_PROGRESS", "DEFERRED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "ACCEPTED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export const canTransitionPlanItem = (from: PlanItemStatus, to: PlanItemStatus) =>
  canTransition(PLAN_ITEM_TRANSITIONS, from, to);
export const allowedPlanItemTransitions = (from: PlanItemStatus) =>
  allowedTransitions(PLAN_ITEM_TRANSITIONS, from);

/** Target statuses that need `decisionReason`. */
export const PLAN_ITEM_REASON_REQUIRED: readonly PlanItemStatus[] = [
  "REJECTED",
  "DEFERRED",
  "CANCELLED",
];
/** Patient decisions (recorded with plan:approve). */
export const PLAN_ITEM_DECISIONS = ["ACCEPTED", "REJECTED", "DEFERRED"] as const;

/**
 * Permission to move an item INTO a status (any one), checked against the plan's branch. Use
 * `planItemTransitionPermissions(from, to)`: SCHEDULED -> ACCEPTED is an exception.
 */
export const PLAN_ITEM_TRANSITION_PERMISSIONS: Readonly<Record<PlanItemStatus, readonly string[]>> =
  {
    PROPOSED: ["plan:write"],
    ACCEPTED: ["plan:approve"],
    REJECTED: ["plan:approve"],
    DEFERRED: ["plan:approve"],
    SCHEDULED: ["plan:write", "appointment:write"],
    IN_PROGRESS: ["plan:write", "clinical:write"],
    COMPLETED: ["plan:write", "clinical:write"],
    CANCELLED: ["plan:write"],
  };

/**
 * Permission for one move (any one, against the plan's branch). SCHEDULED -> ACCEPTED is the undo of
 * booking (the item's appointment was cancelled), not a patient decision, so it needs what
 * SCHEDULED needs (`plan:write` or `appointment:write`) rather than `plan:approve`.
 */
export function planItemTransitionPermissions(
  from: PlanItemStatus,
  to: PlanItemStatus,
): readonly string[] {
  if (from === "SCHEDULED" && to === "ACCEPTED") return PLAN_ITEM_TRANSITION_PERMISSIONS.SCHEDULED;
  return PLAN_ITEM_TRANSITION_PERMISSIONS[to];
}

/**
 * Moves allowed on POST /plan-items/:id/status: every table transition except patient decisions
 * (ACCEPTED / REJECTED / DEFERRED go through POST /plans/:id/decisions) — with the one exception of
 * SCHEDULED -> ACCEPTED (appointment cancelled).
 */
export function isStatusEndpointTransition(from: PlanItemStatus, to: PlanItemStatus): boolean {
  if (!canTransitionPlanItem(from, to)) return false;
  if (to === "ACCEPTED") return from === "SCHEDULED";
  return !(PLAN_ITEM_DECISIONS as readonly string[]).includes(to);
}

/**
 * Plan lifecycle. Items drive it after presentation (`derivePlanStatus`); DRAFT -> PRESENTED takes
 * version 1; REJECTED -> PRESENTED re-presents a revised plan (new version). ACCEPTED /
 * PARTIALLY_ACCEPTED -> PRESENTED happens when the last accepted item is deferred (nothing accepted
 * any more). CANCELLED needs a reason (DB CHECK). Items of COMPLETED / CANCELLED plans are frozen.
 */
export const TREATMENT_PLAN_TRANSITIONS: TransitionTable<TreatmentPlanStatus> = {
  DRAFT: ["PRESENTED", "CANCELLED"],
  PRESENTED: ["ACCEPTED", "PARTIALLY_ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PRESENTED", "PARTIALLY_ACCEPTED", "COMPLETED", "CANCELLED"],
  PARTIALLY_ACCEPTED: ["PRESENTED", "ACCEPTED", "REJECTED", "COMPLETED", "CANCELLED"],
  REJECTED: ["PRESENTED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export const canTransitionPlan = (from: TreatmentPlanStatus, to: TreatmentPlanStatus) =>
  canTransition(TREATMENT_PLAN_TRANSITIONS, from, to);

/** Item statuses that count as "accepted by the patient" (incl. later progress). */
export const ACCEPTED_ITEM_STATUSES: readonly PlanItemStatus[] = [
  "ACCEPTED",
  "SCHEDULED",
  "IN_PROGRESS",
  "COMPLETED",
];

/**
 * Plan status implied by its items once presented (DRAFT, CANCELLED and COMPLETED plans are
 * returned unchanged). CANCELLED items are ignored. Rules, in order:
 *  - no live items                         -> unchanged
 *  - every item COMPLETED or REJECTED, >= 1 COMPLETED -> COMPLETED
 *  - every item ACCEPTED-or-later          -> ACCEPTED
 *  - every item REJECTED                   -> REJECTED
 *  - some ACCEPTED-or-later                -> PARTIALLY_ACCEPTED
 *  - otherwise (proposed/deferred/rejected mix, nothing accepted) -> PRESENTED
 */
export function derivePlanStatus(
  current: TreatmentPlanStatus,
  itemStatuses: readonly PlanItemStatus[],
): TreatmentPlanStatus {
  if (current === "DRAFT" || current === "CANCELLED" || current === "COMPLETED") return current;
  const live = itemStatuses.filter((s) => s !== "CANCELLED");
  if (live.length === 0) return current;
  const accepted = live.filter((s) => ACCEPTED_ITEM_STATUSES.includes(s)).length;
  if (live.every((s) => s === "COMPLETED" || s === "REJECTED") && live.includes("COMPLETED"))
    return "COMPLETED";
  if (accepted === live.length) return "ACCEPTED";
  if (live.every((s) => s === "REJECTED")) return "REJECTED";
  if (accepted > 0) return "PARTIALLY_ACCEPTED";
  return "PRESENTED";
}

/** Line total = frozen unit estimate x quantity (integer paise). */
export function planTotals(
  items: readonly { status: PlanItemStatus; estimatePricePaise: number; quantity: number }[],
) {
  const sum = (pred: (s: PlanItemStatus) => boolean) =>
    items
      .filter((i) => pred(i.status))
      .reduce((acc, i) => acc + i.estimatePricePaise * i.quantity, 0);
  return {
    /** Everything not rejected or cancelled. */
    estimatePaise: sum((s) => s !== "REJECTED" && s !== "CANCELLED"),
    acceptedPaise: sum((s) => ACCEPTED_ITEM_STATUSES.includes(s)),
    completedPaise: sum((s) => s === "COMPLETED"),
    pendingPaise: sum((s) => s === "PROPOSED" || s === "DEFERRED"),
  };
}
export const planTotalsResponse = z.object({
  estimatePaise: z.number().int(),
  acceptedPaise: z.number().int(),
  completedPaise: z.number().int(),
  pendingPaise: z.number().int(),
});
export type PlanTotals = z.infer<typeof planTotalsResponse>;

// ---------------------------------------------------------------------------------------------
// Plans & items
// ---------------------------------------------------------------------------------------------

const reasonText = trimmed(500).min(3);

/** The API freezes `estimatePricePaise` from the branch's effective catalogue price (pricing.ts). */
export const planItemInput = z
  .object({
    serviceId: uuid,
    phase: z.number().int().min(1).max(20).default(1),
    /** Order within the phase; defaults to last. */
    sequence: z.number().int().min(1).max(500).optional(),
    toothCode: toothCode.optional(),
    surfaces: toothSurfaces.default([]),
    quantity: z.number().int().min(1).max(100).default(1),
    notes: optionalText(1000),
  })
  .superRefine(toothSurfacesRefinement("create"));
export type PlanItemInput = z.infer<typeof planItemInput>;

export const createPlanRequest = z.object({
  patientId: uuid,
  /** Prices are frozen at this branch's effective prices. */
  branchId: uuid,
  title: trimmed(160),
  notes: optionalText(4000),
  encounterId: uuid.optional(),
  items: z.array(planItemInput).max(100).default([]),
});
export type CreatePlanRequest = z.infer<typeof createPlanRequest>;

/** PATCH. Once presented, every change creates a new version. */
export const updatePlanRequest = z.object({
  title: trimmed(160).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  /** Stored on the version snapshot when the plan is already presented. */
  reason: optionalText(500),
});
export type UpdatePlanRequest = z.infer<typeof updatePlanRequest>;

export const listPlansQuery = pageQuery.extend({
  patientId: uuid.optional(),
  branchId: uuid.optional(),
  status: treatmentPlanStatus.optional(),
});
export type ListPlansQuery = z.infer<typeof listPlansQuery>;

export const addPlanItemRequest = planItemInput;
export type AddPlanItemRequest = PlanItemInput;

/** PATCH (PROPOSED/DEFERRED items). `reprice: true` re-freezes the current effective price. */
export const updatePlanItemRequest = z
  .object({
    phase: z.number().int().min(1).max(20).optional(),
    sequence: z.number().int().min(1).max(500).optional(),
    toothCode: toothCode.nullable().optional(),
    surfaces: toothSurfaces.optional(),
    quantity: z.number().int().min(1).max(100).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    reprice: z.boolean().optional(),
    reason: optionalText(500),
  })
  .superRefine(toothSurfacesRefinement("patch"));
export type UpdatePlanItemRequest = z.infer<typeof updatePlanItemRequest>;

const needsReason = (to: PlanItemStatus, reason: string | undefined) =>
  !PLAN_ITEM_REASON_REQUIRED.includes(to) || (reason ?? "").length >= 3;

/**
 * POST /plan-items/:id/status — see `isStatusEndpointTransition` (the service must reject any other
 * move with 409 invalid_transition; `to: "ACCEPTED"` is valid only from SCHEDULED) and
 * `planItemTransitionPermissions`.
 */
export const planItemTransitionRequest = z
  .object({
    to: planItemStatus.extract([
      "PROPOSED",
      "ACCEPTED",
      "SCHEDULED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ]),
    reason: optionalText(500),
  })
  .refine((v) => needsReason(v.to, v.reason), { message: "Reason required", path: ["reason"] });
export type PlanItemTransitionRequest = z.infer<typeof planItemTransitionRequest>;

export const planItemDecision = z
  .object({
    itemId: uuid,
    decision: z.enum(PLAN_ITEM_DECISIONS),
    reason: optionalText(500),
  })
  .refine((v) => needsReason(v.decision, v.reason), {
    message: "Reason required",
    path: ["reason"],
  });

/** POST /plans/:id/decisions — per-item accept/reject/defer in one version (plan:approve). */
export const decidePlanItemsRequest = z.object({
  decisions: z
    .array(planItemDecision)
    .min(1)
    .max(100)
    .refine((d) => new Set(d.map((x) => x.itemId)).size === d.length, "Duplicate item"),
});
export type DecidePlanItemsRequest = z.infer<typeof decidePlanItemsRequest>;

/** DRAFT -> PRESENTED; takes version 1 (or N+1 when re-presenting a REJECTED plan). */
export const presentPlanRequest = z.object({ reason: optionalText(500) });
export type PresentPlanRequest = z.infer<typeof presentPlanRequest>;

/**
 * Records the patient's approval of the decided plan (plan:approve). With the default knob
 * `requirePlanConsentForApproval`, `consentId` must be a GRANTED TREATMENT_PLAN consent signed
 * against the plan's CURRENT version.
 */
export const approvePlanRequest = z.object({
  consentId: uuid.optional(),
  note: optionalText(500),
});
export type ApprovePlanRequest = z.infer<typeof approvePlanRequest>;

export const cancelPlanRequest = z.object({ reason: reasonText });

/** Tenant-level clinical knobs (Tenant.settings.clinical) — ADR 0003 §3.2. */
export const clinicalSettings = z.strictObject({
  /** Approving a plan needs a GRANTED TREATMENT_PLAN consent on its current version. */
  requirePlanConsentForApproval: z.boolean().optional(),
});
export type ClinicalSettings = z.infer<typeof clinicalSettings>;

/** Effective clinical knobs from raw Tenant.settings JSON (missing/invalid -> defaults). */
export function resolveClinicalSettings(rawTenantSettings: unknown): Required<ClinicalSettings> {
  const raw =
    rawTenantSettings && typeof rawTenantSettings === "object"
      ? (rawTenantSettings as { clinical?: unknown }).clinical
      : undefined;
  const parsed = clinicalSettings.safeParse(raw ?? {});
  return { requirePlanConsentForApproval: parsed.data?.requirePlanConsentForApproval ?? true };
}
export type CancelPlanRequest = z.infer<typeof cancelPlanRequest>;

export const planItemResponse = z.object({
  id: uuid,
  planId: uuid,
  phase: z.number().int(),
  sequence: z.number().int(),
  serviceId: uuid,
  toothCode: z.number().int().nullable(),
  surfaces: z.array(toothSurface),
  quantity: z.number().int(),
  estimatePricePaise: z.number().int(),
  priceSource: z.enum(PRICE_SOURCES),
  pricedAt: isoDateTime,
  status: planItemStatus,
  notes: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
});
export type PlanItemResponse = z.infer<typeof planItemResponse>;

export const treatmentPlanSummary = z.object({
  id: uuid,
  patientId: uuid,
  branchId: uuid,
  title: z.string(),
  status: treatmentPlanStatus,
  currentVersion: z.number().int(),
  totals: planTotalsResponse,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TreatmentPlanSummary = z.infer<typeof treatmentPlanSummary>;

export const treatmentPlanResponse = treatmentPlanSummary.extend({
  encounterId: uuid.nullable(),
  notes: z.string().nullable(),
  presentedAt: isoDateTime.nullable(),
  presentedBy: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  approvedBy: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string(),
  items: z.array(planItemResponse),
});
export type TreatmentPlanResponse = z.infer<typeof treatmentPlanResponse>;

// ---------------------------------------------------------------------------------------------
// Sessions (multi-visit procedures)
// ---------------------------------------------------------------------------------------------

export const createPlanItemSessionRequest = z.object({
  /** Defaults to the next number. */
  sessionNo: z.number().int().min(1).max(50).optional(),
  appointmentId: uuid.optional(),
  encounterId: uuid.optional(),
  status: planItemSessionStatus.default("PLANNED"),
  notes: optionalText(1000),
});
export type CreatePlanItemSessionRequest = z.infer<typeof createPlanItemSessionRequest>;

/** PATCH. Sessions are cancelled, never deleted. */
export const updatePlanItemSessionRequest = z.object({
  status: planItemSessionStatus.optional(),
  appointmentId: uuid.nullable().optional(),
  encounterId: uuid.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type UpdatePlanItemSessionRequest = z.infer<typeof updatePlanItemSessionRequest>;

export const planItemSessionResponse = z.object({
  id: uuid,
  planItemId: uuid,
  sessionNo: z.number().int(),
  appointmentId: uuid.nullable(),
  encounterId: uuid.nullable(),
  status: planItemSessionStatus,
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PlanItemSessionResponse = z.infer<typeof planItemSessionResponse>;

// ---------------------------------------------------------------------------------------------
// Versions (append-only snapshots) & diff
// ---------------------------------------------------------------------------------------------

export const planSnapshotItem = z.object({
  id: uuid,
  phase: z.number().int(),
  sequence: z.number().int(),
  serviceId: uuid,
  /** Denormalised for history display (catalogue names can change later). */
  serviceCode: z.string().optional(),
  serviceName: z.string().optional(),
  toothCode: z.number().int().nullable(),
  surfaces: z.array(z.string()),
  quantity: z.number().int(),
  estimatePricePaise: z.number().int(),
  priceSource: z.enum(PRICE_SOURCES),
  status: planItemStatus,
  decisionReason: z.string().nullable(),
  notes: z.string().nullable(),
});
export type PlanSnapshotItem = z.infer<typeof planSnapshotItem>;

/** TreatmentPlanVersion.snapshot — everything needed to show the plan as it was. */
export const planSnapshot = z.object({
  plan: z.object({
    id: uuid,
    patientId: uuid,
    branchId: uuid,
    title: z.string(),
    notes: z.string().nullable(),
    status: treatmentPlanStatus,
  }),
  items: z.array(planSnapshotItem),
  totals: planTotalsResponse,
});
export type PlanSnapshot = z.infer<typeof planSnapshot>;

export const planVersionResponse = z.object({
  id: uuid,
  planId: uuid,
  version: z.number().int(),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  snapshot: planSnapshot,
});
export type PlanVersionResponse = z.infer<typeof planVersionResponse>;

export const planDiff = z.object({
  planFields: z.array(z.string()),
  added: z.array(uuid),
  removed: z.array(uuid),
  changed: z.array(z.object({ itemId: uuid, fields: z.array(z.string()) })),
});
export type PlanDiff = z.infer<typeof planDiff>;

const sameValue = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Field-level diff between two snapshots (GET /plans/:id/versions/:a/diff/:b and the history UI). */
export function diffPlanSnapshots(before: PlanSnapshot, after: PlanSnapshot): PlanDiff {
  const planFields = (Object.keys(after.plan) as (keyof PlanSnapshot["plan"])[]).filter(
    (k) => !sameValue(before.plan[k], after.plan[k]),
  );
  const prev = new Map(before.items.map((i) => [i.id, i]));
  const next = new Map(after.items.map((i) => [i.id, i]));
  const changed: PlanDiff["changed"] = [];
  for (const [id, item] of next) {
    const old = prev.get(id);
    if (!old) continue;
    const fields = (Object.keys(item) as (keyof PlanSnapshotItem)[]).filter(
      (k) => !sameValue(old[k], item[k]),
    );
    if (fields.length > 0) changed.push({ itemId: id, fields });
  }
  return {
    planFields,
    added: [...next.keys()].filter((id) => !prev.has(id)),
    removed: [...prev.keys()].filter((id) => !next.has(id)),
    changed,
  };
}

// ---------------------------------------------------------------------------------------------
// Consent templates (versioned) & signed consent
// ---------------------------------------------------------------------------------------------

/** Stored upper-case, unique per tenant (DB CHECK + unique index). */
export const consentTemplateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/, "2-40 chars: letters, digits, _ or -");

const consentBody = z.string().trim().min(1).max(50_000);

/** Creates the template and publishes version 1 (consent:template). */
export const createConsentTemplateRequest = z.object({
  code: consentTemplateCode,
  type: consentTemplateType,
  title: trimmed(160),
  body: consentBody,
});
export type CreateConsentTemplateRequest = z.infer<typeof createConsentTemplateRequest>;

/** PATCH. Text changes publish a new version instead. */
export const updateConsentTemplateRequest = z.object({
  title: trimmed(160).optional(),
  active: z.boolean().optional(),
});
export type UpdateConsentTemplateRequest = z.infer<typeof updateConsentTemplateRequest>;

/** Publishes version N+1 (append-only); earlier signed consents keep pointing at their version. */
export const publishConsentTemplateVersionRequest = z.object({ body: consentBody });
export type PublishConsentTemplateVersionRequest = z.infer<
  typeof publishConsentTemplateVersionRequest
>;

export const listConsentTemplatesQuery = z.object({
  type: consentTemplateType.optional(),
  active: z.stringbool().optional(),
});
export type ListConsentTemplatesQuery = z.infer<typeof listConsentTemplatesQuery>;

export const consentTemplateResponse = z.object({
  id: uuid,
  code: z.string(),
  type: consentTemplateType,
  title: z.string(),
  active: z.boolean(),
  currentVersion: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ConsentTemplateResponse = z.infer<typeof consentTemplateResponse>;

export const consentTemplateVersionResponse = z.object({
  id: uuid,
  templateId: uuid,
  version: z.number().int(),
  body: z.string(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type ConsentTemplateVersionResponse = z.infer<typeof consentTemplateVersionResponse>;

/**
 * POST /patients/:id/consents/sign (consent:manage on `branchId`). Capture = in-person signature
 * image uploaded first as a PatientDocument (category CONSENT_FORM); OTP capture comes later.
 * TREATMENT_PLAN templates require `planVersionId` (the version the patient saw).
 * Creates a PatientConsent { type: template.type, version: String(templateVersion.version), GRANTED }.
 */
export const signConsentRequest = z
  .object({
    templateVersionId: uuid,
    branchId: uuid,
    planVersionId: uuid.optional(),
    method: z.enum(["DIGITAL", "PAPER"]).default("DIGITAL"),
    signatureDocumentId: uuid,
    signerRelationship: z.enum(SIGNER_RELATIONSHIPS).default("SELF"),
    /** Required when a guardian/representative signs (minors, PRD 4.4 primary dentition). */
    signerName: trimmed(160).optional(),
  })
  .refine((v) => v.signerRelationship === "SELF" || v.signerName !== undefined, {
    message: "signerName required when not signed by the patient",
    path: ["signerName"],
  });
export type SignConsentRequest = z.infer<typeof signConsentRequest>;

export const signedConsentResponse = consentResponse.extend({
  templateVersionId: uuid.nullable(),
  planVersionId: uuid.nullable(),
  signerName: z.string().nullable(),
  signerRelationship: z.enum(SIGNER_RELATIONSHIPS).nullable(),
});
export type SignedConsentResponse = z.infer<typeof signedConsentResponse>;
