import { z } from "zod";
import { isoDateTime, optionalText, pageQuery, staffUserId, trimmed, uuid } from "./common";
import { documentResponse } from "./documents";
import { dentition, toothCode, toothSurface, toothSurfaces, toothSurfacesRefinement } from "./fdi";
import { alertResponse, allergyResponse, medicalHistoryResponse, patientSummary } from "./patients";

// Clinical records & odontogram (PRD 3.4, 4.4, 7.5). Sign-off / amendment rules:
// docs/adr/0003-clinical-domain-rules.md (PROPOSED — needs product sign-off). The DB enforces
// immutability of signed encounters (triggers in migration 0006); the API must also check first.

export const ENCOUNTER_STATUSES = ["OPEN", "SIGNED"] as const;
export const CLINICAL_NOTE_KINDS = [
  "SUBJECTIVE",
  "OBJECTIVE",
  "ASSESSMENT",
  "PLAN",
  "GENERAL",
] as const;
export const TOOTH_RECORD_STATUSES = ["CURRENT", "HISTORICAL"] as const;
export const PROCEDURE_STATUSES = ["IN_PROGRESS", "COMPLETED", "ABANDONED"] as const;
/** Initial odontogram condition catalogue (DB column is text; PRD 12.2 leaves templates open). */
export const TOOTH_CONDITIONS = [
  "SOUND",
  "CARIES",
  "FILLED",
  "CROWN",
  "VENEER",
  "SEALANT",
  "FRACTURED",
  "ROOT_CANAL_TREATED",
  "PERIAPICAL_LESION",
  "MOBILITY",
  "BRIDGE_ABUTMENT",
  "BRIDGE_PONTIC",
  "IMPLANT",
  "MISSING",
  "EXTRACTED",
  "UNERUPTED",
  "IMPACTED",
  "OTHER",
] as const;
/** Whole-tooth conditions: surfaces must be empty. */
export const TOOTH_LEVEL_CONDITIONS: readonly (typeof TOOTH_CONDITIONS)[number][] = [
  "SOUND",
  "ROOT_CANAL_TREATED",
  "PERIAPICAL_LESION",
  "MOBILITY",
  "BRIDGE_ABUTMENT",
  "BRIDGE_PONTIC",
  "IMPLANT",
  "MISSING",
  "EXTRACTED",
  "UNERUPTED",
  "IMPACTED",
];

export const encounterStatus = z.enum(ENCOUNTER_STATUSES);
export const clinicalNoteKind = z.enum(CLINICAL_NOTE_KINDS);
export const toothRecordStatus = z.enum(TOOTH_RECORD_STATUSES);
export const procedureStatus = z.enum(PROCEDURE_STATUSES);
export const toothCondition = z.enum(TOOTH_CONDITIONS);

const noteBody = z.string().trim().min(1).max(20_000);

// ---------------------------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------------------------

/**
 * Open from an appointment (patient/branch must match it; the appointment usually moves to
 * IN_CHAIR) or as a walk-in. `treatingDentistUserId` defaults to the caller.
 */
export const openEncounterRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  appointmentId: uuid.optional(),
  treatingDentistUserId: staffUserId.optional(),
});
export type OpenEncounterRequest = z.infer<typeof openEncounterRequest>;

/** PATCH while OPEN (hand-over to another dentist). */
export const updateEncounterRequest = z.object({
  treatingDentistUserId: staffUserId.optional(),
});
export type UpdateEncounterRequest = z.infer<typeof updateEncounterRequest>;

export const listEncountersQuery = pageQuery.extend({
  patientId: uuid.optional(),
  branchId: uuid.optional(),
  status: encounterStatus.optional(),
  treatingDentistUserId: staffUserId.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});
export type ListEncountersQuery = z.infer<typeof listEncountersQuery>;

/** Signing is final (never reopened). Only the treating dentist, with clinical:sign. */
export const signEncounterRequest = z.object({
  /** Explicit attestation that the record is complete and accurate. */
  attest: z.literal(true),
});
export type SignEncounterRequest = z.infer<typeof signEncounterRequest>;

export const encounterResponse = z.object({
  id: uuid,
  patientId: uuid,
  branchId: uuid,
  appointmentId: uuid.nullable(),
  treatingDentistUserId: z.string(),
  status: encounterStatus,
  openedBy: z.string(),
  openedAt: isoDateTime,
  signedAt: isoDateTime.nullable(),
  signedBy: z.string().nullable(),
});
export type EncounterResponse = z.infer<typeof encounterResponse>;

