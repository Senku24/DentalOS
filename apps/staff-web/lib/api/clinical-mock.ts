import {
  type AlertResponse,
  type AllergyResponse,
  type ClinicalContextResponse,
  type DocumentResponse,
  type EncounterDetailResponse,
  type EncounterResponse,
  type MedicalHistoryResponse,
  type PatientResponse,
  type PlanItemSessionResponse,
  type PlanItemStatus,
  type ToothRecordResponse,
  type TreatmentPlanStatus,
  addPlanItemRequest,
  allowedPlanItemTransitions,
  approvePlanRequest,
  canTransitionPlan,
  cancelPlanRequest,
  chartTeethRequest,
  createAmendmentRequest,
  createDiagnosisRequest,
  createNoteRequest,
  createPlanItemSessionRequest,
  createPlanRequest,
  createProcedureRequest,
  decidePlanItemsRequest,
  dentitionOf,
  derivePlanStatus,
  diffPlanSnapshots,
  isStatusEndpointTransition,
  openEncounterRequest,
  planItemTransitionRequest,
  planTotals,
  presentPlanRequest,
  signConsentRequest,
  supersedeToothRecordsRequest,
  updateDiagnosisRequest,
  updateEncounterRequest,
  updateNoteRequest,
  updatePlanItemRequest,
  updatePlanItemSessionRequest,
  updatePlanRequest,
  updateProcedureRequest,
  type z,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import * as C from "./clinical-fixtures";
import type { PlanDetail, PlanItemDetail } from "./clinical-types";
import { mapHttpError } from "./errors";
import { STAFF_DIRECTORY, assignments, fid, toPatientSummary } from "./fixtures";
import { mockHandler as m1 } from "./mock";
import {
  EDITABLE_ITEM_STATUSES,
  SCHEDULABLE_ITEM_STATUSES,
  isDecisionTransition,
} from "./plans-rules";
import { API_PREFIX } from "./routes";
import type { Items, Page, PriceListResponse } from "./types";

/**
 * In-memory fake of the M2 clinical / plans / consent API for mock mode, following the Wave 1
 * services' rules and error codes (encounter_signed, not_treating_dentist, consent_required,
 * item_still_scheduled, item_has_scheduled_sessions, invalid_plan_item, dentist_not_in_branch…).
 * Anything it does not own (patients, documents, catalogue) is delegated to the shared M1 mock, so
 * documents uploaded on the patient profile can be attached here. The caller is always `dev-user`.
 */

const ME = C.ME;
const LATENCY_MS = 180;

const db = {
  encounters: structuredClone(C.encounters),
  notes: structuredClone(C.notes),
  amendments: structuredClone(C.amendments),
  diagnoses: structuredClone(C.diagnoses),
  procedures: structuredClone(C.procedures),
  teeth: structuredClone(C.toothRecords),
  attachments: structuredClone(C.attachments),
  plans: structuredClone(C.plans),
  versions: structuredClone(C.planVersions),
  sessions: structuredClone(C.sessions),
  templates: structuredClone(C.consentTemplates),
  templateVersions: structuredClone(C.consentTemplateVersions),
  consents: structuredClone(C.signedConsents),
};

let seq = 5000;
const newId = (kind: string) => fid(kind, ++seq);
const now = () => new Date().toISOString();

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw mapHttpError(status, { error, ...extra });
};

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    fail(400, "validation_failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return (r as { data: z.output<T> }).data;
}

