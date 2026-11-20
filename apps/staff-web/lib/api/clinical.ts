import {
  type AmendmentResponse,
  type ChartTeethRequest,
  type ClinicalContextResponse,
  type CreateAmendmentRequest,
  type CreateDiagnosisRequest,
  type CreateNoteRequest,
  type CreateProcedureRequest,
  type DiagnosisResponse,
  type DocumentResponse,
  type EncounterDetailResponse,
  type EncounterResponse,
  type NoteResponse,
  type OdontogramResponse,
  type OpenEncounterRequest,
  type ProcedureResponse,
  type SupersedeToothRecordsRequest,
  type ToothRecordResponse,
  type UpdateDiagnosisRequest,
  type UpdateEncounterRequest,
  type UpdateNoteRequest,
  type UpdateProcedureRequest,
  clinicalContextResponse,
  encounterDetailResponse,
  odontogramResponse,
  type z,
} from "@dentalos/validation";
import type { ApiClient } from "./client";
import { clinicalClient } from "./clinical-client";
import { clinicalRoutes as r } from "./clinical-routes";
import type { Items, Page } from "./types";

export interface EncounterListQuery {
  patientId?: string;
  branchId?: string;
  status?: "OPEN" | "SIGNED";
  treatingDentistUserId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** Typed clinical surface (encounters, notes, diagnoses, procedures, attachments, odontogram). */
export function createClinicalApi(c: ApiClient) {
  const get = <T>(path: string, query?: object, schema?: z.ZodType<T>) =>
    c.request<T>("GET", path, { query: query as Record<string, string>, schema });
  const send = <T>(method: "POST" | "PATCH", path: string, body?: unknown) =>
    c.request<T>(method, path, { body: body ?? {} });
  const del = (path: string) => c.request<void>("DELETE", path);

  return {
    context: (patientId: string, branchId?: string) =>
      get<ClinicalContextResponse>(
        r.clinicalContext(patientId),
        { branchId },
        clinicalContextResponse,
      ),
    encounters: {
      list: (q: EncounterListQuery) => get<Page<EncounterResponse>>(r.encounters(), q),
      open: (b: OpenEncounterRequest) => send<EncounterResponse>("POST", r.encounters(), b),
      get: (id: string) =>
        get<EncounterDetailResponse>(r.encounter(id), undefined, encounterDetailResponse),
      update: (id: string, b: UpdateEncounterRequest) =>
        send<EncounterResponse>("PATCH", r.encounter(id), b),
      sign: (id: string) => send<EncounterResponse>("POST", r.encounterSign(id), { attest: true }),

      addNote: (id: string, b: CreateNoteRequest) =>
        send<NoteResponse>("POST", r.encounterNotes(id), b),
      updateNote: (id: string, noteId: string, b: UpdateNoteRequest) =>
        send<NoteResponse>("PATCH", r.encounterNote(id, noteId), b),
      deleteNote: (id: string, noteId: string) => del(r.encounterNote(id, noteId)),
      amendments: (id: string) => get<Items<AmendmentResponse>>(r.encounterAmendments(id)),
      addAmendment: (id: string, b: CreateAmendmentRequest) =>
        send<AmendmentResponse>("POST", r.encounterAmendments(id), b),

      addDiagnosis: (id: string, b: CreateDiagnosisRequest) =>
        send<DiagnosisResponse>("POST", r.encounterDiagnoses(id), b),
      updateDiagnosis: (id: string, diagnosisId: string, b: UpdateDiagnosisRequest) =>
        send<DiagnosisResponse>("PATCH", r.encounterDiagnosis(id, diagnosisId), b),
      deleteDiagnosis: (id: string, diagnosisId: string) =>
        del(r.encounterDiagnosis(id, diagnosisId)),

      addProcedure: (id: string, b: CreateProcedureRequest) =>
        send<ProcedureResponse>("POST", r.encounterProcedures(id), b),
      updateProcedure: (id: string, procedureId: string, b: UpdateProcedureRequest) =>
        send<ProcedureResponse>("PATCH", r.encounterProcedure(id, procedureId), b),
      deleteProcedure: (id: string, procedureId: string) =>
        del(r.encounterProcedure(id, procedureId)),

      documents: (id: string) => get<Items<DocumentResponse>>(r.encounterDocuments(id)),
      attachDocument: (id: string, documentId: string) =>
        send<DocumentResponse>("POST", r.encounterDocuments(id), { documentId }),
      detachDocument: (id: string, documentId: string) => del(r.encounterDocument(id, documentId)),
    },
    odontogram: {
      get: (patientId: string, q: { includeHistory?: boolean; asOf?: string } = {}) =>
        get<OdontogramResponse>(r.odontogram(patientId), q, odontogramResponse),
      chart: (patientId: string, b: ChartTeethRequest) =>
        send<Items<ToothRecordResponse>>("POST", r.odontogram(patientId), b),
      supersede: (patientId: string, b: SupersedeToothRecordsRequest) =>
        send<Items<ToothRecordResponse>>("POST", r.odontogramSupersede(patientId), b),
    },
  };
}

export type ClinicalApi = ReturnType<typeof createClinicalApi>;
export const clinicalApi: ClinicalApi = createClinicalApi(clinicalClient);