// ---------------------------------------------------------------------------------------------
// Notes & amendments
// ---------------------------------------------------------------------------------------------

export const createNoteRequest = z.object({
  kind: clinicalNoteKind.default("GENERAL"),
  body: noteBody,
});
export type CreateNoteRequest = z.infer<typeof createNoteRequest>;

/** PATCH (OPEN encounters only — signed notes are amended, not edited). */
export const updateNoteRequest = z.object({
  kind: clinicalNoteKind.optional(),
  body: noteBody.optional(),
});
export type UpdateNoteRequest = z.infer<typeof updateNoteRequest>;

/** Correction of a SIGNED encounter (clinical:amend). `noteId` omitted = whole-encounter amendment. */
export const createAmendmentRequest = z.object({
  noteId: uuid.optional(),
  body: noteBody,
  reason: trimmed(500).min(3),
});
export type CreateAmendmentRequest = z.infer<typeof createAmendmentRequest>;

export const amendmentResponse = z.object({
  id: uuid,
  encounterId: uuid,
  noteId: uuid.nullable(),
  body: z.string(),
  reason: z.string(),
  authorId: z.string(),
  createdAt: isoDateTime,
});
export type AmendmentResponse = z.infer<typeof amendmentResponse>;

export const noteResponse = z.object({
  id: uuid,
  encounterId: uuid,
  kind: clinicalNoteKind,
  body: z.string(),
  authorId: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  amendments: z.array(amendmentResponse).optional(),
});
export type NoteResponse = z.infer<typeof noteResponse>;

// ---------------------------------------------------------------------------------------------
// Odontogram (tooth records: insert new + supersede old; never edited or deleted)
// ---------------------------------------------------------------------------------------------

export const toothRecordInput = z
  .object({
    toothCode,
    condition: toothCondition,
    /** Empty = whole-tooth condition. */
    surfaces: toothSurfaces.default([]),
    notes: optionalText(1000),
    /** CURRENT record this one replaces (marked HISTORICAL in the same transaction). */
    supersedesId: uuid.optional(),
  })
  .superRefine(toothSurfacesRefinement("create"))
  .refine((v) => !(TOOTH_LEVEL_CONDITIONS.includes(v.condition) && v.surfaces.length > 0), {
    message: "This condition applies to the whole tooth (no surfaces)",
    path: ["surfaces"],
  });
export type ToothRecordInput = z.infer<typeof toothRecordInput>;

/** POST /patients/:id/odontogram — batch charting, optionally within an OPEN encounter. */
export const chartTeethRequest = z.object({
  encounterId: uuid.optional(),
  records: z.array(toothRecordInput).min(1).max(64),
});
export type ChartTeethRequest = z.infer<typeof chartTeethRequest>;

/** Retire CURRENT records without a replacement (e.g. charted in error). */
export const supersedeToothRecordsRequest = z.object({
  recordIds: z.array(uuid).min(1).max(64),
  encounterId: uuid.optional(),
  reason: optionalText(500),
});
export type SupersedeToothRecordsRequest = z.infer<typeof supersedeToothRecordsRequest>;

export const odontogramQuery = z.object({
  /** Include HISTORICAL rows (full charting history). */
  includeHistory: z.stringbool().default(false),
  /** Chart as it stood at this instant (recordedAt <= asOf and not superseded by then). */
  asOf: isoDateTime.optional(),
});
export type OdontogramQuery = z.infer<typeof odontogramQuery>;

export const toothRecordResponse = z.object({
  id: uuid,
  patientId: uuid,
  encounterId: uuid.nullable(),
  toothCode: z.number().int(),
  dentition,
  condition: z.string(),
  surfaces: z.array(toothSurface),
  notes: z.string().nullable(),
  status: toothRecordStatus,
  recordedBy: z.string(),
  recordedAt: isoDateTime,
  supersededAt: isoDateTime.nullable(),
  supersededBy: z.string().nullable(),
});
export type ToothRecordResponse = z.infer<typeof toothRecordResponse>;

/** Snapshot = every CURRENT record (plus history when asked); the UI groups by toothCode. */
export const odontogramResponse = z.object({
  /** Includes records of merged-in patients (lineage). */
  patientId: uuid,
  asOf: isoDateTime,
  records: z.array(toothRecordResponse),
});
export type OdontogramResponse = z.infer<typeof odontogramResponse>;

// ---------------------------------------------------------------------------------------------
// Diagnoses & procedures (belong to an encounter; immutable once it is signed)
// ---------------------------------------------------------------------------------------------

