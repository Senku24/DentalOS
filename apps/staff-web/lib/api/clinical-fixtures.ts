import {
  type AmendmentResponse,
  type ConsentTemplateResponse,
  type ConsentTemplateVersionResponse,
  type DiagnosisResponse,
  type EncounterResponse,
  type NoteResponse,
  type PlanItemSessionResponse,
  type PlanSnapshot,
  type PlanVersionResponse,
  type ProcedureResponse,
  type SignedConsentResponse,
  type ToothRecordResponse,
  dentitionOf,
  planTotals,
} from "@dentalos/validation";
import type { PlanDetail, PlanItemDetail } from "./clinical-types";
import { fid, services } from "./fixtures";

/**
 * Synthetic M2 clinical data for mock mode, layered on the M1 fixtures (same patients, branches,
 * services and staff directory). Two patients have clinical history:
 *  - Rahul Sharma (patient 41, Saket): two signed encounters (one amended), an OPEN encounter
 *    treated by the dev user (so the dev DENTIST can sign it), a charted odontogram with history,
 *    a partially accepted plan (3 versions, sessions, no consent yet → approval answers 409
 *    consent_required) and a draft plan.
 *  - Patient 3 (Saket): an OPEN encounter treated by Dr. Vikram Malhotra (dev user cannot sign).
 * No real people or clinical cases.
 */

export const B1 = fid("0b", 1);
export const P41 = fid("01", 41);
export const P3 = fid("01", 3);
export const ME = "dev-user";

