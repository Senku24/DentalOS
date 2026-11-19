import { randomUUID } from "node:crypto";
import { normalizeName } from "@dentalos/validation";
import { type Harness, code, startHarness } from "../org/test-harness";

/**
 * Test-only world for the plans suites: fresh random tenants (never touches other suites' rows),
 * seeded through the admin (RLS-bypassing) connection; behaviour under test goes through the API.
 */
export interface World {
  h: Harness;
  tA: string;
  tB: string;
  a1: string;
  a2: string;
  b1: string;
  users: {
    dentist: string;
    dentistA2: string;
    rec: string;
    recA2: string;
    owner: string;
    manager: string;
    acct: string;
    dentistB: string;
    ownerB: string;
  };
}

export async function startWorld(label: string): Promise<World> {
  const h = await startHarness();
  const tA = await h.tenant(`${label}-A`);
  const tB = await h.tenant(`${label}-B`);
  const a1 = await h.branch(tA);
  const a2 = await h.branch(tA);
  const b1 = await h.branch(tB);
  const users = {
    dentist: await h.member(tA, ["DENTIST"], { branchScope: [a1] }),
    dentistA2: await h.member(tA, ["DENTIST"], { branchScope: [a2] }),
    rec: await h.member(tA, ["RECEPTIONIST"], { branchScope: [a1] }),
    recA2: await h.member(tA, ["RECEPTIONIST"], { branchScope: [a2] }),
    owner: await h.member(tA, ["OWNER"], { orgWide: true }),
    manager: await h.member(tA, ["MANAGER"], { orgWide: true }),
    acct: await h.member(tA, ["ACCOUNTANT"], { branchScope: [a1] }),
    dentistB: await h.member(tB, ["DENTIST"], { branchScope: [b1] }),
    ownerB: await h.member(tB, ["OWNER"], { orgWide: true }),
  };
  return { h, tA, tB, a1, a2, b1, users };
}

export async function seedPatient(h: Harness, tenantId: string, branchId: string, first = "Pat") {
  const p = await h.admin.patient.create({
    data: {
      tenantId,
      originBranchId: branchId,
      firstName: first,
      lastName: code("L"),
      nameNormalized: normalizeName(first, "x"),
      intakeType: "WALK_IN",
      createdBy: "seed",
    },
  });
  return p.id;
}

export async function seedService(h: Harness, tenantId: string, basePricePaise: number) {
  const s = await h.admin.service.create({
    data: {
      tenantId,
      code: code("SVC"),
      name: `Service ${code()}`,
      durationMin: 30,
      basePricePaise,
    },
  });
  return s.id;
}

/** Closes any open override and opens a new one (same shape as the catalog API). */
export async function setOverride(
  h: Harness,
  tenantId: string,
  serviceId: string,
  branchId: string,
  pricePaise: number,
) {
  const now = new Date();
  await h.admin.branchPriceOverride.updateMany({
    where: { tenantId, serviceId, branchId, effectiveTo: null },
    data: { effectiveTo: now, endedReason: "superseded", endedBy: "seed" },
  });
  await h.admin.branchPriceOverride.create({
    data: {
      tenantId,
      serviceId,
      branchId,
      pricePaise,
      reason: "test",
      setBy: "seed",
      effectiveFrom: new Date(now.getTime() - 1000),
    },
  });
}

export async function seedDocument(
  h: Harness,
  tenantId: string,
  patientId: string,
  branchId: string,
  opts: { category?: "CONSENT_FORM" | "OTHER"; status?: "AVAILABLE" | "PENDING_UPLOAD" } = {},
) {
  const d = await h.admin.patientDocument.create({
    data: {
      tenantId,
      patientId,
      branchId,
      storageKey: `test/${tenantId}/${randomUUID()}`,
      fileName: "signature.png",
      contentType: "image/png",
      sizeBytes: 100,
      category: opts.category ?? "CONSENT_FORM",
      status: opts.status ?? "AVAILABLE",
      uploadedBy: "seed",
    },
  });
  return d.id;
}

let slot = 0;
/** Unassigned (no dentist, no chair) so it never collides with the exclusion constraints. */
export async function seedAppointment(
  h: Harness,
  tenantId: string,
  patientId: string,
  branchId: string,
  status: "BOOKED" | "CANCELLED" = "BOOKED",
) {
  const start = new Date(Date.UTC(2031, 0, 1, 0, 0) + (slot++ + Math.random()) * 3_600_000);
  const a = await h.admin.appointment.create({
    data: {
      tenantId,
      patientId,
      branchId,
      appointmentType: "TREATMENT",
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      status,
      cancelReason: status === "CANCELLED" ? "test" : null,
      createdBy: "seed",
    },
  });
  return a.id;
}

export async function seedEncounter(
  h: Harness,
  tenantId: string,
  patientId: string,
  branchId: string,
  dentist: string,
  signed = false,
) {
  const e = await h.admin.encounter.create({
    data: {
      tenantId,
      patientId,
      branchId,
      treatingDentistUserId: dentist,
      openedBy: dentist,
      ...(signed ? { status: "SIGNED", signedAt: new Date(), signedBy: dentist } : {}),
    },
  });
  return e.id;
}
