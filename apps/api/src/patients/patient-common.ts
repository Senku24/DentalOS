import { type Patient, type PatientEnquiry, Prisma, type Tx } from "@dentalos/db";
import type { EnquiryResponse, PatientResponse, PatientSummary } from "@dentalos/validation";
import { ConflictException, NotFoundException } from "@nestjs/common";

/** DATE column -> "YYYY-MM-DD" (Prisma returns UTC midnight). */
export const dateOnly = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
/** "YYYY-MM-DD" -> Date for a DATE column. */
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSummary(p: Patient): PatientSummary {
  return {
    id: p.id,
    mrn: p.mrn,
    firstName: p.firstName,
    lastName: p.lastName,
    preferredName: p.preferredName,
    dob: dateOnly(p.dob),
    sex: p.sex,
    phone: p.phone,
    originBranchId: p.originBranchId,
    lifecycleStage: p.lifecycleStage,
    mergedIntoId: p.mergedIntoId,
  };
}

export function toResponse(p: Patient): PatientResponse {
  return {
    ...toSummary(p),
    middleName: p.middleName,
    altPhone: p.altPhone,
    email: p.email,
    addressLine1: p.addressLine1,
    addressLine2: p.addressLine2,
    city: p.city,
    state: p.state,
    postalCode: p.postalCode,
    country: p.country,
    intakeType: p.intakeType,
    identityVerifiedAt: iso(p.identityVerifiedAt),
    identityVerificationMethod: p.identityVerificationMethod,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toEnquiryResponse(e: PatientEnquiry): EnquiryResponse {
  return {
    id: e.id,
    branchId: e.branchId,
    name: e.name,
    phone: e.phone,
    email: e.email,
    source: e.source,
    areaOfInterest: e.areaOfInterest,
    notes: e.notes,
    status: e.status,
    convertedPatientId: e.convertedPatientId,
    createdAt: e.createdAt.toISOString(),
  };
}

/** RLS hides other tenants' rows, so a foreign id is indistinguishable from a missing one: 404. */
export async function findPatientOr404(tx: Tx, id: string): Promise<Patient> {
  const p = await tx.patient.findUnique({ where: { id } });
  if (!p) throw new NotFoundException({ error: "patient_not_found" });
  return p;
}

/** Follows mergedIntoId to the current survivor (merge chains are short; bounded for safety). */
export async function resolveSurvivorId(tx: Tx, p: Patient): Promise<string> {
  let cur: Pick<Patient, "id" | "mergedIntoId"> = p;
  for (let i = 0; i < 20 && cur.mergedIntoId; i++) {
    const next = await tx.patient.findUnique({
      where: { id: cur.mergedIntoId },
      select: { id: true, mergedIntoId: true },
    });
    if (!next) break;
    cur = next;
  }
  return cur.id;
}

/**
 * Loads a patient that may be written to. Merged records are read-only tombstones: the DB does not
 * stop writes to them, so every write path goes through here. 409 carries the survivor pointer.
 */
export async function findActivePatient(tx: Tx, id: string): Promise<Patient> {
  const p = await findPatientOr404(tx, id);
  if (p.mergedIntoId) {
    throw new ConflictException({
      error: "patient_merged",
      message: "This patient was merged; edit the surviving record",
      mergedIntoId: p.mergedIntoId,
      survivorId: await resolveSurvivorId(tx, p),
    });
  }
  return p;
}

/**
 * The patient plus every record merged into it, transitively (A→B→C: C's lineage is C, B, A).
 * Append-only history (medical versions) stays on the merged ids, so survivor reads use this.
 */
export async function lineageIds(tx: Tx, id: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE lineage(id, depth) AS (
      SELECT ${id}::uuid, 0
      UNION ALL
      SELECT p.id, l.depth + 1 FROM "Patient" p JOIN lineage l ON p."mergedIntoId" = l.id
      WHERE l.depth < 20
    )
    SELECT id::text AS id FROM lineage`);
  return rows.map((r) => r.id);
}

/** Maps Prisma unique/foreign-key violations to client errors instead of 500s. */
export function mapPrismaError(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") throw new ConflictException({ error: "conflict" });
    if (e.code === "P2003") throw new NotFoundException({ error: "referenced_record_not_found" });
  }
  throw e;
}