const at = (daysAgo: number, hour = 10, minute = 30) =>
  new Date(Date.UTC(2026, 10, 19, hour - 5, minute - 30) - daysAgo * 86_400_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const svc = (n: number) => {
  const s = services[n - 1];
  if (!s) throw new Error(`fixture service ${n} missing`);
  return s;
};

// ---- Encounters ------------------------------------------------------------------------------

export const E1 = fid("20", 1);
export const E2 = fid("20", 2);
export const E3 = fid("20", 3);
export const E4 = fid("20", 4);

const enc = (
  id: string,
  patientId: string,
  treating: string,
  openedAt: string,
  signedAt: string | null,
): EncounterResponse => ({
  id,
  patientId,
  branchId: B1,
  appointmentId: null,
  treatingDentistUserId: treating,
  status: signedAt ? "SIGNED" : "OPEN",
  openedBy: treating,
  openedAt,
  signedAt,
  signedBy: signedAt ? treating : null,
});

export const encounters: EncounterResponse[] = [
  enc(E1, P41, "usr-dent-1", at(40, 10), at(40, 11, 45)),
  enc(E2, P41, "usr-dent-1", at(12, 17), at(12, 18, 20)),
  enc(E3, P41, ME, minutesAgo(25), null),
  enc(E4, P3, "usr-owner-1", minutesAgo(50), null),
];

let n = 0;
const note = (
  encounterId: string,
  kind: NoteResponse["kind"],
  body: string,
  authorId: string,
  createdAt: string,
): NoteResponse => ({
  id: fid("21", ++n),
  encounterId,
  kind,
  body,
  authorId,
  createdAt,
  updatedAt: createdAt,
});

export const notes: NoteResponse[] = [
  note(
    E1,
    "SUBJECTIVE",
    "Pain on chewing on the lower left for two weeks; sensitive to cold. Occasional dull ache lower right at night.",
    "usr-dent-1",
    at(40, 10, 5),
  ),
  note(
    E1,
    "OBJECTIVE",
    "Deep caries 36 mesio-occlusal. 46 tender on percussion. IOPA 46: periapical radiolucency on the mesial root. 26 occlusal caries (enamel/dentine).",
    "usr-dent-1",
    at(40, 10, 20),
  ),
  note(
    E1,
    "ASSESSMENT",
    "36 dentinal caries (restorable). 46 chronic apical periodontitis. 26 occlusal caries.",
    "usr-dent-1",
    at(40, 10, 40),
  ),
  note(
    E1,
    "PLAN",
    "Composite 36 MO today. RCT 46 in two visits, then zirconia crown. 26 composite. Oral hygiene instructions given.",
    "usr-dent-1",
    at(40, 10, 50),
  ),
  note(
    E2,
    "GENERAL",
    "RCT 46 visit 1: LA given, access opening, working length 21 mm (MB, ML, D), cleaning and shaping, calcium hydroxide dressing, temporary seal. Tolerated well.",
    "usr-dent-1",
    at(12, 17, 40),
  ),
  note(
    E3,
    "SUBJECTIVE",
    "Review after RCT visit 1. Mild discomfort for two days afterwards, now settled. No swelling.",
    ME,
    minutesAgo(20),
  ),
  note(
    E4,
    "OBJECTIVE",
    "Generalised supragingival calculus, bleeding on probing in all sextants. No mobility.",
    "usr-owner-1",
    minutesAgo(40),
  ),
];

export const amendments: AmendmentResponse[] = [
  {
    id: fid("22", 1),
    encounterId: E1,
    noteId: null,
    body: "Diagnosis for 46 should read symptomatic apical periodontitis; it was tender on percussion at this visit.",
    reason: "Coding correction after case review",
    authorId: "usr-dent-1",
    createdAt: at(39, 9, 15),
  },
  {
    id: fid("22", 2),
    encounterId: E1,
    noteId: fid("21", 2),
    body: "IOPA also shows a widened PDL space on 47 — monitor at review.",
    reason: "Finding missed on the radiograph at the time of the visit",
    authorId: "usr-dent-1",
    createdAt: at(39, 9, 20),
  },
];

export const diagnoses: DiagnosisResponse[] = [
  {
    id: fid("23", 1),
    encounterId: E1,
    patientId: P41,
    code: "K02.1",
    label: "Caries of dentine",
    toothCode: 36,
    surfaces: ["M", "O"],
    notes: null,
    diagnosedBy: "usr-dent-1",
    createdAt: at(40, 10, 42),
  },
  {
    id: fid("23", 2),
    encounterId: E1,
    patientId: P41,
    code: "K04.5",
    label: "Chronic apical periodontitis",
    toothCode: 46,
    surfaces: [],
    notes: "Periapical radiolucency on IOPA.",
    diagnosedBy: "usr-dent-1",
    createdAt: at(40, 10, 43),
  },
  {
    id: fid("23", 3),
    encounterId: E4,
    patientId: P3,
    code: "K05.1",
    label: "Chronic gingivitis, plaque induced",
    toothCode: null,
    surfaces: [],
    notes: null,
    diagnosedBy: "usr-owner-1",
    createdAt: minutesAgo(35),
  },
];

// Plan items referenced by procedures/sessions.
export const PL1 = fid("26", 1);
export const PL2 = fid("26", 2);
export const I1 = fid("27", 1);
export const I2 = fid("27", 2);
export const I3 = fid("27", 3);
export const I4 = fid("27", 4);
export const I5 = fid("27", 5);
export const I6 = fid("27", 6);
export const I7 = fid("27", 7);

export const procedures: ProcedureResponse[] = [
  {
    id: fid("24", 1),
    encounterId: E1,
    patientId: P41,
    serviceId: svc(2).id,
    planItemId: null,
    description: null,
    toothCode: 46,
    surfaces: [],
    status: "COMPLETED",
    notes: null,
    performedBy: "usr-dent-1",
    performedAt: at(40, 10, 25),
  },
  {
    id: fid("24", 2),
    encounterId: E1,
    patientId: P41,
    serviceId: svc(6).id,
    planItemId: null,
    description: null,
    toothCode: 36,
    surfaces: ["M", "O"],
    status: "COMPLETED",
    notes: "Composite A2, rubber dam.",
    performedBy: "usr-dent-1",
    performedAt: at(40, 11, 30),
  },
  {
    id: fid("24", 3),
    encounterId: E2,
    patientId: P41,
    serviceId: svc(9).id,
    planItemId: I1,
    description: null,
    toothCode: 46,
    surfaces: [],
    status: "IN_PROGRESS",
    notes: "Visit 1 of 2.",
    performedBy: "usr-dent-1",
    performedAt: at(12, 18),
  },
];

// ---- Odontogram ------------------------------------------------------------------------------

const tooth = (
  k: number,
  patientId: string,
  toothCode: number,
  condition: string,
  surfaces: ToothRecordResponse["surfaces"],
  recordedAt: string,
  o: Partial<ToothRecordResponse> = {},
): ToothRecordResponse => ({
  id: fid("25", k),
  patientId,
  encounterId: null,
  toothCode,
  dentition: dentitionOf(toothCode),
  condition,
  surfaces,
  notes: null,
  status: "CURRENT",
  recordedBy: "usr-dent-1",
  recordedAt,
  supersededAt: null,
  supersededBy: null,
  ...o,
});

export const toothRecords: ToothRecordResponse[] = [
  tooth(1, P41, 18, "MISSING", [], at(60)),
  tooth(2, P41, 38, "IMPACTED", [], at(60), { notes: "Mesioangular; asymptomatic." }),
  tooth(3, P41, 21, "FRACTURED", ["I"], at(60), { notes: "Minor incisal chip." }),
  tooth(4, P41, 36, "CARIES", ["M", "O"], at(40, 10, 21), {
    encounterId: E1,
    status: "HISTORICAL",
    supersededAt: at(40, 11, 31),
    supersededBy: "usr-dent-1",
  }),
  tooth(5, P41, 36, "FILLED", ["M", "O"], at(40, 11, 31), { encounterId: E1 }),
  tooth(6, P41, 46, "PERIAPICAL_LESION", [], at(40, 10, 22), { encounterId: E1 }),
  tooth(7, P41, 26, "CARIES", ["O"], at(40, 10, 23), { encounterId: E1 }),
  tooth(8, P3, 16, "CROWN", [], at(200), { recordedBy: "usr-owner-1" }),
  tooth(9, P3, 24, "FILLED", ["O", "D"], at(200), { recordedBy: "usr-owner-1" }),
  tooth(10, P3, 37, "EXTRACTED", [], at(200), { recordedBy: "usr-owner-1" }),
];

/** Encounter attachments (document id → encounter id); documents live in the M1 mock. */
export const attachments: Record<string, string> = { [fid("13", 1)]: E1 };

// ---- Plans -----------------------------------------------------------------------------------

const item = (
  idv: string,
  planId: string,
  phase: number,
  sequence: number,
  serviceNo: number,
  status: PlanItemDetail["status"],
  o: Partial<PlanItemDetail> = {},
): PlanItemDetail => {
  const s = svc(serviceNo);
  const base: PlanItemDetail = {
    id: idv,
    planId,
    phase,
    sequence,
    serviceId: s.id,
    toothCode: null,
    surfaces: [],
    quantity: 1,
    estimatePricePaise: s.basePricePaise,
    priceSource: "BASE",
    pricedAt: at(40, 10, 55),
    status,
    notes: null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    ...o,
  };
  return { ...base, lineTotalPaise: base.estimatePricePaise * base.quantity };
};

const decided = (reason: string | null = null) => ({
  decidedAt: at(39, 9),
  decidedBy: "usr-dent-1",
  decisionReason: reason,
});

const plan1Items: PlanItemDetail[] = [
  item(I1, PL1, 1, 1, 9, "IN_PROGRESS", { toothCode: 46, ...decided() }),
  item(I2, PL1, 1, 2, 11, "ACCEPTED", {
    toothCode: 46,
    notes: "After RCT completion.",
    ...decided(),
  }),
  item(I3, PL1, 2, 1, 6, "DEFERRED", {
    toothCode: 26,
    surfaces: ["O"],
    ...decided("Patient prefers to wait until the root canal is complete"),
  }),
  item(I4, PL1, 2, 2, 4, "REJECTED", { ...decided("Had scaling done elsewhere last month") }),
  item(I5, PL1, 3, 1, 16, "PROPOSED"),
];

const plan2Items: PlanItemDetail[] = [
  item(I6, PL2, 1, 1, 4, "PROPOSED", { pricedAt: minutesAgo(30) }),
  item(I7, PL2, 1, 2, 5, "PROPOSED", { pricedAt: minutesAgo(30) }),
];

export function snapshotOf(
  plan: Pick<PlanDetail, "id" | "patientId" | "branchId" | "title" | "notes" | "status">,
  items: PlanItemDetail[],
): PlanSnapshot {
  return {
    plan: {
      id: plan.id,
      patientId: plan.patientId,
      branchId: plan.branchId,
      title: plan.title,
      notes: plan.notes,
      status: plan.status,
    },
    items: items.map((i) => {
      const s = services.find((x) => x.id === i.serviceId);
      return {
        id: i.id,
        phase: i.phase,
        sequence: i.sequence,
        serviceId: i.serviceId,
        serviceCode: s?.code,
        serviceName: s?.name,
        toothCode: i.toothCode,
        surfaces: [...i.surfaces],
        quantity: i.quantity,
        estimatePricePaise: i.estimatePricePaise,
        priceSource: i.priceSource,
        status: i.status,
        decisionReason: i.decisionReason,
        notes: i.notes,
      };
    }),
    totals: planTotals(items),
  };
}

const plan1Base = {
  id: PL1,
  patientId: P41,
  branchId: B1,
  title: "Lower right molar rehabilitation and restorations",
  notes: "Prioritise 46 (symptomatic). Cosmetic items optional.",
};

export const plans: PlanDetail[] = [
  {
    ...plan1Base,
    status: "PARTIALLY_ACCEPTED",
    currentVersion: 3,
    totals: planTotals(plan1Items),
    createdAt: at(40, 10, 55),
    updatedAt: at(12, 18, 20),
    encounterId: E1,
    presentedAt: at(40, 11, 40),
    presentedBy: "usr-dent-1",
    approvedAt: null,
    approvedBy: null,
    cancelReason: null,
    createdBy: "usr-dent-1",
    items: plan1Items,
  },
  {
    id: PL2,
    patientId: P41,
    branchId: B1,
    title: "Preventive care",
    notes: null,
    status: "DRAFT",
    currentVersion: 0,
    totals: planTotals(plan2Items),
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(30),
    encounterId: E3,
    presentedAt: null,
    presentedBy: null,
    approvedAt: null,
    approvedBy: null,
    cancelReason: null,
    createdBy: ME,
    items: plan2Items,
  },
];

const v1Items = plan1Items.map((i) => ({
  ...i,
  status: "PROPOSED" as const,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
}));
const v2Items = plan1Items.map((i) => (i.id === I1 ? { ...i, status: "ACCEPTED" as const } : i));

export const planVersions: PlanVersionResponse[] = [
  {
    id: fid("28", 1),
    planId: PL1,
    version: 1,
    reason: null,
    createdBy: "usr-dent-1",
    createdAt: at(40, 11, 40),
    snapshot: snapshotOf({ ...plan1Base, status: "PRESENTED" }, v1Items),
  },
  {
    id: fid("28", 2),
    planId: PL1,
    version: 2,
    reason: "Patient decisions recorded",
    createdBy: "usr-dent-1",
    createdAt: at(39, 9),
    snapshot: snapshotOf({ ...plan1Base, status: "PARTIALLY_ACCEPTED" }, v2Items),
  },
  {
    id: fid("28", 3),
    planId: PL1,
    version: 3,
    reason: "Session 1 completed",
    createdBy: "usr-dent-1",
    createdAt: at(12, 18, 20),
    snapshot: snapshotOf({ ...plan1Base, status: "PARTIALLY_ACCEPTED" }, plan1Items),
  },
];

export const sessions: PlanItemSessionResponse[] = [
  {
    id: fid("29", 1),
    planItemId: I1,
    sessionNo: 1,
    appointmentId: null,
    encounterId: E2,
    status: "COMPLETED",
    notes: "Access, BMP, CaOH dressing.",
    createdBy: "usr-dent-1",
    createdAt: at(39, 9, 5),
    updatedAt: at(12, 18, 20),
  },
  {
    id: fid("29", 2),
    planItemId: I1,
    sessionNo: 2,
    appointmentId: null,
    encounterId: null,
    status: "PLANNED",
    notes: "Obturation.",
    createdBy: "usr-dent-1",
    createdAt: at(39, 9, 5),
    updatedAt: at(39, 9, 5),
  },
];

// ---- Consent ---------------------------------------------------------------------------------

export const consentTemplates: ConsentTemplateResponse[] = [
  {
    id: fid("2a", 1),
    code: "TP-STD",
    type: "TREATMENT_PLAN",
    title: "Treatment plan consent",
    active: true,
    currentVersion: 2,
    createdAt: at(120),
    updatedAt: at(30),
  },
  {
    id: fid("2a", 2),
    code: "RCT",
    type: "PROCEDURE",
    title: "Root canal treatment consent",
    active: true,
    currentVersion: 1,
    createdAt: at(120),
    updatedAt: at(120),
  },
  {
    id: fid("2a", 3),
    code: "XRAY",
    type: "RADIOGRAPH",
    title: "Radiograph consent",
    active: true,
    currentVersion: 1,
    createdAt: at(120),
    updatedAt: at(120),
  },
];

const tv = (
  k: number,
  templateId: string,
  version: number,
  body: string,
  createdAt: string,
): ConsentTemplateVersionResponse => ({
  id: fid("2b", k),
  templateId,
  version,
  body,
  createdBy: "usr-owner-1",
  createdAt,
});

export const consentTemplateVersions: ConsentTemplateVersionResponse[] = [
  tv(
    1,
    fid("2a", 1),
    1,
    "I have been informed of the proposed treatment, its estimated cost, alternatives and risks.",
    at(120),
  ),
  tv(
    2,
    fid("2a", 1),
    2,
    "I have been informed of the proposed treatment plan shown to me, including the procedures, the teeth involved, the estimated cost of each item and of the plan, the alternatives (including no treatment) and the usual risks. I understand the estimate is valid for the plan version I am signing and that changes to the plan will be shown to me again. I consent to the items I have accepted.",
    at(30),
  ),
  tv(
    3,
    fid("2a", 2),
    1,
    "Root canal treatment: risks include post-operative pain, instrument separation and the need for retreatment or extraction.",
    at(120),
  ),
  tv(
    4,
    fid("2a", 3),
    1,
    "I consent to dental radiographs being taken as clinically required.",
    at(120),
  ),
];

export const signedConsents: (SignedConsentResponse & { patientId: string })[] = [];
