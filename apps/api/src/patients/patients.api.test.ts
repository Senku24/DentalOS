import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@dentalos/db";
import { NestFactory } from "@nestjs/core";
import { SignJWT } from "jose";

// Same boot as api.test.ts. Fresh random tenants per run; never truncates shared tables.
process.env.DEV_JWT_SECRET = "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";
const { AppModule } = await import("../app.module");

const admin = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres:postgres@localhost:5433/dentalos" } },
});
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const token = (sub: string, extra: Record<string, unknown> = {}) =>
  new SignJWT({ mfa: true, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(key);

let app: Awaited<ReturnType<typeof NestFactory.create>>;
let base: string;
let tA: string;
let tB: string;
let a1: string;
let a2: string;
let b1: string;

const sfx = Math.random().toString(36).slice(2, 8).toUpperCase();
/** Unique Indian mobile per call so tests never match each other's patients by phone. */
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

/** Response bodies are untyped JSON (JSON.parse returns `any`). */
type J = ReturnType<typeof JSON.parse>;
type Res = { status: number; body: J };
async function call(
  user: string,
  method: string,
  path: string,
  body?: unknown,
  o: { tenant?: string; tokenExtra?: Record<string, unknown> } = {},
): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${await token(user, o.tokenExtra)}`,
      "x-tenant-id": o.tenant ?? tA,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const OWNER = "owner";
const MANAGER = "manager";
const DENTIST = "dentist";
const REC = "rec";
const ACCT = "acct";
const OWNER_B = "owner-b";

beforeAll(async () => {
  tA = (await admin.tenant.create({ data: { name: `PAT-A-${sfx}` } })).id;
  tB = (await admin.tenant.create({ data: { name: `PAT-B-${sfx}` } })).id;
  a1 = (await admin.branch.create({ data: { tenantId: tA, code: `A1-${sfx}`, name: "A1" } })).id;
  a2 = (await admin.branch.create({ data: { tenantId: tA, code: `A2-${sfx}`, name: "A2" } })).id;
  b1 = (await admin.branch.create({ data: { tenantId: tB, code: `B1-${sfx}`, name: "B1" } })).id;
  await admin.membership.createMany({
    data: [
      { tenantId: tA, userId: OWNER, roles: ["OWNER"], orgWide: true },
      { tenantId: tA, userId: MANAGER, roles: ["MANAGER"], orgWide: true },
      { tenantId: tA, userId: DENTIST, roles: ["DENTIST"], branchScope: [a1] },
      { tenantId: tA, userId: REC, roles: ["RECEPTIONIST"], branchScope: [a1] },
      { tenantId: tA, userId: ACCT, roles: ["ACCOUNTANT"], branchScope: [a1] },
      { tenantId: tB, userId: OWNER_B, roles: ["OWNER"], orgWide: true },
    ],
  });
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
});
afterAll(async () => {
  await app.close();
  await admin.$disconnect();
});

const newPatient = async (
  fields: Record<string, unknown>,
  user = REC,
  tenant?: string,
): Promise<J> => {
  const r = await call(
    user,
    "POST",
    "/patients",
    { originBranchId: a1, intakeType: "WALK_IN", ...fields },
    { tenant },
  );
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const auditCount = (action: string, resourceId: string) =>
  admin.auditEvent.count({ where: { tenantId: tA, action, resourceId } });

describe("patient CRUD", () => {
  test("receptionist registers a walk-in at their branch", async () => {
    const r = await call(REC, "POST", "/patients", {
      originBranchId: a1,
      intakeType: "WALK_IN",
      firstName: " Kavya ",
      lastName: "Iyer",
      sex: "FEMALE",
      phone: "98450 12345".replace("12345", String(Math.floor(Math.random() * 9e4) + 1e4)),
      dob: "1991-04-05",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      firstName: "Kavya",
      lastName: "Iyer",
      originBranchId: a1,
      lifecycleStage: "REGISTERED",
      intakeType: "WALK_IN",
      dob: "1991-04-05",
      mergedIntoId: null,
    });
    expect(r.body.phone).toMatch(/^\+919845\d{6}$/);
    expect(r.body.nameNormalized).toBeUndefined();
    expect(await auditCount("patient.create", r.body.id)).toBe(1);
    const row = await admin.patient.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.nameNormalized).toBe("kavya iyer");
    expect(row.phoneNormalized).toBe(r.body.phone);
  });

  test("validation: 400 for missing name, bad phone, missing contact (non-urgent)", async () => {
    const bad = [
      { originBranchId: a1, intakeType: "WALK_IN", phone: phone() },
      { originBranchId: a1, intakeType: "WALK_IN", firstName: "X", phone: "12" },
      { originBranchId: a1, intakeType: "APPOINTMENT", firstName: "NoContact" },
      { originBranchId: "nope", intakeType: "WALK_IN", firstName: "X", phone: phone() },
      { originBranchId: a1, intakeType: "WALK_IN", firstName: "X", dob: "2999-01-01" },
    ];
    for (const b of bad) {
      const r = await call(REC, "POST", "/patients", b);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("validation_failed");
    }
  });

  test("urgent intake accepts a first name only", async () => {
    const r = await call(REC, "POST", "/patients", {
      originBranchId: a1,
      intakeType: "URGENT",
      firstName: `Urgent${sfx}`,
    });
    expect(r.status).toBe(201);
    expect(r.body.intakeType).toBe("URGENT");
  });

  test("registering at a branch outside the caller's scope is 403; unknown branch 404", async () => {
    const r = await call(REC, "POST", "/patients", {
      originBranchId: a2,
      intakeType: "WALK_IN",
      firstName: "Scope",
      phone: phone(),
    });
    expect(r.status).toBe(403);
    const missing = await call(OWNER, "POST", "/patients", {
      originBranchId: b1, // exists, but in tenant B: invisible under RLS
      intakeType: "WALK_IN",
      firstName: "Ghost",
      phone: phone(),
    });
    expect(missing.status).toBe(404);
  });

  test("get, cross-tenant 404, malformed id 400", async () => {
    const p = await newPatient({ firstName: "Rohan", lastName: `Get${sfx}`, phone: phone() });
    expect((await call(ACCT, "GET", `/patients/${p.id}`)).status).toBe(200);
    expect(
      (await call(OWNER_B, "GET", `/patients/${p.id}`, undefined, { tenant: tB })).status,
    ).toBe(404);
    expect((await call(OWNER, "GET", "/patients/not-a-uuid")).status).toBe(400);
  });

  test("update re-normalises and does not reset omitted fields (sex/country)", async () => {
    const p = await newPatient({
      firstName: "Meera",
      lastName: `Upd${sfx}`,
      sex: "FEMALE",
      phone: phone(),
    });
    const r = await call(DENTIST, "PATCH", `/patients/${p.id}`, {
      city: "Pune",
      lastName: `Updated${sfx}`,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ city: "Pune", sex: "FEMALE", country: "IN" });
    const row = await admin.patient.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.nameNormalized).toBe(`meera updated${sfx.toLowerCase()}`);
    expect((await call(ACCT, "PATCH", `/patients/${p.id}`, { city: "X" })).status).toBe(403);
  });

  test("lifecycle: allowed moves succeed, invalid ones are 409", async () => {
    const p = await newPatient({ firstName: "Life", lastName: `Cycle${sfx}`, phone: phone() });
    const ok = await call(REC, "POST", `/patients/${p.id}/lifecycle`, { stage: "ACTIVE" });
    expect(ok.status).toBe(200);
    expect(ok.body.lifecycleStage).toBe("ACTIVE");
    const back = await call(REC, "POST", `/patients/${p.id}/lifecycle`, { stage: "REGISTERED" });
    expect(back.status).toBe(409);
    expect(back.body.error).toBe("invalid_lifecycle_transition");
    const viaPatch = await call(REC, "PATCH", `/patients/${p.id}`, { lifecycleStage: "RECALL" });
    expect(viaPatch.status).toBe(200);
    const bad = await call(REC, "PATCH", `/patients/${p.id}`, { lifecycleStage: "FOLLOW_UP" });
    expect(bad.status).toBe(409);
  });

  test("identity verification stores method + last 4 only and is audited", async () => {
    const p = await newPatient({ firstName: "Ident", lastName: `Ity${sfx}`, phone: phone() });
    const path = `/patients/${p.id}/identity-verification`;
    expect((await call(REC, "POST", path, { method: "IN_PERSON_DOCUMENT" })).status).toBe(400);
    expect(
      (
        await call(REC, "POST", path, {
          method: "IN_PERSON_DOCUMENT",
          documentType: "AADHAAR",
          documentLast4: "123456789012",
        })
      ).status,
    ).toBe(400);
    const r = await call(REC, "POST", path, {
      method: "IN_PERSON_DOCUMENT",
      documentType: "AADHAAR",
      documentLast4: "9012",
    });
    expect(r.status).toBe(200);
    expect(r.body.identityVerificationMethod).toBe("IN_PERSON_DOCUMENT");
    expect(r.body.identityVerifiedAt).toBeString();
    const row = await admin.patient.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ identityDocumentLast4: "9012", identityVerifiedBy: REC });
    expect(await auditCount("patient.identity.verify", p.id)).toBe(1);
  });
});

describe("search", () => {
  const tag = `Srch${sfx}`.toLowerCase();
  let p1: J;
  let p2: J;
  let p3: J;
  beforeAll(async () => {
    p1 = await newPatient({ firstName: "Ananya", lastName: `Rao${tag}`, phone: phone() });
    p2 = await newPatient({
      firstName: "Ananya",
      lastName: `Rao${tag}x`,
      phone: phone(),
      intakeType: "APPOINTMENT",
      acknowledgeDuplicates: true,
    });
    p3 = await newPatient(
      { firstName: "Vikram", lastName: `Rao${tag}`, phone: phone(), originBranchId: a2 },
      OWNER,
    );
  });

  test("free text: substring and trigram name match", async () => {
    const r = await call(REC, "GET", `/patients?q=${encodeURIComponent(`ananya rao${tag}`)}`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((x: J) => x.id);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
    const typo = await call(REC, "GET", `/patients?q=${encodeURIComponent(`Ananya Rau${tag}`)}`);
    expect(typo.body.items.map((x: J) => x.id)).toContain(p1.id);
  });

  test("free text: phone digits and exact phone filter", async () => {
    const digits = p1.phone.slice(-7);
    const r = await call(REC, "GET", `/patients?q=${digits}`);
    expect(r.body.items.map((x: J) => x.id)).toContain(p1.id);
    const exact = await call(REC, "GET", `/patients?phone=${encodeURIComponent(p1.phone)}`);
    expect(exact.body.items.map((x: J) => x.id)).toEqual([p1.id]);
  });

  test("filters: origin branch, intake type, lifecycle stage", async () => {
    const q = `q=${encodeURIComponent(`rao${tag}`)}`;
    const byBranch = await call(REC, "GET", `/patients?${q}&originBranchId=${a2}`);
    expect(byBranch.body.items.map((x: J) => x.id)).toEqual([p3.id]);
    const byIntake = await call(REC, "GET", `/patients?${q}&intakeType=APPOINTMENT`);
    expect(byIntake.body.items.map((x: J) => x.id)).toEqual([p2.id]);
    const byStage = await call(REC, "GET", `/patients?${q}&lifecycleStage=INACTIVE`);
    expect(byStage.body.items).toEqual([]);
  });

  test("keyset pagination returns disjoint pages; bad cursor 400", async () => {
    const q = `q=${encodeURIComponent(`rao${tag}`)}`;
    const first = await call(REC, "GET", `/patients?${q}&limit=2`);
    expect(first.body.items.length).toBe(2);
    expect(first.body.nextCursor).toBeString();
    const second = await call(REC, "GET", `/patients?${q}&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.status).toBe(200);
    const all = [...first.body.items, ...second.body.items].map((x: J) => x.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining([p1.id, p2.id, p3.id]));
    expect((await call(REC, "GET", "/patients?cursor=garbage")).status).toBe(400);
    expect((await call(REC, "GET", "/patients?limit=1000")).status).toBe(400);
  });
});

