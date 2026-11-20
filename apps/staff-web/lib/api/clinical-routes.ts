import { API_PREFIX } from "./routes";

/**
 * M2 clinical + treatment-plan paths, aligned with the Wave 1 controllers:
 *   apps/api/src/clinical/{encounters,patient-clinical}.controller.ts
 *   apps/api/src/plans/{plans,consent}.controller.ts
 * Kept separate from the frozen `routes.ts` until Wave 3 merges the tables (see the U2 report);
 * `clinical-routes.test.ts` checks every builder against the controller decorators.
 */
const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const clinicalRoutes = {
  // ---- Encounters (clinical:read / clinical:write / clinical:sign / clinical:amend) ---------
  /** GET listEncountersQuery → page(encounter), POST openEncounterRequest */
  encounters: () => p("/encounters"),
  /** GET encounterDetailResponse, PATCH updateEncounterRequest (hand-over) */
  encounter: (encounterId: string) => p(`/encounters/${id(encounterId)}`),
  /** POST { attest: true } — treating dentist only; final */
  encounterSign: (encounterId: string) => p(`/encounters/${id(encounterId)}/sign`),
  /** POST createNoteRequest */
  encounterNotes: (encounterId: string) => p(`/encounters/${id(encounterId)}/notes`),
  /** PATCH updateNoteRequest (author), DELETE (author or treating dentist) — OPEN only */
  encounterNote: (encounterId: string, noteId: string) =>
    p(`/encounters/${id(encounterId)}/notes/${id(noteId)}`),
  /** GET → { items }, POST createAmendmentRequest — SIGNED only */
  encounterAmendments: (encounterId: string) => p(`/encounters/${id(encounterId)}/amendments`),
  /** POST createDiagnosisRequest */
  encounterDiagnoses: (encounterId: string) => p(`/encounters/${id(encounterId)}/diagnoses`),
  /** PATCH updateDiagnosisRequest, DELETE */
  encounterDiagnosis: (encounterId: string, diagnosisId: string) =>
    p(`/encounters/${id(encounterId)}/diagnoses/${id(diagnosisId)}`),
  /** POST createProcedureRequest */
  encounterProcedures: (encounterId: string) => p(`/encounters/${id(encounterId)}/procedures`),
  /** PATCH updateProcedureRequest (status IN_PROGRESS → COMPLETED | ABANDONED), DELETE */
  encounterProcedure: (encounterId: string, procedureId: string) =>
    p(`/encounters/${id(encounterId)}/procedures/${id(procedureId)}`),
  /** GET → { items: document[] }, POST { documentId } (same patient, OPEN encounter) */
  encounterDocuments: (encounterId: string) => p(`/encounters/${id(encounterId)}/documents`),
  /** DELETE (detach; OPEN only) */
  encounterDocument: (encounterId: string, documentId: string) =>
    p(`/encounters/${id(encounterId)}/documents/${id(documentId)}`),

  // ---- Patient clinical -------------------------------------------------------------------
  /** GET ?includeHistory&asOf → odontogramResponse, POST chartTeethRequest → { items } */
  odontogram: (patientId: string) => p(`/patients/${id(patientId)}/odontogram`),
  /** POST supersedeToothRecordsRequest → { items } */
  odontogramSupersede: (patientId: string) => p(`/patients/${id(patientId)}/odontogram/supersede`),
  /** GET ?branchId → clinicalContextResponse */
  clinicalContext: (patientId: string) => p(`/patients/${id(patientId)}/clinical-context`),
} as const;

export const planRoutes = {
  // ---- Plans (plan:read / plan:write / plan:approve) ---------------------------------------
  /** GET listPlansQuery → page(treatmentPlanSummary), POST createPlanRequest */
  plans: () => p("/plans"),
  /** GET treatmentPlanResponse (+ phaseTotals, items[].lineTotalPaise), PATCH updatePlanRequest */
  plan: (planId: string) => p(`/plans/${id(planId)}`),
  /** POST presentPlanRequest */
  planPresent: (planId: string) => p(`/plans/${id(planId)}/present`),
  /** POST decidePlanItemsRequest (per-item accept / reject / defer) */
  planDecisions: (planId: string) => p(`/plans/${id(planId)}/decisions`),
  /** POST approvePlanRequest (409 consent_required) */
  planApprove: (planId: string) => p(`/plans/${id(planId)}/approve`),
  /** POST cancelPlanRequest */
  planCancel: (planId: string) => p(`/plans/${id(planId)}/cancel`),
  /** POST addPlanItemRequest (estimate frozen by the server) */
  planItems: (planId: string) => p(`/plans/${id(planId)}/items`),
  /** POST { items: [{ itemId, phase? }], reason? } — every item once */
  planItemsReorder: (planId: string) => p(`/plans/${id(planId)}/items/reorder`),
  /** GET → { items: planVersionResponse[] } */
  planVersions: (planId: string) => p(`/plans/${id(planId)}/versions`),
  /** GET planVersionResponse */
  planVersion: (planId: string, version: number) => p(`/plans/${id(planId)}/versions/${version}`),
  /** GET planDiff + { fromVersion, toVersion } */
  planDiff: (planId: string, a: number, b: number) =>
    p(`/plans/${id(planId)}/versions/${a}/diff/${b}`),
  /** GET → { items: signedConsentResponse[] } (consent:manage) */
  planConsents: (planId: string) => p(`/plans/${id(planId)}/consents`),

  // ---- Items & sessions --------------------------------------------------------------------
  /** PATCH updatePlanItemRequest, DELETE (never-presented DRAFT only) */
  planItem: (itemId: string) => p(`/plan-items/${id(itemId)}`),
  /** POST planItemTransitionRequest (clinician moves) */
  planItemStatus: (itemId: string) => p(`/plan-items/${id(itemId)}/status`),
  /** GET → { items }, POST createPlanItemSessionRequest */
  planItemSessions: (itemId: string) => p(`/plan-items/${id(itemId)}/sessions`),
  /** PATCH updatePlanItemSessionRequest (only CANCELLED may be sent as status) */
  planItemSession: (sessionId: string) => p(`/plan-item-sessions/${id(sessionId)}`),
  /** POST */
  planItemSessionComplete: (sessionId: string) =>
    p(`/plan-item-sessions/${id(sessionId)}/complete`),

  // ---- Consent -----------------------------------------------------------------------------
  /** GET ?type&active → { items } (consent:manage) */
  consentTemplates: () => p("/consent-templates"),
  /** GET consentTemplateResponse */
  consentTemplate: (templateId: string) => p(`/consent-templates/${id(templateId)}`),
  /** GET → { items: consentTemplateVersionResponse[] } */
  consentTemplateVersions: (templateId: string) =>
    p(`/consent-templates/${id(templateId)}/versions`),
  /** POST signConsentRequest → signedConsentResponse */
  signConsent: (patientId: string) => p(`/patients/${id(patientId)}/consents/sign`),
} as const;
