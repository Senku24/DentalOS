import type { Encounter, Patient, Tx } from "@dentalos/db";
import {
  AI_CAPABILITY_CATALOGUE,
  type AiCapability,
  type EncounterFacts,
  type HistorySummaryFacts,
  type NoteDraftFacts,
  type PlanExplanationFacts,
  ageYears,
  planSnapshot,
} from "@dentalos/validation";
import { type Permission, type Principal, can } from "../auth/roles";
import { branchWhere } from "../common/principal";
import { lineageIds } from "../patients/patient-common";
import { conflict } from "./ai-common";

// Retrieval for the prompt builders. Everything here runs under the CALLER's tenant context and branch scope (the AI
// never widens access); the builders in @dentalos/validation then keep only their allow-listed fields.

/** The capability's own permission plus every data permission, checked at `branchId` (capability-only without it). */
export function hasAiPermissions(
  p: Principal,
  capability: AiCapability,
  branchId?: string,
): boolean {
  const info = AI_CAPABILITY_CATALOGUE[capability];
  const resource = branchId ? { branchId } : {};
  return [info.permission, ...info.dataPermissions].every((perm) =>
    can(p, perm as Permission, resource),
  );
}

/** Patients are tenant-wide; the AI draft needs a branch: the origin branch when in scope, else the caller's first. */
export function branchForPatient(
  p: Principal,
  patient: Pick<Patient, "originBranchId">,
): string | null {
  if (p.orgWide) return patient.originBranchId;
  if (p.branchScope.includes(patient.originBranchId)) return patient.originBranchId;
  return p.branchScope[0] ?? null;
}

export const patientNames = (p: Patient): string[] =>
  [p.firstName, p.middleName, p.lastName, p.preferredName].filter((n): n is string => !!n);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const human = (k: string) => k.replace(/[_-]+/g, " ").trim();

/** Questionnaire answers -> short strings ("diabetes", "asthma notes: ..."). Empty / false answers are dropped. */
function answerStrings(answers: unknown): string[] {
  if (!answers || typeof answers !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
    if (v === true) out.push(human(k));
    else if (typeof v === "string" && v.trim()) out.push(`${human(k)}: ${v.trim()}`);
    else if (typeof v === "number") out.push(`${human(k)}: ${v}`);
    else if (Array.isArray(v) && v.length > 0) out.push(`${human(k)}: ${v.join(", ")}`);
  }
  return out;
}

export async function loadHistoryFacts(
  tx: Tx,
  p: Principal,
  patient: Patient,
): Promise<HistorySummaryFacts> {
  const ids = await lineageIds(tx, patient.id);
  const [allergies, alerts, history, encounters] = await Promise.all([
    tx.patientAllergy.findMany({
      where: { patientId: { in: ids }, active: true },
      orderBy: { notedAt: "desc" },
      take: 30,
    }),
    tx.patientAlert.findMany({
      where: { patientId: { in: ids }, active: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    tx.patientMedicalHistory.findFirst({
      where: { patientId: { in: ids } },
      orderBy: { recordedAt: "desc" },
    }),
    tx.encounter.findMany({
      where: { patientId: { in: ids }, AND: [branchWhere(p)] },
      orderBy: { openedAt: "desc" },
      take: 5,
      include: {
        diagnoses: { select: { label: true, toothCode: true } },
        procedures: {
          select: { description: true, toothCode: true, service: { select: { name: true } } },
        },
        notes: { select: { body: true }, orderBy: { createdAt: "asc" } },
      },
    }),
  ]);
  const meds = Array.isArray(history?.medications)
    ? (history.medications as { name?: string; dose?: string; frequency?: string }[])
    : [];
  const tooth = (t: number | null) => (t ? ` (tooth ${t})` : "");
  return {
    ageYears: ageYears(patient.dob?.toISOString().slice(0, 10)),
    sex: patient.sex === "UNKNOWN" ? null : patient.sex,
    allergies: allergies.map((a) => ({
      substance: a.substance,
      severity: a.severity,
      reaction: a.reaction,
    })),
    conditions: [...answerStrings(history?.medical), ...(history?.notes ? [history.notes] : [])],
    medications: meds
      .map((m) => [m.name, m.dose, m.frequency].filter(Boolean).join(" "))
      .filter(Boolean),
    alerts: alerts.map((a) => [a.title, a.details].filter(Boolean).join(": ")),
    habits: answerStrings(history?.dental),
    recentEncounters: encounters.map((e) => ({
      date: isoDay(e.openedAt),
      diagnoses: e.diagnoses.map((d) => `${d.label}${tooth(d.toothCode)}`),
      procedures: e.procedures.map(
        (r) => `${r.description ?? r.service?.name ?? "procedure"}${tooth(r.toothCode)}`,
      ),
      notes: e.notes.map((n) => n.body).join("\n"),
    })),
  };
}

export async function loadEncounterFacts(
  tx: Tx,
  enc: Encounter,
  patient: Patient,
): Promise<EncounterFacts> {
  const [notes, diagnoses, procedures] = await Promise.all([
    tx.clinicalNote.findMany({ where: { encounterId: enc.id }, orderBy: { createdAt: "asc" } }),
    tx.diagnosis.findMany({ where: { encounterId: enc.id }, orderBy: { createdAt: "asc" } }),
    tx.procedureRecord.findMany({
      where: { encounterId: enc.id },
      orderBy: { createdAt: "asc" },
      include: { service: { select: { name: true } } },
    }),
  ]);
  return {
    ageYears: ageYears(patient.dob?.toISOString().slice(0, 10)),
    sex: patient.sex === "UNKNOWN" ? null : patient.sex,
    date: isoDay(enc.openedAt),
    notes: notes.map((n) => ({ kind: n.kind, body: n.body })),
    diagnoses: diagnoses.map((d) => ({ toothCode: d.toothCode, label: d.label })),
    procedures: procedures.map((r) => ({
      toothCode: r.toothCode,
      label: r.description ?? r.service?.name ?? "procedure",
      status: r.status,
    })),
  };
}

export async function loadNoteFacts(
  tx: Tx,
  enc: Encounter,
  patient: Patient,
  clinicianText: string,
): Promise<NoteDraftFacts> {
  const facts = await loadEncounterFacts(tx, enc, patient);
  return {
    ageYears: facts.ageYears,
    sex: facts.sex,
    clinicianText,
    diagnoses: facts.diagnoses,
    procedures: facts.procedures.map((r) => ({ toothCode: r.toothCode, label: r.label })),
  };
}

/** Structured plan facts from the frozen version snapshot (declined / cancelled items are not explained). */
export function planFactsFromSnapshot(snapshot: unknown): PlanExplanationFacts {
  const parsed = planSnapshot.safeParse(snapshot);
  if (!parsed.success) throw conflict("plan_snapshot_invalid");
  const items = parsed.data.items
    .filter((i) => i.status !== "CANCELLED" && i.status !== "REJECTED")
    .sort((a, b) => a.phase - b.phase || a.sequence - b.sequence);
  return {
    items: items.map((i) => ({
      planItemId: i.id,
      serviceName: i.serviceName ?? i.serviceCode ?? "Dental procedure",
      toothCode: i.toothCode,
      quantity: i.quantity,
      estimatePaise: i.estimatePricePaise,
      phase: i.phase,
    })),
    totalPaise: items.reduce((sum, i) => sum + i.quantity * i.estimatePricePaise, 0),
  };
}