describe("duplicate detection", () => {
  const tag = `Dup${sfx}`.toLowerCase();
  let existing: J;
  let ph: string;
  beforeAll(async () => {
    ph = phone();
    existing = await newPatient({
      firstName: "Farhan",
      lastName: `Sheikh${tag}`,
      phone: ph,
      dob: "1985-06-15",
    });
  });

  test("check finds phone and name matches with reasons; never persists", async () => {
    const r = await call(REC, "POST", "/patients/duplicate-check", {
      firstName: "Farhaan",
      lastName: `Sheikh${tag}`,
      phone: `+91 ${ph.slice(0, 5)} ${ph.slice(5)}`,
    });
    expect(r.status).toBe(200);
    const m = r.body.matches.find((x: J) => x.patient.id === existing.id);
    expect(m.reasons).toEqual(["PHONE_EXACT", "NAME_SIMILAR"]);
    expect(m.score).toBeGreaterThanOrEqual(60);
    const byName = await call(REC, "POST", "/patients/duplicate-check", {
      firstName: "Farhan",
      lastName: `Sheikh${tag}`,
      dob: "1985-06-15",
    });
    const n = byName.body.matches.find((x: J) => x.patient.id === existing.id);
    expect(n.reasons).toEqual(["NAME_EXACT", "DOB_EXACT"]);
    const none = await call(REC, "POST", "/patients/duplicate-check", {
      firstName: "Completely",
      lastName: `Different${sfx}`,
      phone: phone(),
    });
    expect(none.body.matches).toEqual([]);
    const strict = await call(REC, "POST", "/patients/duplicate-check", {
      firstName: "Farhan",
      lastName: `Sheikh${tag}`,
      phone: ph,
      failOnMatch: true,
    });
    expect(strict.status).toBe(409);
  });

  test("create warns (409) on likely duplicates; acknowledged create persists the pair", async () => {
    const body = { firstName: "Farhan", lastName: `Sheikh${tag}`, phone: ph };
    const warn = await call(REC, "POST", "/patients", {
      originBranchId: a1,
      intakeType: "WALK_IN",
      ...body,
    });
    expect(warn.status).toBe(409);
    expect(warn.body.error).toBe("possible_duplicates");
    expect(warn.body.matches[0].patient.id).toBe(existing.id);
    const created = await newPatient({ ...body, acknowledgeDuplicates: true });
    expect(created.possibleDuplicates.map((d: J) => d.patientId)).toContain(existing.id);
    expect(await auditCount("patient.duplicates_acknowledged", created.id)).toBe(1);
    const [a, b] = [existing.id, created.id].sort();
    const cand = await admin.duplicateCandidate.findUniqueOrThrow({
      where: { tenantId_patientAId_patientBId: { tenantId: tA, patientAId: a, patientBId: b } },
    });
    expect(cand.status).toBe("PENDING");
    const list = await call(MANAGER, "GET", "/duplicate-candidates");
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: J) => c.id)).toContain(cand.id);
    // Dismiss: receptionist lacks patient:merge, manager can; second dismiss is 409.
    expect(
      (await call(REC, "POST", `/duplicate-candidates/${cand.id}/dismiss`, { reason: "family" }))
        .status,
    ).toBe(403);
    const d = await call(MANAGER, "POST", `/duplicate-candidates/${cand.id}/dismiss`, {
      reason: "Twins sharing a phone",
    });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("DISMISSED");
    expect(
      (await admin.duplicateCandidate.findUniqueOrThrow({ where: { id: cand.id } })).reviewReason,
    ).toBe("Twins sharing a phone");
    expect(
      (await call(MANAGER, "POST", `/duplicate-candidates/${cand.id}/dismiss`, { reason: "again" }))
        .status,
    ).toBe(409);
  });

  test("urgent intake is never blocked by the warning but still queues the pair", async () => {
    const r = await call(REC, "POST", "/patients", {
      originBranchId: a1,
      intakeType: "URGENT",
      firstName: "Farhan",
      lastName: `Sheikh${tag}`,
      phone: ph,
      dob: "1985-06-15",
    });
    expect(r.status).toBe(201);
    expect(r.body.possibleDuplicates.length).toBeGreaterThan(0);
  });
});