function paginate<T>(rows: T[], q: Record<string, string>): Page<T> {
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
  const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
  return {
    items: rows.slice(offset, offset + limit),
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
}

const m1get = <T>(path: string, query: Record<string, string> = {}) =>
  m1("GET", `${API_PREFIX}${path}`, query, undefined) as Promise<T>;

async function activePatient(id: string): Promise<PatientResponse> {
  const p = await m1get<PatientResponse>(`/patients/${id}`);
  if (p.mergedIntoId)
    fail(409, "patient_merged", { mergedIntoId: p.mergedIntoId, survivorId: p.mergedIntoId });
  return p;
}

// ---- Clinical ---------------------------------------------------------------------------------

function encounter(id: string | undefined): EncounterResponse {
  const e = db.encounters.find((x) => x.id === id);
  if (!e) return fail(404, "encounter_not_found");
  return e;
}
function openEncounter(id: string | undefined): EncounterResponse {
  const e = encounter(id);
  if (e.status !== "OPEN") fail(409, "encounter_signed");
  return e;
}

/** ADR 0003 addendum: the dentist needs clinical:sign at the branch (mock: a current assignment). */
function assertTreatingDentist(userId: string, branchId: string) {
  if (userId === ME) return;
  if (!STAFF_DIRECTORY[userId]) fail(400, "not_a_member", { field: "treatingDentistUserId" });
  const current = assignments.filter((a) => a.userId === userId && a.effectiveTo === null);
  if (current.length === 0) fail(400, "not_a_dentist", { field: "treatingDentistUserId" });
  if (!current.some((a) => a.branchId === branchId))
    fail(400, "dentist_not_in_branch", { field: "treatingDentistUserId" });
}

function detail(e: EncounterResponse): EncounterDetailResponse {
  const amend = db.amendments.filter((a) => a.encounterId === e.id);
  return {
    ...e,
    notes: db.notes
      .filter((n) => n.encounterId === e.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((n) => ({ ...n, amendments: amend.filter((a) => a.noteId === n.id) })),
    amendments: amend.filter((a) => a.noteId === null),
    diagnoses: db.diagnoses.filter((d) => d.encounterId === e.id),
    procedures: db.procedures.filter((p) => p.encounterId === e.id),
    toothRecords: db.teeth.filter((t) => t.encounterId === e.id),
  };
}

const assertAuthor = (authorId: string) => {
  if (authorId !== ME) fail(403, "not_author");
};
const assertAuthorOrTreating = (authorId: string, e: EncounterResponse) => {
  if (authorId !== ME && e.treatingDentistUserId !== ME) fail(403, "not_author");
};

function linkablePlanItem(planItemId: string, patientId: string) {
  const plan = db.plans.find((p) => p.items.some((i) => i.id === planItemId));
  const item = plan?.items.find((i) => i.id === planItemId);
  const bad = (reason: string) => fail(400, "invalid_plan_item", { field: "planItemId", reason });
  if (!plan || !item || plan.patientId !== patientId) return bad("not_found");
  if (plan.status === "COMPLETED" || plan.status === "CANCELLED") return bad("plan_closed");
  if (!SCHEDULABLE_ITEM_STATUSES.includes(item.status)) return bad("item_not_startable");
  return { plan, item };
}

/** Completed work linked to an ACCEPTED/SCHEDULED item starts it (encounters.service startPlanItem). */
function startPlanItem(planItemId: string) {
  const plan = db.plans.find((p) => p.items.some((i) => i.id === planItemId));
  const item = plan?.items.find((i) => i.id === planItemId);
  if (!plan || !item || (item.status !== "ACCEPTED" && item.status !== "SCHEDULED")) return;
  item.status = "IN_PROGRESS";
  commit(plan, "Procedure completed");
}

async function documentOf(id: string): Promise<DocumentResponse> {
  try {
    return await m1get<DocumentResponse>(`/documents/${id}`);
  } catch {
    return fail(404, "document_not_found");
  }
}

// ---- Plans ------------------------------------------------------------------------------------

function plan(id: string | undefined): PlanDetail {
  const p = db.plans.find((x) => x.id === id);
  if (!p) return fail(404, "plan_not_found");
  return p;
}
function itemOf(itemId: string | undefined) {
  for (const p of db.plans) {
    const item = p.items.find((i) => i.id === itemId);
    if (item) return { plan: p, item };
  }
  return fail(404, "plan_item_not_found");
}
const assertPlanOpen = (p: PlanDetail) => {
  if (p.status === "COMPLETED" || p.status === "CANCELLED")
    fail(409, "plan_closed", { status: p.status });
};
const assertPresented = (p: PlanDetail) => {
  if (p.status === "DRAFT") fail(409, "plan_not_presented", { status: p.status });
};

function refresh(p: PlanDetail) {
  for (const i of p.items) i.lineTotalPaise = i.estimatePricePaise * i.quantity;
  p.totals = planTotals(p.items);
  const phases = [...new Set(p.items.map((i) => i.phase))].sort((a, b) => a - b);
  p.phaseTotals = phases.map((phase) => ({
    phase,
    ...planTotals(p.items.filter((i) => i.phase === phase)),
  }));
  p.updatedAt = now();
}

/** plan-common commitPlanChange: re-derive status and append a version once presented. */
function commit(p: PlanDetail, reason: string | null | undefined, present = false) {
  refresh(p);
  if (p.currentVersion === 0 && !present) return;
  const derived = derivePlanStatus(
    p.status,
    p.items.map((i) => i.status),
  );
  if (derived !== p.status && canTransitionPlan(p.status, derived)) p.status = derived;
  p.currentVersion += 1;
  db.versions.push({
    id: newId("28"),
    planId: p.id,
    version: p.currentVersion,
    reason: reason?.trim() || null,
    createdBy: ME,
    createdAt: now(),
    snapshot: C.snapshotOf(p, p.items),
  });
}

async function freezePrice(branchId: string, serviceId: string) {
  const list = await m1get<PriceListResponse>("/catalog/price-list", { branchId });
  const s = list.items.find((x) => x.id === serviceId);
  if (!s) return fail(404, "service_not_found", { serviceId });
  if (!s.active) return fail(409, "service_inactive", { serviceId });
  return {
    estimatePricePaise: s.pricePaise,
    priceSource: s.source,
    pricedAt: now(),
  } as const;
}

async function newItem(
  p: PlanDetail,
  body: z.output<typeof addPlanItemRequest>,
): Promise<PlanItemDetail> {
  const price = await freezePrice(p.branchId, body.serviceId);
  const inPhase = p.items.filter((i) => i.phase === body.phase);
  const sequence = body.sequence ?? inPhase.reduce((m, i) => Math.max(m, i.sequence), 0) + 1;
  for (const i of inPhase) if (i.sequence >= sequence) i.sequence += 1;
  return {
    id: newId("27"),
    planId: p.id,
    phase: body.phase,
    sequence,
    serviceId: body.serviceId,
    toothCode: body.toothCode ?? null,
    surfaces: body.surfaces,
    quantity: body.quantity,
    ...price,
    status: p.currentVersion > 0 ? "PROPOSED" : "PROPOSED",
    notes: body.notes ?? null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
  };
}

const liveBooking = (itemId: string) =>
  db.sessions.some((s) => s.planItemId === itemId && s.status === "SCHEDULED");

function cancelOpenSessions(itemId: string) {
  for (const s of db.sessions)
    if (s.planItemId === itemId && (s.status === "PLANNED" || s.status === "SCHEDULED")) {
      s.status = "CANCELLED";
      s.updatedAt = now();
    }
}

/** sessions.service syncItem: the item follows its sessions where the item table allows it. */
function syncItem(p: PlanDetail, item: PlanItemDetail, to: PlanItemSessionResponse["status"]) {
  let target: PlanItemStatus | null = null;
  if (to === "COMPLETED" && (item.status === "ACCEPTED" || item.status === "SCHEDULED"))
    target = "IN_PROGRESS";
  if (!target) return;
  item.status = target;
  commit(p, `Session ${to.toLowerCase()}`);
}

// ---- Routing ----------------------------------------------------------------------------------

type Handler = (m: string[], q: Record<string, string>, body: unknown) => unknown;
const table: [Method, RegExp, Handler][] = [];
const on = (method: Method, pattern: string, h: Handler) =>
  table.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

// Context ----------------------------------------------------------------------------------------
on("GET", "/patients/:id/clinical-context", async ([id]) => {
  const patient = await m1get<PatientResponse>(`/patients/${id}`);
  const [allergies, alerts, history] = await Promise.all([
    m1get<Items<AllergyResponse>>(`/patients/${id}/allergies`, { includeResolved: "false" }),
    m1get<Items<AlertResponse>>(`/patients/${id}/alerts`, { includeResolved: "false" }),
    m1get<Items<MedicalHistoryResponse> | { versions: MedicalHistoryResponse[] }>(
      `/patients/${id}/medical-history`,
    ),
  ]);
  const versions = "versions" in history ? history.versions : history.items;
  const latest = [...versions].sort((a, b) => b.version - a.version)[0] ?? null;
  const mine = db.encounters.filter((e) => e.patientId === id);
  const res: ClinicalContextResponse = {
    patient: toPatientSummary(patient),
    alerts: alerts.items.filter((a) => a.active),
    allergies: allergies.items.filter((a) => a.active),
    latestMedicalHistory: latest,
    openEncounters: mine
      .filter((e) => e.status === "OPEN")
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    recentEncounters: mine
      .filter((e) => e.status === "SIGNED")
      .sort((a, b) => (b.signedAt ?? "").localeCompare(a.signedAt ?? ""))
      .slice(0, 10),
    activePlans: db.plans
      .filter((p) => p.patientId === id && p.status !== "COMPLETED" && p.status !== "CANCELLED")
      .map((p) => ({ id: p.id, title: p.title, status: p.status })),
    odontogram: db.teeth.filter((t) => t.patientId === id && t.status === "CURRENT"),
  };
  return res;
});

// Encounters ----------------------------------------------------------------------------------
on("GET", "/encounters", (_m, q) =>
  paginate(
    db.encounters
      .filter(
        (e) =>
          (!q.patientId || e.patientId === q.patientId) &&
          (!q.branchId || e.branchId === q.branchId) &&
          (!q.status || e.status === q.status) &&
          (!q.treatingDentistUserId || e.treatingDentistUserId === q.treatingDentistUserId),
      )
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    q,
  ),
);
on("POST", "/encounters", async (_m, _q, b) => {
  const body = parse(openEncounterRequest, b);
  await activePatient(body.patientId);
  if (body.appointmentId) fail(404, "appointment_not_found");
  const treating = body.treatingDentistUserId ?? ME;
  assertTreatingDentist(treating, body.branchId);
  const e: EncounterResponse = {
    id: newId("20"),
    patientId: body.patientId,
    branchId: body.branchId,
    appointmentId: null,
    treatingDentistUserId: treating,
    status: "OPEN",
    openedBy: ME,
    openedAt: now(),
    signedAt: null,
    signedBy: null,
  };
  db.encounters.push(e);
  return e;
});
on("GET", "/encounters/:id", ([id]) => detail(encounter(id)));
on("PATCH", "/encounters/:id", ([id], _q, b) => {
  const e = openEncounter(id);
  const body = parse(updateEncounterRequest, b);
  const next = body.treatingDentistUserId;
  if (next === undefined || next === e.treatingDentistUserId) return e;
  if (ME !== e.treatingDentistUserId && ME !== e.openedBy) fail(403, "not_treating_dentist");
  assertTreatingDentist(next, e.branchId);
  e.treatingDentistUserId = next;
  return e;
});
on("POST", "/encounters/:id/sign", ([id], _q, b) => {
  const e = openEncounter(id);
  if ((b as { attest?: unknown })?.attest !== true)
    fail(400, "validation_failed", {
      issues: [{ path: "attest", message: "Attestation required" }],
    });
  if (e.treatingDentistUserId !== ME) fail(403, "not_treating_dentist");
  Object.assign(e, { status: "SIGNED", signedAt: now(), signedBy: ME });
  return e;
});

on("POST", "/encounters/:id/notes", ([id], _q, b) => {
  const e = openEncounter(id);
  const body = parse(createNoteRequest, b);
  const n = {
    id: newId("21"),
    encounterId: e.id,
    kind: body.kind,
    body: body.body,
    authorId: ME,
    createdAt: now(),
    updatedAt: now(),
  };
  db.notes.push(n);
  return n;
});
on("PATCH", "/encounters/:id/notes/:noteId", ([id, noteId], _q, b) => {
  openEncounter(id);
  const n = db.notes.find((x) => x.id === noteId && x.encounterId === id);
  if (!n) return fail(404, "note_not_found");
  assertAuthor(n.authorId);
  const body = parse(updateNoteRequest, b);
  Object.assign(n, {
    ...(body.kind ? { kind: body.kind } : {}),
    ...(body.body ? { body: body.body } : {}),
    updatedAt: now(),
  });
  return n;
});
on("DELETE", "/encounters/:id/notes/:noteId", ([id, noteId]) => {
  const e = openEncounter(id);
  const n = db.notes.find((x) => x.id === noteId && x.encounterId === id);
  if (!n) return fail(404, "note_not_found");
  assertAuthorOrTreating(n.authorId, e);
  db.notes = db.notes.filter((x) => x !== n);
  return undefined;
});
on("GET", "/encounters/:id/amendments", ([id]) => ({
  items: db.amendments.filter((a) => a.encounterId === encounter(id).id),
}));
on("POST", "/encounters/:id/amendments", ([id], _q, b) => {
  const e = encounter(id);
  if (e.status !== "SIGNED") fail(409, "encounter_not_signed");
  const body = parse(createAmendmentRequest, b);
  if (body.noteId && !db.notes.some((n) => n.id === body.noteId && n.encounterId === e.id))
    fail(404, "note_not_found");
  const a = {
    id: newId("22"),
    encounterId: e.id,
    noteId: body.noteId ?? null,
    body: body.body,
    reason: body.reason,
    authorId: ME,
    createdAt: now(),
  };
  db.amendments.push(a);
  return a;
});

on("POST", "/encounters/:id/diagnoses", ([id], _q, b) => {
  const e = openEncounter(id);
  const body = parse(createDiagnosisRequest, b);
  const d = {
    id: newId("23"),
    encounterId: e.id,
    patientId: e.patientId,
    code: body.code,
    label: body.label,
    toothCode: body.toothCode ?? null,
    surfaces: body.surfaces,
    notes: body.notes ?? null,
    diagnosedBy: ME,
    createdAt: now(),
  };
  db.diagnoses.push(d);
  return d;
});
on("PATCH", "/encounters/:id/diagnoses/:did", ([id, did], _q, b) => {
  openEncounter(id);
  const d = db.diagnoses.find((x) => x.id === did && x.encounterId === id);
  if (!d) return fail(404, "diagnosis_not_found");
  assertAuthor(d.diagnosedBy);
  const body = parse(updateDiagnosisRequest, b);
  if (body.toothCode !== undefined) {
    d.toothCode = body.toothCode;
    d.surfaces = body.surfaces ?? [];
  } else if (body.surfaces) d.surfaces = body.surfaces;
  if (body.code) d.code = body.code;
  if (body.label) d.label = body.label;
  if (body.notes !== undefined) d.notes = body.notes || null;
  return d;
});
on("DELETE", "/encounters/:id/diagnoses/:did", ([id, did]) => {
  const e = openEncounter(id);
  const d = db.diagnoses.find((x) => x.id === did && x.encounterId === id);
  if (!d) return fail(404, "diagnosis_not_found");
  assertAuthorOrTreating(d.diagnosedBy, e);
  db.diagnoses = db.diagnoses.filter((x) => x !== d);
  return undefined;
});

on("POST", "/encounters/:id/procedures", ([id], _q, b) => {
  const e = openEncounter(id);
  const body = parse(createProcedureRequest, b);
  if (body.status === "ABANDONED") fail(400, "invalid_initial_status", { status: body.status });
  if (body.planItemId) linkablePlanItem(body.planItemId, e.patientId);
  const r = {
    id: newId("24"),
    encounterId: e.id,
    patientId: e.patientId,
    serviceId: body.serviceId ?? null,
    planItemId: body.planItemId ?? null,
    description: body.description || null,
    toothCode: body.toothCode ?? null,
    surfaces: body.surfaces,
    status: body.status,
    notes: body.notes ?? null,
    performedBy: ME,
    performedAt: body.performedAt ?? now(),
  };
  db.procedures.push(r);
  if (r.planItemId && r.status === "COMPLETED") startPlanItem(r.planItemId);
  return r;
});
on("PATCH", "/encounters/:id/procedures/:pid", ([id, pid], _q, b) => {
  openEncounter(id);
  const r = db.procedures.find((x) => x.id === pid && x.encounterId === id);
  if (!r) return fail(404, "procedure_not_found");
  assertAuthor(r.performedBy);
  const body = parse(updateProcedureRequest, b);
  if (body.status !== undefined) {
    const allowed = r.status === "IN_PROGRESS" ? ["COMPLETED", "ABANDONED"] : [];
    if (!allowed.includes(body.status))
      fail(409, "invalid_transition", { from: r.status, to: body.status, allowed });
  }
  const wasCompleted = r.status === "COMPLETED";
  if (body.status) r.status = body.status;
  if (body.notes !== undefined) r.notes = body.notes;
  if (body.description !== undefined) r.description = body.description || null;
  if (body.toothCode !== undefined) {
    r.toothCode = body.toothCode;
    r.surfaces = body.surfaces ?? [];
  } else if (body.surfaces) r.surfaces = body.surfaces;
  if (r.planItemId && r.status === "COMPLETED" && !wasCompleted) startPlanItem(r.planItemId);
  return r;
});
on("DELETE", "/encounters/:id/procedures/:pid", ([id, pid]) => {
  const e = openEncounter(id);
  const r = db.procedures.find((x) => x.id === pid && x.encounterId === id);
  if (!r) return fail(404, "procedure_not_found");
  assertAuthorOrTreating(r.performedBy, e);
  db.procedures = db.procedures.filter((x) => x !== r);
  return undefined;
});

on("GET", "/encounters/:id/documents", async ([id]) => {
  const e = encounter(id);
  const ids = Object.entries(db.attachments)
    .filter(([, encId]) => encId === e.id)
    .map(([docId]) => docId);
  const docs = await Promise.all(ids.map((d) => documentOf(d).catch(() => null)));
  return {
    items: docs
      .filter((d): d is DocumentResponse => d !== null && d.status === "AVAILABLE")
      .map((d) => ({ ...d, encounterId: e.id })),
  };
});
on("POST", "/encounters/:id/documents", async ([id], _q, b) => {
  const e = openEncounter(id);
  const documentId = (b as { documentId?: string })?.documentId ?? "";
  const doc = await documentOf(documentId);
  if (doc.patientId !== e.patientId) fail(400, "document_patient_mismatch");
  if (doc.status !== "AVAILABLE") fail(409, "document_not_available", { status: doc.status });
  const current = db.attachments[documentId];
  if (current && current !== e.id) fail(409, "document_already_attached", { encounterId: current });
  db.attachments[documentId] = e.id;
  return { ...doc, encounterId: e.id };
});
on("DELETE", "/encounters/:id/documents/:docId", ([id, docId]) => {
  const e = openEncounter(id);
  if (!docId || db.attachments[docId] !== e.id) return fail(404, "document_not_attached");
  delete db.attachments[docId];
  return undefined;
});

// Odontogram ----------------------------------------------------------------------------------
const chartingEncounter = (patientId: string, encounterId?: string) => {
  if (!encounterId) return null;
  const e = openEncounter(encounterId);
  if (e.patientId !== patientId) fail(400, "encounter_patient_mismatch");
  return e;
};
on("GET", "/patients/:id/odontogram", ([id], q) => {
  const history = q.includeHistory === "true";
  // Same rule as PatientClinicalService.odontogram: asOf = recorded by then and (unless history)
  // not superseded at that instant.
  const asOf = q.asOf || undefined;
  const instant = asOf ? Date.parse(asOf) : 0;
  const visible = (r: ToothRecordResponse) =>
    asOf
      ? Date.parse(r.recordedAt) <= instant &&
        (history || !r.supersededAt || Date.parse(r.supersededAt) > instant)
      : history || r.status === "CURRENT";
  return {
    patientId: id,
    asOf: asOf ?? now(),
    records: db.teeth
      .filter((t) => t.patientId === id && visible(t))
      .sort((a, b) => a.toothCode - b.toothCode || a.recordedAt.localeCompare(b.recordedAt)),
  };
});
on("POST", "/patients/:id/odontogram", async ([id], _q, b) => {
  await activePatient(id ?? "");
  const body = parse(chartTeethRequest, b);
  const enc = chartingEncounter(id ?? "", body.encounterId);
  const supersedes = body.records.flatMap((r) => (r.supersedesId ? [r.supersedesId] : []));
  if (new Set(supersedes).size !== supersedes.length) fail(400, "duplicate_supersedes");
  for (const r of body.records) {
    if (!r.supersedesId) continue;
    const old = db.teeth.find((t) => t.id === r.supersedesId && t.patientId === id);
    if (!old) fail(404, "tooth_record_not_found");
    else if (old.status !== "CURRENT") fail(409, "tooth_record_not_current");
    else if (old.toothCode !== r.toothCode) fail(400, "supersede_tooth_mismatch");
  }
  const at = now();
  for (const t of db.teeth)
    if (supersedes.includes(t.id))
      Object.assign(t, { status: "HISTORICAL", supersededAt: at, supersededBy: ME });
  const rows: ToothRecordResponse[] = body.records.map((r) => ({
    id: newId("25"),
    patientId: id ?? "",
    encounterId: enc?.id ?? null,
    toothCode: r.toothCode,
    dentition: dentitionOf(r.toothCode),
    condition: r.condition,
    surfaces: r.surfaces,
    notes: r.notes ?? null,
    status: "CURRENT",
    recordedBy: ME,
    recordedAt: at,
    supersededAt: null,
    supersededBy: null,
  }));
  db.teeth.push(...rows);
  return { items: rows };
});
on("POST", "/patients/:id/odontogram/supersede", async ([id], _q, b) => {
  await activePatient(id ?? "");
  const body = parse(supersedeToothRecordsRequest, b);
  chartingEncounter(id ?? "", body.encounterId);
  const rows = db.teeth.filter((t) => body.recordIds.includes(t.id) && t.patientId === id);
  if (rows.length !== new Set(body.recordIds).size) fail(404, "tooth_record_not_found");
  if (rows.some((t) => t.status !== "CURRENT")) fail(409, "tooth_record_not_current");
  for (const t of rows)
    Object.assign(t, { status: "HISTORICAL", supersededAt: now(), supersededBy: ME });
  return { items: rows };
});

// Plans ---------------------------------------------------------------------------------------
on("GET", "/plans", (_m, q) =>
  paginate(
    db.plans
      .filter(
        (p) =>
          (!q.patientId || p.patientId === q.patientId) &&
          (!q.branchId || p.branchId === q.branchId) &&
          (!q.status || p.status === q.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(
        ({
          id,
          patientId,
          branchId,
          title,
          status,
          currentVersion,
          totals,
          createdAt,
          updatedAt,
        }) => ({
          id,
          patientId,
          branchId,
          title,
          status,
          currentVersion,
          totals,
          createdAt,
          updatedAt,
        }),
      ),
    q,
  ),
);
on("POST", "/plans", async (_m, _q, b) => {
  const body = parse(createPlanRequest, b);
  await activePatient(body.patientId);
  if (body.encounterId && encounter(body.encounterId).patientId !== body.patientId)
    fail(409, "link_patient_mismatch", { field: "encounterId" });
  const p: PlanDetail = {
    id: newId("26"),
    patientId: body.patientId,
    branchId: body.branchId,
    title: body.title,
    notes: body.notes ?? null,
    status: "DRAFT",
    currentVersion: 0,
    totals: planTotals([]),
    createdAt: now(),
    updatedAt: now(),
    encounterId: body.encounterId ?? null,
    presentedAt: null,
    presentedBy: null,
    approvedAt: null,
    approvedBy: null,
    cancelReason: null,
    createdBy: ME,
    items: [],
  };
  for (const i of body.items) p.items.push(await newItem(p, i));
  refresh(p);
  db.plans.push(p);
  return p;
});
on("GET", "/plans/:id", ([id]) => plan(id));
on("PATCH", "/plans/:id", ([id], _q, b) => {
  const p = plan(id);
  assertPlanOpen(p);
  const body = parse(updatePlanRequest, b);
  let changed = false;
  if (body.title !== undefined && body.title !== p.title) {
    p.title = body.title;
    changed = true;
  }
  if (body.notes !== undefined && (body.notes || null) !== p.notes) {
    p.notes = body.notes || null;
    changed = true;
  }
  if (changed) commit(p, body.reason || "Plan details updated");
  return p;
});
on("POST", "/plans/:id/present", ([id], _q, b) => {
  const p = plan(id);
  const body = parse(presentPlanRequest, b);
  if (!canTransitionPlan(p.status, "PRESENTED"))
    fail(409, "invalid_transition", { from: p.status, to: "PRESENTED" });
  const live = p.items.filter((i) => i.status !== "CANCELLED");
  if (live.length === 0) fail(409, "plan_empty");
  if (p.status === "REJECTED" && !live.some((i) => EDITABLE_ITEM_STATUSES.includes(i.status)))
    fail(409, "nothing_to_present");
  Object.assign(p, { status: "PRESENTED", presentedAt: now(), presentedBy: ME });
  commit(p, body.reason || "Presented", true);
  return p;
});
on("POST", "/plans/:id/decisions", ([id], _q, b) => {
  const p = plan(id);
  assertPlanOpen(p);
  assertPresented(p);
  const body = parse(decidePlanItemsRequest, b);
  const counts: Record<string, number> = {};
  for (const d of body.decisions) {
    const item = p.items.find((i) => i.id === d.itemId);
    if (!item) return fail(404, "plan_item_not_found", { itemId: d.itemId });
    if (!isDecisionTransition(item.status, d.decision))
      fail(409, "invalid_transition", { from: item.status, to: d.decision, itemId: item.id });
    if (item.status === "ACCEPTED" && liveBooking(item.id))
      fail(409, "item_still_scheduled", { itemId: item.id });
  }
  for (const d of body.decisions) {
    const item = p.items.find((i) => i.id === d.itemId) as PlanItemDetail;
    Object.assign(item, {
      status: d.decision,
      decidedAt: now(),
      decidedBy: ME,
      decisionReason: d.reason || null,
    });
    counts[d.decision] = (counts[d.decision] ?? 0) + 1;
  }
  commit(
    p,
    `Patient decisions: ${Object.entries(counts)
      .map(([k, v]) => `${v} ${k.toLowerCase()}`)
      .join(", ")}`,
  );
  return p;
});
on("POST", "/plans/:id/approve", ([id], _q, b) => {
  const p = plan(id);
  const body = parse(approvePlanRequest, b);
  if (p.status !== "ACCEPTED" && p.status !== "PARTIALLY_ACCEPTED")
    fail(409, "plan_not_decided", { status: p.status });
  const current = db.versions.find((v) => v.planId === p.id && v.version === p.currentVersion);
  if (!current) return fail(409, "plan_not_presented");
  if (p.approvedAt && p.approvedAt >= current.createdAt)
    fail(409, "already_approved", { version: current.version });
  const consent = db.consents.find(
    (c) =>
      (!body.consentId || c.id === body.consentId) &&
      c.patientId === p.patientId &&
      c.type === "TREATMENT_PLAN" &&
      c.status === "GRANTED" &&
      c.planVersionId === current.id,
  );
  if (!consent)
    fail(409, "consent_required", { planVersionId: current.id, version: current.version });
  Object.assign(p, { approvedAt: now(), approvedBy: ME });
  return p;
});
on("POST", "/plans/:id/cancel", ([id], _q, b) => {
  const p = plan(id);
  const body = parse(cancelPlanRequest, b);
  if (!canTransitionPlan(p.status, "CANCELLED"))
    fail(409, "invalid_transition", { from: p.status, to: "CANCELLED" });
  Object.assign(p, { status: "CANCELLED" as TreatmentPlanStatus, cancelReason: body.reason });
  for (const i of p.items) cancelOpenSessions(i.id);
  commit(p, body.reason);
  return p;
});
on("POST", "/plans/:id/items", async ([id], _q, b) => {
  const p = plan(id);
  assertPlanOpen(p);
  const body = parse(addPlanItemRequest, b);
  p.items.push(await newItem(p, body));
  commit(p, "Item added");
  return p;
});
on("POST", "/plans/:id/items/reorder", ([id], _q, b) => {
  const p = plan(id);
  assertPlanOpen(p);
  const body = b as { items?: { itemId: string; phase?: number }[]; reason?: string };
  const list = body?.items ?? [];
  if (list.length !== p.items.length || !p.items.every((i) => list.some((x) => x.itemId === i.id)))
    fail(409, "reorder_mismatch");
  const counters = new Map<number, number>();
  for (const x of list) {
    const item = p.items.find((i) => i.id === x.itemId) as PlanItemDetail;
    if (x.phase !== undefined) item.phase = x.phase;
    const nextSeq = (counters.get(item.phase) ?? 0) + 1;
    counters.set(item.phase, nextSeq);
    item.sequence = nextSeq;
  }
  commit(p, body.reason || "Items reordered");
  return p;
});
on("GET", "/plans/:id/versions", ([id]) => ({
  items: db.versions.filter((v) => v.planId === plan(id).id).sort((a, b) => b.version - a.version),
}));
on("GET", "/plans/:id/versions/:a/diff/:b", ([id, a, bv]) => {
  const p = plan(id);
  const va = db.versions.find((v) => v.planId === p.id && v.version === Number(a));
  const vb = db.versions.find((v) => v.planId === p.id && v.version === Number(bv));
  if (!va || !vb) return fail(404, "plan_version_not_found");
  return {
    fromVersion: va.version,
    toVersion: vb.version,
    ...diffPlanSnapshots(va.snapshot, vb.snapshot),
  };
});
on("GET", "/plans/:id/versions/:v", ([id, v]) => {
  const p = plan(id);
  const found = db.versions.find((x) => x.planId === p.id && x.version === Number(v));
  return found ?? fail(404, "plan_version_not_found", { version: Number(v) });
});
on("GET", "/plans/:id/consents", ([id]) => {
  const ids = new Set(db.versions.filter((v) => v.planId === plan(id).id).map((v) => v.id));
  return {
    items: db.consents
      .filter((c) => c.planVersionId && ids.has(c.planVersionId))
      .sort((a, b) => (b.grantedAt ?? "").localeCompare(a.grantedAt ?? "")),
  };
});

// Items & sessions ----------------------------------------------------------------------------
on("PATCH", "/plan-items/:id", async ([id], _q, b) => {
  const { plan: p, item } = itemOf(id);
  assertPlanOpen(p);
  if (!EDITABLE_ITEM_STATUSES.includes(item.status))
    fail(409, "item_not_editable", { status: item.status });
  const body = parse(updatePlanItemRequest, b);
  // Mirrors PlansService.updateItem: every key received is applied (even if equal) and any applied
  // key commits a new version; `phase` keeps the old sequence (only reorder renumbers).
  let changed = false;
  if (body.phase !== undefined) {
    item.phase = body.phase;
    changed = true;
  }
  if (body.sequence !== undefined) {
    item.sequence = body.sequence;
    changed = true;
  }
  if (body.toothCode !== undefined || body.surfaces !== undefined) {
    if (body.toothCode !== undefined) item.toothCode = body.toothCode;
    item.surfaces = body.surfaces ?? (body.toothCode !== undefined ? [] : item.surfaces);
    changed = true;
  }
  if (body.quantity !== undefined) {
    item.quantity = body.quantity;
    changed = true;
  }
  if (body.notes !== undefined) {
    item.notes = body.notes || null;
    changed = true;
  }
  if (body.reprice) {
    Object.assign(item, await freezePrice(p.branchId, item.serviceId));
    changed = true;
  }
  if (changed) commit(p, body.reason || (body.reprice ? "Item re-priced" : "Item updated"));
  return p;
});
on("DELETE", "/plan-items/:id", ([id]) => {
  const { plan: p, item } = itemOf(id);
  if (p.status !== "DRAFT" || p.currentVersion > 0) fail(409, "plan_item_history");
  p.items = p.items.filter((i) => i !== item);
  refresh(p);
  return p;
});
on("POST", "/plan-items/:id/status", async ([id], _q, b) => {
  const { plan: p, item } = itemOf(id);
  const body = parse(planItemTransitionRequest, b);
  assertPlanOpen(p);
  assertPresented(p);
  if (!isStatusEndpointTransition(item.status, body.to))
    fail(409, "invalid_transition", {
      from: item.status,
      to: body.to,
      allowed: allowedPlanItemTransitions(item.status).filter((s) =>
        isStatusEndpointTransition(item.status, s),
      ),
    });
  if (item.status === "SCHEDULED" && body.to === "ACCEPTED" && liveBooking(item.id))
    fail(409, "item_still_scheduled", { itemId: item.id });
  if (body.to === "COMPLETED" && liveBooking(item.id))
    fail(409, "item_has_scheduled_sessions", {
      itemId: item.id,
      scheduledSessions: db.sessions.filter(
        (s) => s.planItemId === item.id && s.status === "SCHEDULED",
      ).length,
    });
  if (body.to === "PROPOSED")
    Object.assign(item, await freezePrice(p.branchId, item.serviceId), {
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
    });
  if (body.to === "CANCELLED")
    Object.assign(item, { decidedAt: now(), decidedBy: ME, decisionReason: body.reason || null });
  item.status = body.to;
  if (body.to === "CANCELLED" || body.to === "COMPLETED") cancelOpenSessions(item.id);
  commit(p, body.reason || `Item ${body.to.toLowerCase()}`);
  return p;
});
on("GET", "/plan-items/:id/sessions", ([id]) => ({
  items: db.sessions
    .filter((s) => s.planItemId === itemOf(id).item.id)
    .sort((a, b) => a.sessionNo - b.sessionNo),
}));
on("POST", "/plan-items/:id/sessions", ([id], _q, b) => {
  const { plan: p, item } = itemOf(id);
  const body = parse(createPlanItemSessionRequest, b);
  if (body.status !== "PLANNED") fail(400, "session_status_server_derived");
  assertPlanOpen(p);
  if (!SCHEDULABLE_ITEM_STATUSES.includes(item.status))
    fail(409, "item_not_schedulable", { status: item.status });
  if (body.encounterId && encounter(body.encounterId).patientId !== p.patientId)
    fail(409, "link_patient_mismatch", { field: "encounterId" });
  const mine = db.sessions.filter((s) => s.planItemId === item.id);
  const sessionNo = body.sessionNo ?? mine.reduce((m, s) => Math.max(m, s.sessionNo), 0) + 1;
  if (mine.some((s) => s.sessionNo === sessionNo)) fail(409, "session_no_taken", { sessionNo });
  const s: PlanItemSessionResponse = {
    id: newId("29"),
    planItemId: item.id,
    sessionNo,
    appointmentId: null,
    encounterId: body.encounterId ?? null,
    status: "PLANNED",
    notes: body.notes ?? null,
    createdBy: ME,
    createdAt: now(),
    updatedAt: now(),
  };
  db.sessions.push(s);
  return s;
});
const sessionOf = (id: string | undefined) => {
  const s = db.sessions.find((x) => x.id === id);
  if (!s) return fail(404, "session_not_found");
  return { session: s, ...itemOf(s.planItemId) };
};
on("PATCH", "/plan-item-sessions/:id", ([id], _q, b) => {
  const { session, plan: p } = sessionOf(id);
  const body = parse(updatePlanItemSessionRequest, b);
  if (body.status !== undefined && body.status !== "CANCELLED")
    fail(400, "session_status_server_derived");
  const closed = session.status === "COMPLETED" || session.status === "CANCELLED";
  if (closed && (body.status || body.encounterId !== undefined))
    fail(409, "session_closed", { status: session.status });
  if (body.status) assertPlanOpen(p);
  if (body.status === "CANCELLED") session.status = "CANCELLED";
  if (body.encounterId !== undefined) session.encounterId = body.encounterId;
  if (body.notes !== undefined) session.notes = body.notes || null;
  session.updatedAt = now();
  return session;
});
on("POST", "/plan-item-sessions/:id/complete", ([id]) => {
  const { session, plan: p, item } = sessionOf(id);
  assertPlanOpen(p);
  if (session.status !== "PLANNED" && session.status !== "SCHEDULED")
    fail(409, "invalid_transition", { from: session.status, to: "COMPLETED", allowed: [] });
  if (!SCHEDULABLE_ITEM_STATUSES.includes(item.status))
    fail(409, "item_not_schedulable", { status: item.status });
  session.status = "COMPLETED";
  session.updatedAt = now();
  syncItem(p, item, "COMPLETED");
  return session;
});

// Consent -------------------------------------------------------------------------------------
on("GET", "/consent-templates", (_m, q) => ({
  items: db.templates.filter(
    (t) =>
      (!q.type || t.type === q.type) && (q.active === undefined || String(t.active) === q.active),
  ),
}));
on("GET", "/consent-templates/:id", ([id]) => {
  const t = db.templates.find((x) => x.id === id);
  return t ?? fail(404, "template_not_found");
});
on("GET", "/consent-templates/:id/versions", ([id]) => ({
  items: db.templateVersions
    .filter((v) => v.templateId === id)
    .sort((a, b) => b.version - a.version),
}));
on("POST", "/patients/:id/consents/sign", async ([id], _q, b) => {
  await activePatient(id ?? "");
  const body = parse(signConsentRequest, b);
  const tv = db.templateVersions.find((v) => v.id === body.templateVersionId);
  if (!tv) return fail(404, "template_version_not_found");
  const t = db.templates.find((x) => x.id === tv.templateId);
  if (!t) return fail(404, "template_version_not_found");
  if (!t.active) fail(409, "template_inactive", { templateId: t.id });
  if (tv.version !== t.currentVersion)
    fail(409, "template_version_outdated", { currentVersion: t.currentVersion });
  let planVersionId: string | null = null;
  if (t.type === "TREATMENT_PLAN") {
    if (!body.planVersionId)
      fail(400, "validation_failed", {
        issues: [{ path: "planVersionId", message: "Required for a TREATMENT_PLAN consent" }],
      });
    const pv = db.versions.find((v) => v.id === body.planVersionId);
    if (!pv) return fail(404, "plan_version_not_found");
    const p = plan(pv.planId);
    if (p.status === "CANCELLED" || p.status === "DRAFT")
      fail(409, "plan_closed", { status: p.status });
    if (pv.version !== p.currentVersion)
      fail(409, "plan_version_not_current", { currentVersion: p.currentVersion });
    planVersionId = pv.id;
  }
  const doc = await documentOf(body.signatureDocumentId);
  if (doc.patientId !== id) fail(404, "document_not_found");
  if (doc.status !== "AVAILABLE" || doc.category !== "CONSENT_FORM")
    fail(409, "invalid_signature_document", {
      reason: doc.status !== "AVAILABLE" ? "not_uploaded" : "not_consent_form",
    });
  const consent = {
    id: newId("2c"),
    patientId: id ?? "",
    type: t.type,
    version: String(tv.version),
    status: "GRANTED" as const,
    method: body.method,
    branchId: body.branchId,
    documentId: doc.id,
    capturedBy: ME,
    grantedAt: now(),
    withdrawnAt: null,
    templateVersionId: tv.id,
    planVersionId,
    signerName: body.signerName ?? null,
    signerRelationship: body.signerRelationship,
  };
  db.consents.push(consent);
  const { patientId: _p, ...res } = consent;
  return res;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const clinicalMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) {
      await sleep(LATENCY_MS);
      return structuredClone(await h(match.slice(1).map(decodeURIComponent), query, body));
    }
  }
  return m1(method, fullPath, query, body);
};