export const createDiagnosisRequest = z
  .object({
    /** ICD-10 (e.g. "K02.1") or an internal code — coding system open (PRD 12.2). */
    code: trimmed(32),
    label: trimmed(200),
    toothCode: toothCode.optional(),
    surfaces: toothSurfaces.default([]),
    notes: optionalText(2000),
  })
  .superRefine(toothSurfacesRefinement("create"));
export type CreateDiagnosisRequest = z.infer<typeof createDiagnosisRequest>;

export const updateDiagnosisRequest = z
  .object({
    code: trimmed(32).optional(),
    label: trimmed(200).optional(),
    toothCode: toothCode.nullable().optional(),
    surfaces: toothSurfaces.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine(toothSurfacesRefinement("patch"));
export type UpdateDiagnosisRequest = z.infer<typeof updateDiagnosisRequest>;

export const diagnosisResponse = z.object({
  id: uuid,
  encounterId: uuid,
  patientId: uuid,
  code: z.string(),
  label: z.string(),
  toothCode: z.number().int().nullable(),
  surfaces: z.array(toothSurface),
  notes: z.string().nullable(),
  diagnosedBy: z.string(),
  createdAt: isoDateTime,
});
export type DiagnosisResponse = z.infer<typeof diagnosisResponse>;

export const createProcedureRequest = z
  .object({
    serviceId: uuid.optional(),
    planItemId: uuid.optional(),
    description: optionalText(500),
    toothCode: toothCode.optional(),
    surfaces: toothSurfaces.default([]),
    status: procedureStatus.default("COMPLETED"),
    /** Defaults to now. */
    performedAt: isoDateTime.optional(),
    notes: optionalText(2000),
  })
  .superRefine(toothSurfacesRefinement("create"))
  .refine((v) => v.serviceId !== undefined || (v.description ?? "").length > 0, {
    message: "serviceId or description required",
    path: ["serviceId"],
  });
export type CreateProcedureRequest = z.infer<typeof createProcedureRequest>;

export const updateProcedureRequest = z
  .object({
    status: procedureStatus.optional(),
    description: z.string().trim().max(500).nullable().optional(),
    toothCode: toothCode.nullable().optional(),
    surfaces: toothSurfaces.optional(),
    performedAt: isoDateTime.optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine(toothSurfacesRefinement("patch"));
export type UpdateProcedureRequest = z.infer<typeof updateProcedureRequest>;

export const procedureResponse = z.object({
  id: uuid,
  encounterId: uuid,
  patientId: uuid,
  serviceId: uuid.nullable(),
  planItemId: uuid.nullable(),
  description: z.string().nullable(),
  toothCode: z.number().int().nullable(),
  surfaces: z.array(toothSurface),
  status: procedureStatus,
  notes: z.string().nullable(),
  performedBy: z.string(),
  performedAt: isoDateTime,
});
export type ProcedureResponse = z.infer<typeof procedureResponse>;

// ---------------------------------------------------------------------------------------------
// Encounter detail, attachments, clinical context
// ---------------------------------------------------------------------------------------------

export const encounterDetailResponse = encounterResponse.extend({
  notes: z.array(noteResponse),
  /** Whole-encounter amendments (noteId null); note amendments are nested in `notes`. */
  amendments: z.array(amendmentResponse),
  diagnoses: z.array(diagnosisResponse),
  procedures: z.array(procedureResponse),
  toothRecords: z.array(toothRecordResponse),
});
export type EncounterDetailResponse = z.infer<typeof encounterDetailResponse>;

/** POST /encounters/:id/documents — link an AVAILABLE document of the same patient (sets encounterId). */
export const attachEncounterDocumentRequest = z.object({ documentId: uuid });
export type AttachEncounterDocumentRequest = z.infer<typeof attachEncounterDocumentRequest>;
export const encounterDocumentsResponse = z.object({ items: z.array(documentResponse) });

/** GET /patients/:id/clinical-context — the clinical workspace header (PRD 3.4). Audited read. */
export const clinicalContextResponse = z.object({
  patient: patientSummary,
  alerts: z.array(alertResponse),
  allergies: z.array(allergyResponse),
  latestMedicalHistory: medicalHistoryResponse.nullable(),
  openEncounters: z.array(encounterResponse),
  recentEncounters: z.array(encounterResponse),
  /** Non-terminal plans (ids/titles/status only; details via plans endpoints). */
  activePlans: z.array(z.object({ id: uuid, title: z.string(), status: z.string() })),
  odontogram: z.array(toothRecordResponse),
});
export type ClinicalContextResponse = z.infer<typeof clinicalContextResponse>;