describe("RBAC", () => {
  let pid: string;
  beforeAll(async () => {
    pid = (await newPatient({ firstName: "Rbac", lastName: `Case${sfx}`, phone: phone() })).id;
  });

  test("accountant: can read profile, cannot read medical data or write patients", async () => {
    expect((await call(ACCT, "GET", `/patients/${pid}`)).status).toBe(200);
    expect((await call(ACCT, "GET", `/patients/${pid}/medical-history`)).status).toBe(403);
    expect((await call(ACCT, "GET", `/patients/${pid}/allergies`)).status).toBe(403);
    expect((await call(ACCT, "GET", `/patients/${pid}/alerts`)).status).toBe(403);
    expect(
      (
        await call(ACCT, "POST", "/patients", {
          originBranchId: a1,
          intakeType: "WALK_IN",
          firstName: "No",
          phone: phone(),
        })
      ).status,
    ).toBe(403);
    expect((await call(ACCT, "GET", `/patients/${pid}/consents`)).status).toBe(403);
  });

  test("receptionist cannot review duplicates or merge; owner cannot write medical history", async () => {
    expect((await call(REC, "GET", "/duplicate-candidates")).status).toBe(403);
    expect(
      (await call(REC, "GET", `/patient-merges/preview?survivorId=${pid}&mergedId=${pid}`)).status,
    ).toBe(403);
    expect(
      (
        await call(REC, "POST", "/patient-merges", {
          survivorId: pid,
          mergedId: crypto.randomUUID(),
          reason: "duplicate registration",
        })
      ).status,
    ).toBe(403);
    expect((await call(OWNER, "POST", `/patients/${pid}/medical-history`, {})).status).toBe(403);
    expect((await call(OWNER, "GET", `/patients/${pid}/medical-history`)).status).toBe(200);
  });
});

describe("medical history, allergies, alerts", () => {
  let pid: string;
  beforeAll(async () => {
    pid = (await newPatient({ firstName: "Medi", lastName: `Cal${sfx}`, phone: phone() })).id;
  });

  test("history is versioned and append-only; latest is newest", async () => {
    const v1 = await call(DENTIST, "POST", `/patients/${pid}/medical-history`, {
      medical: { diabetes: false },
      medications: [{ name: "Metformin", dose: "500mg" }],
    });
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe(1);
    const v2 = await call(REC, "POST", `/patients/${pid}/medical-history`, {
      medical: { diabetes: true },
      branchId: a1,
    });
    expect(v2.body.version).toBe(2);
    const r = await call(DENTIST, "GET", `/patients/${pid}/medical-history`);
    expect(r.status).toBe(200);
    expect(r.body.latest.version).toBe(2);
    expect(r.body.latest.medical).toEqual({ diabetes: true });
    expect(r.body.versions.map((v: J) => v.version)).toEqual([2, 1]);
    expect(await auditCount("patient.medical_history.read", pid)).toBeGreaterThanOrEqual(1);
    const bad = await call(DENTIST, "POST", `/patients/${pid}/medical-history`, {
      medical: { x: { nested: true } },
    });
    expect(bad.status).toBe(400);
  });

  test("allergies and alerts are resolved, never deleted", async () => {
    const a = await call(DENTIST, "POST", `/patients/${pid}/allergies`, {
      substance: "Penicillin",
      severity: "HIGH",
    });
    expect(a.status).toBe(201);
    const res = await call(DENTIST, "POST", `/patients/${pid}/allergies/${a.body.id}/resolve`, {
      reason: "Tolerated amoxicillin",
    });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(
      (await admin.patientAllergy.findUniqueOrThrow({ where: { id: a.body.id } })).resolutionReason,
    ).toBe("Tolerated amoxicillin");
    expect(
      (await call(DENTIST, "POST", `/patients/${pid}/allergies/${a.body.id}/resolve`, {})).status,
    ).toBe(409);
    expect((await call(DENTIST, "GET", `/patients/${pid}/allergies`)).body.items).toEqual([]);
    const all = await call(DENTIST, "GET", `/patients/${pid}/allergies?includeResolved=true`);
    expect(all.body.items.map((x: J) => x.id)).toEqual([a.body.id]);

    const al = await call(REC, "POST", `/patients/${pid}/alerts`, {
      title: "Anticoagulants",
      severity: "CRITICAL",
    });
    expect(al.status).toBe(201);
    expect((await call(REC, "GET", `/patients/${pid}/alerts`)).body.items.length).toBe(1);
    expect(
      (
        await call(REC, "POST", `/patients/${pid}/alerts/${al.body.id}/resolve`, {
          reason: "Stopped",
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin.patientAlert.findUniqueOrThrow({ where: { id: al.body.id } })).resolutionReason,
    ).toBe("Stopped");
    expect(
      (await call(REC, "POST", `/patients/${pid}/alerts`, { title: "x", severity: "BAD" })).status,
    ).toBe(400);
  });
});

describe("consent and communication preferences", () => {
  let pid: string;
  beforeAll(async () => {
    pid = (await newPatient({ firstName: "Con", lastName: `Sent${sfx}`, phone: phone() })).id;
  });

  test("consent:manage is checked on the capture branch", async () => {
    const base = { type: "DATA_PROCESSING", version: "v1", status: "GRANTED", method: "DIGITAL" };
    const ok = await call(REC, "POST", `/patients/${pid}/consents`, { ...base, branchId: a1 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "GRANTED", branchId: a1, capturedBy: REC });
    expect(ok.body.grantedAt).toBeString();
    const other = await call(REC, "POST", `/patients/${pid}/consents`, { ...base, branchId: a2 });
    expect(other.status).toBe(403);
    const implied = await call(REC, "POST", `/patients/${pid}/consents`, {
      ...base,
      type: "CLINICAL_PHOTOGRAPHY",
    });
    expect(implied.status).toBe(201);
    expect(implied.body.branchId).toBe(a1);
    const mgr = await call(MANAGER, "POST", `/patients/${pid}/consents`, {
      ...base,
      type: "COMMUNICATION_MARKETING",
      status: "DECLINED",
    });
    expect(mgr.status).toBe(201);
    expect(mgr.body.grantedAt).toBeNull();
    expect(
      (await call(REC, "POST", `/patients/${pid}/consents`, { ...base, type: "NOPE" })).status,
    ).toBe(400);

    const w = await call(REC, "POST", `/patients/${pid}/consents/${ok.body.id}/withdraw`, {
      reason: "Patient request",
    });
    expect(w.status).toBe(200);
    expect(
      (await admin.patientConsent.findUniqueOrThrow({ where: { id: ok.body.id } }))
        .withdrawalReason,
    ).toBe("Patient request");
    expect(w.body.status).toBe("WITHDRAWN");
    expect(w.body.withdrawnAt).toBeString();
    expect(
      (await call(REC, "POST", `/patients/${pid}/consents/${ok.body.id}/withdraw`, {})).status,
    ).toBe(409);
    const list = await call(DENTIST, "GET", `/patients/${pid}/consents`);
    expect(list.body.items.length).toBe(3);
    expect(await auditCount("patient.consent.withdraw", ok.body.id)).toBe(1);
  });

  test("communication preferences upsert per channel/purpose", async () => {
    const path = `/patients/${pid}/communication-preferences`;
    const r1 = await call(REC, "PUT", path, {
      preferences: [
        { channel: "WHATSAPP", purpose: "REMINDER", optIn: true },
        { channel: "SMS", optIn: true },
      ],
    });
    expect(r1.status).toBe(200);
    expect(r1.body.items.length).toBe(2);
    const r2 = await call(REC, "PUT", path, {
      preferences: [{ channel: "WHATSAPP", purpose: "REMINDER", optIn: false }],
    });
    expect(r2.body.items.length).toBe(2);
    expect(
      r2.body.items.find((x: J) => x.channel === "WHATSAPP" && x.purpose === "REMINDER").optIn,
    ).toBe(false);
    expect((await call(ACCT, "GET", path)).status).toBe(200);
    expect((await call(ACCT, "PUT", path, { preferences: [] })).status).toBe(403);
  });
});

describe("enquiries", () => {
  test("create, list, update status, convert with duplicate check", async () => {
    const ph = phone();
    expect(
      (await call(REC, "POST", "/enquiries", { name: "No Contact", source: "PHONE" })).status,
    ).toBe(400);
    const e = await call(REC, "POST", "/enquiries", {
      name: `Lead ${sfx}`,
      phone: ph,
      source: "WEBSITE",
      areaOfInterest: "Aligners",
      branchId: a1,
    });
    expect(e.status).toBe(201);
    expect(e.body.status).toBe("NEW");
    const list = await call(REC, "GET", "/enquiries?status=NEW");
    expect(list.body.items.map((x: J) => x.id)).toContain(e.body.id);
    const upd = await call(REC, "PATCH", `/enquiries/${e.body.id}`, { status: "CONTACTED" });
    expect(upd.status).toBe(200);
    expect(upd.body.status).toBe("CONTACTED");
    expect(
      (await call(REC, "PATCH", `/enquiries/${e.body.id}`, { status: "CONVERTED" })).status,
    ).toBe(400);

    // A patient already exists with this phone and name: convert warns first.
    const existing = await newPatient({ firstName: "Lead", lastName: sfx, phone: ph });
    const warn = await call(REC, "POST", `/enquiries/${e.body.id}/convert`, {
      originBranchId: a1,
      firstName: "Lead",
      lastName: sfx,
      phone: ph,
    });
    expect(warn.status).toBe(409);
    expect(warn.body.matches[0].patient.id).toBe(existing.id);
    // Link to the existing patient instead of creating a second record.
    const link = await call(REC, "POST", `/enquiries/${e.body.id}/convert`, {
      existingPatientId: existing.id,
    });
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ patientId: existing.id, created: false });
    const after = await call(REC, "GET", `/enquiries/${e.body.id}`);
    expect(after.body).toMatchObject({ status: "CONVERTED", convertedPatientId: existing.id });
    expect(
      (
        await call(REC, "POST", `/enquiries/${e.body.id}/convert`, {
          existingPatientId: existing.id,
        })
      ).status,
    ).toBe(409);
    expect((await call(REC, "PATCH", `/enquiries/${e.body.id}`, { notes: "x" })).status).toBe(409);
  });

  test("convert into a new patient sets convertedPatientId and intake ENQUIRY", async () => {
    const e = await call(REC, "POST", "/enquiries", {
      name: `Fresh ${sfx}`,
      email: `fresh-${sfx.toLowerCase()}@example.com`,
      source: "REFERRAL",
    });
    const c = await call(REC, "POST", `/enquiries/${e.body.id}/convert`, {
      originBranchId: a1,
      firstName: "Fresh",
      lastName: `Lead${sfx}`,
      email: `fresh-${sfx.toLowerCase()}@example.com`,
    });
    expect(c.status).toBe(200);
    expect(c.body.created).toBe(true);
    expect(c.body.patient.intakeType).toBe("ENQUIRY");
    const row = await admin.patientEnquiry.findUniqueOrThrow({ where: { id: e.body.id } });
    expect(row).toMatchObject({ status: "CONVERTED", convertedPatientId: c.body.patientId });
  });

  test("branch-scoped users do not see other branches' enquiries", async () => {
    const e = await call(OWNER, "POST", "/enquiries", {
      name: `Other ${sfx}`,
      phone: phone(),
      source: "SOCIAL",
      branchId: a2,
    });
    expect(e.status).toBe(201);
    expect((await call(REC, "GET", `/enquiries/${e.body.id}`)).status).toBe(404);
    const list = await call(REC, "GET", "/enquiries?limit=100");
    expect(list.body.items.map((x: J) => x.id)).not.toContain(e.body.id);
  });
});

describe("controlled merge", () => {
  const tag = `Mrg${sfx}`.toLowerCase();
  let survivor: J;
  let merged: J;
  let third: J;
  let ph: string;
  let pairId: string;
  let mergedHistoryId: string;
  let allergyId: string;

  beforeAll(async () => {
    ph = phone();
    survivor = await newPatient({
      firstName: "Zubin",
      lastName: `Mistry${tag}`,
      phone: ph,
      dob: "1979-02-03",
    });
    merged = await newPatient({
      firstName: "Zubin",
      lastName: `Mistry${tag}`,
      phone: ph,
      email: `zubin-${tag}@example.com`,
      dob: "1979-02-03",
      acknowledgeDuplicates: true,
    });
    // Third record: a likely duplicate of the merged one only (same name + email, no phone/dob).
    third = await newPatient({
      firstName: "Zubin",
      lastName: `Mistry${tag}`,
      email: `zubin-${tag}@example.com`,
      acknowledgeDuplicates: true,
    });
    const [a, b] = [survivor.id, merged.id].sort();
    pairId = (
      await admin.duplicateCandidate.findUniqueOrThrow({
        where: { tenantId_patientAId_patientBId: { tenantId: tA, patientAId: a, patientBId: b } },
      })
    ).id;
    // Children on the record that will be merged away.
    mergedHistoryId = (
      await call(DENTIST, "POST", `/patients/${merged.id}/medical-history`, {
        medical: { asthma: true },
      })
    ).body.id;
    allergyId = (
      await call(DENTIST, "POST", `/patients/${merged.id}/allergies`, { substance: "Latex" })
    ).body.id;
    await call(DENTIST, "POST", `/patients/${merged.id}/alerts`, {
      title: "Needle phobia",
      severity: "LOW",
    });
    await call(REC, "POST", `/patients/${merged.id}/consents`, {
      type: "DATA_PROCESSING",
      version: "v1",
      status: "GRANTED",
      method: "PAPER",
    });
    await call(REC, "PUT", `/patients/${merged.id}/communication-preferences`, {
      preferences: [{ channel: "EMAIL", optIn: true }],
    });
    await call(REC, "PUT", `/patients/${survivor.id}/communication-preferences`, {
      preferences: [{ channel: "SMS", optIn: true }],
    });
    // Enquiry converted to the merged record.
    const e = await call(REC, "POST", "/enquiries", { name: "Z", phone: ph, source: "PHONE" });
    await call(REC, "POST", `/enquiries/${e.body.id}/convert`, { existingPatientId: merged.id });
  });

  test("preview shows conflicts, counts and the pending candidate", async () => {
    const r = await call(
      MANAGER,
      "GET",
      `/patient-merges/preview?survivorId=${survivor.id}&mergedId=${merged.id}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.blockers).toEqual([]);
    expect(r.body.conflicts.map((c: J) => c.field)).toEqual(["email"]);
    expect(r.body.counts).toMatchObject({
      allergies: 1,
      alerts: 1,
      consents: 1,
      communicationPreferences: 1,
      enquiries: 1,
      medicalHistoryVersions: 1,
    });
    expect(r.body.counts.duplicateCandidates).toBeGreaterThanOrEqual(2);
    expect(r.body.duplicateCandidate).toMatchObject({ id: pairId, status: "PENDING" });
  });

  test("rejects self-merge (400), cross-tenant ids (404) and stale sign-in (401)", async () => {
    const self = await call(MANAGER, "POST", "/patient-merges", {
      survivorId: survivor.id,
      mergedId: survivor.id,
      reason: "duplicate registration",
    });
    expect(self.status).toBe(400);
    const foreign = await newPatient(
      { firstName: "Foreign", phone: phone(), originBranchId: b1 },
      OWNER_B,
      tB,
    );
    const cross = await call(MANAGER, "POST", "/patient-merges", {
      survivorId: survivor.id,
      mergedId: foreign.id,
      reason: "duplicate registration",
    });
    expect(cross.status).toBe(404);
    const stale = await call(
      MANAGER,
      "POST",
      "/patient-merges",
      { survivorId: survivor.id, mergedId: merged.id, reason: "duplicate registration" },
      { tokenExtra: { auth_time: Math.floor(Date.now() / 1000) - 3600 } },
    );
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe("reauth_required");
  });

  test("executes: children re-pointed, history visible via survivor, record + audit written", async () => {
    const r = await call(MANAGER, "POST", "/patient-merges", {
      survivorId: survivor.id,
      mergedId: merged.id,
      duplicateCandidateId: pairId,
      reason: "Same person registered twice",
      fieldChoices: { email: "merged" },
    });
    expect(r.status).toBe(201);
    expect(r.body.mergeRecord).toMatchObject({
      survivorId: survivor.id,
      mergedId: merged.id,
      performedBy: MANAGER,
      approvedBy: null,
    });
    expect(r.body.survivor.email).toBe(`zubin-${tag}@example.com`);
    expect(r.body.repointed).toMatchObject({
      allergies: 1,
      alerts: 1,
      consents: 1,
      enquiries: 1,
      communicationPreferences: 1,
    });

    // Tombstone points at survivor; children moved; survivor reads include merged history.
    const tomb = await call(REC, "GET", `/patients/${merged.id}`);
    expect(tomb.body.mergedIntoId).toBe(survivor.id);
    const allergies = await call(DENTIST, "GET", `/patients/${survivor.id}/allergies`);
    expect(allergies.body.items.map((x: J) => x.id)).toContain(allergyId);
    expect((await call(DENTIST, "GET", `/patients/${survivor.id}/alerts`)).body.items.length).toBe(
      1,
    );
    const hist = await call(DENTIST, "GET", `/patients/${survivor.id}/medical-history`);
    expect(hist.body.versions.map((v: J) => v.id)).toContain(mergedHistoryId);
    expect(hist.body.latest.patientId).toBe(merged.id);
    const prefs = await call(REC, "GET", `/patients/${survivor.id}/communication-preferences`);
    expect(prefs.body.items.map((x: J) => x.channel).sort()).toEqual(["EMAIL", "SMS"]);
    expect((await call(REC, "GET", `/patients/${survivor.id}/consents`)).body.items.length).toBe(1);
    const enq = await admin.patientEnquiry.findMany({
      where: { tenantId: tA, convertedPatientId: merged.id },
    });
    expect(enq).toEqual([]);

    const rec = await admin.patientMergeRecord.findUniqueOrThrow({
      where: { id: r.body.mergeRecord.id },
    });
    expect(rec.duplicateCandidateId).toBe(pairId);
    expect((rec.snapshot as J).moved.allergies).toEqual([allergyId]);
    expect((rec.snapshot as J).moved.medicalHistoryRetained).toEqual([mergedHistoryId]);
    expect(await auditCount("patient.merge", rec.id)).toBe(1);

    const pair = await admin.duplicateCandidate.findUniqueOrThrow({ where: { id: pairId } });
    expect(pair).toMatchObject({
      status: "MERGED",
      reviewedBy: MANAGER,
      reviewReason: "Same person registered twice",
    });
    // The merged↔third pair now concerns survivor↔third (ordered A<B).
    const [a, b] = [survivor.id, third.id].sort();
    const moved = await admin.duplicateCandidate.findUnique({
      where: { tenantId_patientAId_patientBId: { tenantId: tA, patientAId: a, patientBId: b } },
    });
    expect(moved).not.toBeNull();
    expect(
      await admin.duplicateCandidate.count({
        where: {
          tenantId: tA,
          status: "PENDING",
          OR: [{ patientAId: merged.id }, { patientBId: merged.id }],
        },
      }),
    ).toBe(0);

    const history = await call(REC, "GET", `/patients/${survivor.id}/merges`);
    expect(history.body.items.map((x: J) => x.id)).toEqual([rec.id]);
  });

  test("merged patient is read-only: writes 409 with survivor pointer", async () => {
    const upd = await call(REC, "PATCH", `/patients/${merged.id}`, { city: "Goa" });
    expect(upd.status).toBe(409);
    expect(upd.body).toMatchObject({ error: "patient_merged", survivorId: survivor.id });
    expect(
      (await call(DENTIST, "POST", `/patients/${merged.id}/allergies`, { substance: "X" })).status,
    ).toBe(409);
    expect((await call(DENTIST, "POST", `/patients/${merged.id}/medical-history`, {})).status).toBe(
      409,
    );
    expect(
      (await call(REC, "POST", `/patients/${merged.id}/lifecycle`, { stage: "ACTIVE" })).status,
    ).toBe(409);
  });

  test("rejects re-merging a tombstone or merging into one", async () => {
    const again = await call(MANAGER, "POST", "/patient-merges", {
      survivorId: survivor.id,
      mergedId: merged.id,
      reason: "duplicate registration",
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_merged");
    const into = await call(MANAGER, "POST", "/patient-merges", {
      survivorId: merged.id,
      mergedId: third.id,
      reason: "duplicate registration",
    });
    expect(into.status).toBe(409);
    expect(into.body).toMatchObject({ error: "survivor_already_merged", survivorId: survivor.id });
  });

  test("search hides merged records unless includeMerged", async () => {
    const q = `q=${encodeURIComponent(`zubin mistry${tag}`)}`;
    const def = await call(REC, "GET", `/patients?${q}`);
    expect(def.body.items.map((x: J) => x.id)).not.toContain(merged.id);
    expect(def.body.items.map((x: J) => x.id)).toContain(survivor.id);
    const all = await call(REC, "GET", `/patients?${q}&includeMerged=true`);
    expect(all.body.items.map((x: J) => x.id)).toContain(merged.id);
    const check = await call(REC, "POST", "/patients/duplicate-check", {
      firstName: "Zubin",
      lastName: `Mistry${tag}`,
      phone: ph,
    });
    expect(check.body.matches.map((m: J) => m.patient.id)).not.toContain(merged.id);
  });
});
