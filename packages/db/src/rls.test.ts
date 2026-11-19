import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { withTenant } from "./index";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/dentalos";
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//dentalos_app:dentalos_app@");
const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
let a: string;
let b: string;
let branchA: string;
let branchB: string;

beforeAll(async () => {
  a = (await admin.tenant.create({ data: { name: "A" } })).id;
  b = (await admin.tenant.create({ data: { name: "B" } })).id;
  branchA = (await admin.branch.create({ data: { tenantId: a, code: "A1", name: "A1" } })).id;
  branchB = (await admin.branch.create({ data: { tenantId: b, code: "B1", name: "B1" } })).id;
});
afterAll(async () => {
  await admin.$disconnect();
  await app.$disconnect();
});

test("tenant A only sees its own branches", async () => {
  const rows = await withTenant(app, a, (tx) => tx.branch.findMany());
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.tenantId === a)).toBe(true);
});

test("missing tenant context returns nothing (fails closed)", async () => {
  expect(await app.branch.findMany()).toHaveLength(0);
});

test("invalid tenant id is rejected before any query", async () => {
  await expect(withTenant(app, "x' OR 1=1 --", (tx) => tx.branch.findMany())).rejects.toThrow();
});

test("cannot insert a row for another tenant", async () => {
  await expect(
    withTenant(app, a, (tx) =>
      tx.branch.create({ data: { tenantId: b, code: "EVIL", name: "evil" } }),
    ),
  ).rejects.toThrow();
});

test("audit events are append-only for app role", async () => {
  await withTenant(app, a, (tx) =>
    tx.auditEvent.create({
      data: {
        tenantId: a,
        actorId: "u",
        action: "x",
        resource: "r",
        outcome: "ok",
        source: "test",
      },
    }),
  );
  await expect(withTenant(app, a, (tx) => tx.auditEvent.deleteMany())).rejects.toThrow();
});

test("every public table enforces FORCE RLS with at least one policy (meta-test)", async () => {
  const rows = await admin.$queryRaw<
    { relname: string; rls: boolean; forced: boolean; policies: bigint; hasTenantCol: boolean }[]
  >`
    SELECT c.relname,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           EXISTS (SELECT 1 FROM information_schema.columns k
                    WHERE k.table_schema = 'public' AND k.table_name = c.relname
                      AND k.column_name = 'tenantId') AS "hasTenantCol"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(`${r.relname}: rls=${r.rls} forced=${r.forced}`).toBe(
      `${r.relname}: rls=true forced=true`,
    );
    expect(Number(r.policies)).toBeGreaterThan(0);
    // Every table is tenant-owned, except the Tenant root itself.
    expect(r.relname === "Tenant" || r.hasTenantCol).toBe(true);
  }
});

const ev = (tenantId: string, action: string) => ({
  tenantId,
  actorId: "u",
  action,
  resource: "r",
  outcome: "success",
  source: "test",
});

test("audit hash chain links events, survives concurrency, and detects tampering", async () => {
  const t = (await admin.tenant.create({ data: { name: "chain" } })).id;
  await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      withTenant(app, t, (tx) => tx.auditEvent.create({ data: ev(t, `a${i}`) })),
    ),
  );
  const verify = async () =>
    (await admin.$queryRaw<{ v: bigint | null }[]>`SELECT verify_audit_chain(${t}::uuid) AS v`)[0]
      ?.v;
  const rows = await admin.auditEvent.findMany({
    where: { tenantId: t },
    orderBy: { chainPos: "asc" },
  });
  expect(rows.map((r) => Number(r.chainPos))).toEqual([1, 2, 3, 4, 5]);
  expect(rows[0]?.prevHash).toBeNull();
  expect(rows[1]?.prevHash).toBe(rows[0]?.hash ?? "");
  expect(await verify()).toBeNull();

  // Privileged tamper (the app role cannot UPDATE/DELETE) must be detected.
  await admin.$executeRaw`UPDATE "AuditEvent" SET "outcome" = 'denied' WHERE "tenantId" = ${t}::uuid AND "chainPos" = 3`;
  expect(Number(await verify())).toBe(3);
});

test("chain is per tenant and the app role cannot forge chain fields' integrity", async () => {
  await expect(
    withTenant(app, a, (tx) => tx.auditEvent.updateMany({ data: { hash: "x" } })),
  ).rejects.toThrow();
});

test("withTenant exposes actor id to the session", async () => {
  const actor = await withTenant(
    app,
    a,
    (tx) => tx.$queryRaw<{ v: string }[]>`SELECT current_setting('app.actor_id', true) AS v`,
    { actorId: "user-42" },
  );
  expect(actor[0]?.v).toBe("user-42");
});

test("setRolePassword rotates a role's password safely (quotes in the secret are inert)", async () => {
  const { setRolePassword } = await import("./role-password");
  await admin.$executeRawUnsafe("DROP ROLE IF EXISTS dentalos_pw_probe");
  await admin.$executeRawUnsafe("CREATE ROLE dentalos_pw_probe LOGIN PASSWORD 'old'");
  const secret = `p'a"ss;--\\${"x".repeat(24)}`;
  await setRolePassword(ADMIN_URL, "dentalos_pw_probe", secret);
  const probe = new PrismaClient({
    datasources: {
      db: {
        url: ADMIN_URL.replace(/\/\/[^@]+@/, `//dentalos_pw_probe:${encodeURIComponent(secret)}@`),
      },
    },
  });
  expect((await probe.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`)[0]?.ok).toBe(1);
  await probe.$disconnect();
  await expect(setRolePassword(ADMIN_URL, "x; DROP ROLE y", "z".repeat(30))).rejects.toThrow();
  await expect(setRolePassword(ADMIN_URL, "dentalos_pw_probe", "short")).rejects.toThrow();
  await admin.$executeRawUnsafe("DROP ROLE dentalos_pw_probe");
});

// --- M1 tables ---------------------------------------------------------------------------------
const patient = (tenantId: string, originBranchId: string, first = "Asha") => ({
  tenantId,
  originBranchId,
  firstName: first,
  nameNormalized: first.toLowerCase(),
  intakeType: "WALK_IN" as const,
  createdBy: "u",
});

test("patients are tenant-isolated and cannot reference another tenant's branch", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  expect(
    await withTenant(app, b, (tx) => tx.patient.findUnique({ where: { id: p.id } })),
  ).toBeNull();
  // Composite FK (tenantId, originBranchId) -> Branch(tenantId, id): a guessed foreign UUID is rejected.
  await expect(
    withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchB) })),
  ).rejects.toThrow();
});

test("child rows cannot point at another tenant's patient (composite FK)", async () => {
  const pb = await withTenant(app, b, (tx) => tx.patient.create({ data: patient(b, branchB) }));
  await expect(
    withTenant(app, a, (tx) =>
      tx.patientAlert.create({
        data: { tenantId: a, patientId: pb.id, title: "x", severity: "HIGH", createdBy: "u" },
      }),
    ),
  ).rejects.toThrow();
});

test("medical history is append-only and patients cannot be hard-deleted by the app role", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const h = await withTenant(app, a, (tx) =>
    tx.patientMedicalHistory.create({
      data: { tenantId: a, patientId: p.id, version: 1, recordedBy: "u" },
    }),
  );
  await expect(
    withTenant(app, a, (tx) =>
      tx.patientMedicalHistory.update({ where: { id: h.id }, data: { notes: "rewrite" } }),
    ),
  ).rejects.toThrow();
  await expect(
    withTenant(app, a, (tx) => tx.patient.delete({ where: { id: p.id } })),
  ).rejects.toThrow();
});

test("only one open price override per service+branch; history rows allowed", async () => {
  const s = await withTenant(app, a, (tx) =>
    tx.service.create({
      data: {
        tenantId: a,
        code: `S-${Date.now()}`,
        name: "Scaling",
        durationMin: 30,
        basePricePaise: 150000,
      },
    }),
  );
  const ov = (closed: boolean) => ({
    tenantId: a,
    serviceId: s.id,
    branchId: branchA,
    pricePaise: 120000,
    reason: "local market",
    setBy: "u",
    effectiveFrom: new Date(Date.now() - 86_400_000),
    effectiveTo: closed ? new Date() : null,
  });
  await withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(true) }));
  await withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(false) }));
  await expect(
    withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(false) })),
  ).rejects.toThrow();
});

test("pg_trgm similarity search works on normalised patient names", async () => {
  await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA, "Priyanka") }));
  const rows = await withTenant(
    app,
    a,
    (tx) => tx.$queryRaw<{ n: string }[]>`
      SELECT "nameNormalized" AS n FROM "Patient"
       WHERE "nameNormalized" % ${"priyanka"} ORDER BY similarity("nameNormalized", ${"priyanka"}) DESC`,
  );
  expect(rows[0]?.n).toBe("priyanka");
});

// --- M2 tables (0006_m2_clinical) --------------------------------------------------------------
const rid = () => crypto.randomUUID().slice(0, 8);
/** Dentist columns must reference a tenant member when written (trigger tenant_member_guard). */
const member = async (tenantId: string, userId = `dentist-${rid()}`) => {
  await admin.membership.create({ data: { tenantId, userId, roles: ["DENTIST"] } });
  return userId;
};
beforeAll(async () => {
  await member(a, "dentist-1");
  await member(a, "d");
});
const at = (hhmm: string) => new Date(`2031-03-04T${hhmm}:00Z`);
const appt = (
  tenantId: string,
  branchId: string,
  patientId: string,
  over: Record<string, unknown> = {},
) => ({
  tenantId,
  branchId,
  patientId,
  appointmentType: "CONSULTATION",
  startsAt: at("10:00"),
  endsAt: at("10:30"),
  createdBy: "u",
  ...over,
});

async function openEncounter(tenantId: string, branchId: string, dentist = "dentist-1") {
  const p = await withTenant(app, tenantId, (tx) =>
    tx.patient.create({ data: patient(tenantId, branchId) }),
  );
  const e = await withTenant(app, tenantId, (tx) =>
    tx.encounter.create({
      data: {
        tenantId,
        patientId: p.id,
        branchId,
        treatingDentistUserId: dentist,
        openedBy: dentist,
      },
    }),
  );
  return { patientId: p.id, encounterId: e.id };
}
const sign = (tenantId: string, encounterId: string, by = "dentist-1") =>
  withTenant(app, tenantId, (tx) =>
    tx.encounter.update({
      where: { id: encounterId },
      data: { status: "SIGNED", signedAt: new Date(), signedBy: by },
    }),
  );

test("exclusion constraints reject double-booking a dentist and a chair; inactive rows don't block", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const chair = await withTenant(app, a, (tx) =>
    tx.chair.create({
      data: { tenantId: a, branchId: branchA, code: `OP-${rid()}`.toUpperCase(), name: "Op" },
    }),
  );
  const dentist = await member(a);
  const book = (over: Record<string, unknown>) =>
    withTenant(app, a, (tx) => tx.appointment.create({ data: appt(a, branchA, p.id, over) }));

  const first = await book({ dentistUserId: dentist, chairId: chair.id });
  // Same dentist, overlapping (10:15–10:45), different/no chair -> 23P01.
  await expect(
    book({ dentistUserId: dentist, startsAt: at("10:15"), endsAt: at("10:45") }),
  ).rejects.toThrow(/23P01|Appointment_dentist_no_overlap/);
  // Same chair, other dentist -> 23P01.
  await expect(book({ dentistUserId: await member(a), chairId: chair.id })).rejects.toThrow(
    /Appointment_chair_no_overlap/,
  );
  // Back-to-back is fine (half-open ranges); unassigned bookings never conflict.
  await book({
    dentistUserId: dentist,
    chairId: chair.id,
    startsAt: at("10:30"),
    endsAt: at("11:00"),
  });
  await book({});
  await book({});
  // Cancelling frees the slot.
  await withTenant(app, a, (tx) =>
    tx.appointment.update({
      where: { id: first.id },
      data: { status: "CANCELLED", cancelReason: "patient called" },
    }),
  );
  await book({ dentistUserId: dentist, chairId: chair.id });
  // CANCELLED needs a reason (CHECK); ends must be after starts.
  await expect(book({ status: "CANCELLED" })).rejects.toThrow();
  await expect(book({ startsAt: at("11:00"), endsAt: at("11:00") })).rejects.toThrow();
});

test("a chair must belong to the appointment's branch (composite FK)", async () => {
  const other = (
    await admin.branch.create({
      data: { tenantId: a, code: `A-${rid()}`.toUpperCase(), name: "A2" },
    })
  ).id;
  const chair = await withTenant(app, a, (tx) =>
    tx.chair.create({ data: { tenantId: a, branchId: other, code: "OP-1", name: "Op" } }),
  );
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  await expect(
    withTenant(app, a, (tx) =>
      tx.appointment.create({ data: appt(a, branchA, p.id, { chairId: chair.id }) }),
    ),
  ).rejects.toThrow();
  // Lower-case chair codes are rejected (DB CHECK).
  await expect(
    withTenant(app, a, (tx) =>
      tx.chair.create({ data: { tenantId: a, branchId: other, code: "op-2", name: "Op" } }),
    ),
  ).rejects.toThrow();
});

test("appointments cannot reference another tenant's patient (composite FK)", async () => {
  const pb = await withTenant(app, b, (tx) => tx.patient.create({ data: patient(b, branchB) }));
  await expect(
    withTenant(app, a, (tx) => tx.appointment.create({ data: appt(a, branchA, pb.id) })),
  ).rejects.toThrow();
  // ...and an encounter cannot point at another patient's appointment.
  const pa = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const pa2 = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const ap = await withTenant(app, a, (tx) =>
    tx.appointment.create({
      data: appt(a, branchA, pa.id, { startsAt: at("15:00"), endsAt: at("15:30") }),
    }),
  );
  await expect(
    withTenant(app, a, (tx) =>
      tx.encounter.create({
        data: {
          tenantId: a,
          patientId: pa2.id,
          branchId: branchA,
          appointmentId: ap.id,
          treatingDentistUserId: "d",
          openedBy: "d",
        },
      }),
    ),
  ).rejects.toThrow();
});

test("working hours: scope subject CHECK and no overlapping sessions for the same dentist", async () => {
  const wh = (over: Record<string, unknown>) =>
    withTenant(app, a, (tx) =>
      tx.workingHours.create({
        data: {
          tenantId: a,
          branchId: branchA,
          scope: "DENTIST",
          weekday: 1,
          startMinute: 540,
          endMinute: 780,
          effectiveFrom: new Date("2031-01-01"),
          createdBy: "u",
          ...over,
        },
      }),
    );
  const dentist = await member(a);
  await wh({ userId: dentist });
  await wh({ userId: dentist, startMinute: 1020, endMinute: 1260 }); // evening session
  await expect(wh({ userId: dentist, startMinute: 720, endMinute: 900 })).rejects.toThrow(
    /WorkingHours_dentist_no_overlap/,
  );
  await expect(wh({})).rejects.toThrow(); // DENTIST scope needs userId
  await expect(wh({ userId: dentist, weekday: 7 })).rejects.toThrow();
});

test("append-only: appointment events, amendments, plan versions and consent template versions", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const ap = await withTenant(app, a, (tx) =>
    tx.appointment.create({
      data: appt(a, branchA, p.id, { startsAt: at("16:00"), endsAt: at("16:30") }),
    }),
  );
  const ev = await withTenant(app, a, (tx) =>
    tx.appointmentEvent.create({
      data: { tenantId: a, appointmentId: ap.id, toStatus: "BOOKED", actorId: "u" },
    }),
  );
  const { encounterId } = await openEncounter(a, branchA);
  await sign(a, encounterId);
  const am = await withTenant(app, a, (tx) =>
    tx.clinicalNoteAmendment.create({
      data: { tenantId: a, encounterId, body: "corrected", reason: "typo", authorId: "dentist-1" },
    }),
  );
  const plan = await withTenant(app, a, (tx) =>
    tx.treatmentPlan.create({
      data: { tenantId: a, patientId: p.id, branchId: branchA, title: "Plan", createdBy: "u" },
    }),
  );
  const pv = await withTenant(app, a, (tx) =>
    tx.treatmentPlanVersion.create({
      data: {
        tenantId: a,
        planId: plan.id,
        patientId: p.id,
        version: 1,
        snapshot: {},
        createdBy: "u",
      },
    }),
  );
  const tpl = await withTenant(app, a, (tx) =>
    tx.consentTemplate.create({
      data: {
        tenantId: a,
        code: `RCT-${rid()}`.toUpperCase(),
        type: "PROCEDURE",
        title: "RCT",
        createdBy: "u",
      },
    }),
  );
  const tv = await withTenant(app, a, (tx) =>
    tx.consentTemplateVersion.create({
      data: { tenantId: a, templateId: tpl.id, version: 1, body: "I consent", createdBy: "u" },
    }),
  );
  const tries: [
    string,
    (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>,
  ][] = [
    [
      "event update",
      (tx) => tx.appointmentEvent.update({ where: { id: ev.id }, data: { reason: "x" } }),
    ],
    ["event delete", (tx) => tx.appointmentEvent.delete({ where: { id: ev.id } })],
    [
      "amendment update",
      (tx) => tx.clinicalNoteAmendment.update({ where: { id: am.id }, data: { body: "x" } }),
    ],
    ["amendment delete", (tx) => tx.clinicalNoteAmendment.delete({ where: { id: am.id } })],
    [
      "plan version update",
      (tx) => tx.treatmentPlanVersion.update({ where: { id: pv.id }, data: { reason: "x" } }),
    ],
    ["plan version delete", (tx) => tx.treatmentPlanVersion.delete({ where: { id: pv.id } })],
    [
      "template version update",
      (tx) => tx.consentTemplateVersion.update({ where: { id: tv.id }, data: { body: "x" } }),
    ],
    ["template version delete", (tx) => tx.consentTemplateVersion.delete({ where: { id: tv.id } })],
    ["appointment delete", (tx) => tx.appointment.delete({ where: { id: ap.id } })],
    ["encounter delete", (tx) => tx.encounter.delete({ where: { id: encounterId } })],
  ];
  for (const [name, fn] of tries) {
    const ok = await withTenant(app, a, fn).then(
      () => true,
      () => false,
    );
    expect([name, ok]).toEqual([name, false]);
  }
});

test("signed encounters: notes, diagnoses and procedures are immutable; never reopened", async () => {
  const { patientId, encounterId } = await openEncounter(a, branchA);
  const note = await withTenant(app, a, (tx) =>
    tx.clinicalNote.create({
      data: { tenantId: a, encounterId, body: "draft", authorId: "dentist-1" },
    }),
  );
  // OPEN: editable; amendments are not allowed yet.
  await withTenant(app, a, (tx) =>
    tx.clinicalNote.update({ where: { id: note.id }, data: { body: "final" } }),
  );
  await expect(
    withTenant(app, a, (tx) =>
      tx.clinicalNoteAmendment.create({
        data: {
          tenantId: a,
          encounterId,
          noteId: note.id,
          body: "x",
          reason: "y",
          authorId: "dentist-1",
        },
      }),
    ),
  ).rejects.toThrow(/encounter_not_signed/);
  // Only the treating dentist can sign (CHECK).
  await expect(sign(a, encounterId, "someone-else")).rejects.toThrow();
  await sign(a, encounterId);

  await expect(
    withTenant(app, a, (tx) =>
      tx.clinicalNote.update({ where: { id: note.id }, data: { body: "rewrite" } }),
    ),
  ).rejects.toThrow(/encounter_signed/);
  await expect(
    withTenant(app, a, (tx) => tx.clinicalNote.delete({ where: { id: note.id } })),
  ).rejects.toThrow(/encounter_signed/);
  await expect(
    withTenant(app, a, (tx) =>
      tx.clinicalNote.create({
        data: { tenantId: a, encounterId, body: "late", authorId: "dentist-1" },
      }),
    ),
  ).rejects.toThrow(/encounter_signed/);
  await expect(
    withTenant(app, a, (tx) =>
      tx.diagnosis.create({
        data: {
          tenantId: a,
          encounterId,
          patientId,
          code: "K02.1",
          label: "Caries",
          diagnosedBy: "dentist-1",
        },
      }),
    ),
  ).rejects.toThrow(/encounter_signed/);
  await expect(
    withTenant(app, a, (tx) =>
      tx.encounter.update({
        where: { id: encounterId },
        data: { status: "OPEN", signedAt: null, signedBy: null },
      }),
    ),
  ).rejects.toThrow(/encounter_signed/);
  // Corrections go through amendments.
  await withTenant(app, a, (tx) =>
    tx.clinicalNoteAmendment.create({
      data: {
        tenantId: a,
        encounterId,
        noteId: note.id,
        body: "add: tooth 36",
        reason: "omission",
        authorId: "dentist-1",
      },
    }),
  );
  expect(
    (await withTenant(app, a, (tx) => tx.clinicalNote.findUnique({ where: { id: note.id } })))
      ?.body,
  ).toBe("final");
});

test("FDI CHECK rejects invalid teeth (19, 56) and surfaces; tooth history can only be superseded", async () => {
  const { patientId, encounterId } = await openEncounter(a, branchA);
  const tr = (over: Record<string, unknown>) =>
    withTenant(app, a, (tx) =>
      tx.toothRecord.create({
        data: {
          tenantId: a,
          patientId,
          encounterId,
          toothCode: 36,
          dentition: "PERMANENT",
          condition: "CARIES",
          surfaces: ["O", "M"],
          recordedBy: "dentist-1",
          ...over,
        },
      }),
    );
  const ok = await tr({});
  await tr({ toothCode: 55, dentition: "PRIMARY", surfaces: ["O", "P"] });
  await tr({ toothCode: 11, surfaces: ["I", "F", "P"] });
  for (const bad of [
    { toothCode: 19 },
    { toothCode: 56, dentition: "PRIMARY" },
    { toothCode: 10 },
    { toothCode: 55, dentition: "PERMANENT" }, // dentition must match the code
    { surfaces: ["I"] }, // molar has no incisal edge
    { surfaces: ["P"] }, // mandibular tooth: lingual, not palatal
    { surfaces: ["O", "O"] }, // duplicates
    { toothCode: 11, surfaces: ["O"] }, // incisor has no occlusal surface
  ]) {
    const rejected = await tr(bad).then(
      () => false,
      () => true,
    );
    expect([bad, rejected]).toEqual([bad, true]);
  }
  // Supersede: CURRENT -> HISTORICAL is the only allowed change; no deletes.
  await expect(
    withTenant(app, a, (tx) =>
      tx.toothRecord.update({ where: { id: ok.id }, data: { condition: "FILLED" } }),
    ),
  ).rejects.toThrow(/tooth_record_immutable/);
  await withTenant(app, a, (tx) =>
    tx.toothRecord.update({
      where: { id: ok.id },
      data: { status: "HISTORICAL", supersededAt: new Date(), supersededBy: "dentist-1" },
    }),
  );
  await expect(
    withTenant(app, a, (tx) =>
      tx.toothRecord.update({
        where: { id: ok.id },
        data: { status: "CURRENT", supersededAt: null },
      }),
    ),
  ).rejects.toThrow(/tooth_record_immutable/);
  await expect(
    withTenant(app, a, (tx) => tx.toothRecord.delete({ where: { id: ok.id } })),
  ).rejects.toThrow();
});

test("plan items: frozen-price CHECKs, deletable only from a never-presented draft", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const s = await withTenant(app, a, (tx) =>
    tx.service.create({
      data: {
        tenantId: a,
        code: `RCT-${rid()}`.toUpperCase(),
        name: "RCT",
        durationMin: 60,
        basePricePaise: 500000,
      },
    }),
  );
  const plan = await withTenant(app, a, (tx) =>
    tx.treatmentPlan.create({
      data: { tenantId: a, patientId: p.id, branchId: branchA, title: "Plan", createdBy: "u" },
    }),
  );
  const item = (over: Record<string, unknown> = {}) =>
    withTenant(app, a, (tx) =>
      tx.planItem.create({
        data: {
          tenantId: a,
          planId: plan.id,
          patientId: p.id,
          serviceId: s.id,
          toothCode: 46,
          surfaces: [],
          estimatePricePaise: 500000,
          priceSource: "BASE",
          createdBy: "u",
          ...over,
        },
      }),
    );
  const draft = await item();
  await expect(item({ estimatePricePaise: -1 })).rejects.toThrow();
  await expect(item({ priceSource: "GUESS" })).rejects.toThrow();
  await expect(item({ toothCode: null, surfaces: ["O"] })).rejects.toThrow();
  await withTenant(app, a, (tx) => tx.planItem.delete({ where: { id: draft.id } }));
  const kept = await item();
  await withTenant(app, a, (tx) =>
    tx.treatmentPlan.update({
      where: { id: plan.id },
      data: { status: "PRESENTED", currentVersion: 1 },
    }),
  );
  await expect(
    withTenant(app, a, (tx) => tx.planItem.delete({ where: { id: kept.id } })),
  ).rejects.toThrow(/plan_item_history/);
});

test("membership e-mail must be lower-case", async () => {
  await expect(
    Promise.resolve(
      admin.membership.create({
        data: { tenantId: a, userId: `u-${rid()}`, roles: ["DENTIST"], email: "Dr@Clinic.in" },
      }),
    ),
  ).rejects.toThrow();
  const m = await admin.membership.create({
    data: {
      tenantId: a,
      userId: `u-${rid()}`,
      roles: ["DENTIST"],
      email: "dr@clinic.in",
      displayName: "Dr A",
    },
  });
  expect(m.displayName).toBe("Dr A");
});

// --- Cross-patient links: every link between patient-owned rows carries patientId -------------
type AppTx = Parameters<Parameters<typeof withTenant>[2]>[0];
const inA = <T>(fn: (tx: AppTx) => Promise<T>) => withTenant(app, a, fn);

/** One patient with an appointment, an encounter, a plan (+ version 1) and a plan item. */
async function patientWithPlan(serviceId: string) {
  const p = await inA((tx) => tx.patient.create({ data: patient(a, branchA) }));
  const ap = await inA((tx) => tx.appointment.create({ data: appt(a, branchA, p.id) }));
  const enc = await inA((tx) =>
    tx.encounter.create({
      data: {
        tenantId: a,
        patientId: p.id,
        branchId: branchA,
        treatingDentistUserId: "dentist-1",
        openedBy: "dentist-1",
      },
    }),
  );
  const plan = await inA((tx) =>
    tx.treatmentPlan.create({
      data: { tenantId: a, patientId: p.id, branchId: branchA, title: "Plan", createdBy: "u" },
    }),
  );
  const version = await inA((tx) =>
    tx.treatmentPlanVersion.create({
      data: {
        tenantId: a,
        planId: plan.id,
        patientId: p.id,
        version: 1,
        snapshot: {},
        createdBy: "u",
      },
    }),
  );
  const item = await inA((tx) =>
    tx.planItem.create({
      data: {
        tenantId: a,
        planId: plan.id,
        patientId: p.id,
        serviceId,
        estimatePricePaise: 100000,
        priceSource: "BASE",
        createdBy: "u",
      },
    }),
  );
  return { patientId: p.id, appointmentId: ap.id, encounterId: enc.id, plan, version, item };
}

async function templateVersion() {
  const tpl = await inA((tx) =>
    tx.consentTemplate.create({
      data: {
        tenantId: a,
        code: `TP-${rid()}`.toUpperCase(),
        type: "TREATMENT_PLAN",
        title: "Plan consent",
        createdBy: "u",
      },
    }),
  );
  return inA((tx) =>
    tx.consentTemplateVersion.create({
      data: { tenantId: a, templateId: tpl.id, version: 1, body: "I consent", createdBy: "u" },
    }),
  );
}

test("cross-patient links are rejected by composite FKs (documents, plans, items, sessions, consent)", async () => {
  const svc = await inA((tx) =>
    tx.service.create({
      data: {
        tenantId: a,
        code: `XP-${rid()}`.toUpperCase(),
        name: "X",
        durationMin: 30,
        basePricePaise: 100000,
      },
    }),
  );
  const A = await patientWithPlan(svc.id);
  const B = await patientWithPlan(svc.id);
  const tv = await templateVersion();
  const doc = (patientId: string, encounterId: string) =>
    inA((tx) =>
      tx.patientDocument.create({
        data: {
          tenantId: a,
          patientId,
          branchId: branchA,
          storageKey: `t/${rid()}/${rid()}`,
          fileName: "xray.png",
          contentType: "image/png",
          sizeBytes: 10,
          uploadedBy: "u",
          encounterId,
        },
      }),
    );
  const consent = (patientId: string, planVersionId: string) =>
    inA((tx) =>
      tx.patientConsent.create({
        data: {
          tenantId: a,
          patientId,
          type: "TREATMENT_PLAN",
          version: "1",
          status: "GRANTED",
          capturedBy: "u",
          templateVersionId: tv.id,
          planVersionId,
        },
      }),
    );
  const session = (planItemId: string, patientId: string, over: Record<string, unknown>) =>
    inA((tx) =>
      tx.planItemSession.create({
        data: { tenantId: a, planItemId, patientId, sessionNo: 1, createdBy: "u", ...over },
      }),
    );
  const procedure = (encounterId: string, patientId: string, planItemId: string) =>
    inA((tx) =>
      tx.procedureRecord.create({
        data: {
          tenantId: a,
          encounterId,
          patientId,
          planItemId,
          serviceId: svc.id,
          performedBy: "dentist-1",
        },
      }),
    );

  // Same-patient links work.
  const docA = await doc(A.patientId, A.encounterId);
  await consent(A.patientId, A.version.id);
  await session(A.item.id, A.patientId, {
    appointmentId: A.appointmentId,
    encounterId: A.encounterId,
  });
  await procedure(A.encounterId, A.patientId, A.item.id);
  await inA((tx) =>
    tx.appointment.update({ where: { id: A.appointmentId }, data: { planItemId: A.item.id } }),
  );

  const attempts: [string, () => Promise<unknown>][] = [
    ["A's document on B's encounter (insert)", () => doc(A.patientId, B.encounterId)],
    [
      "A's document moved onto B's encounter (update)",
      () =>
        inA((tx) =>
          tx.patientDocument.update({
            where: { id: docA.id },
            data: { encounterId: B.encounterId },
          }),
        ),
    ],
    [
      "A's plan on B's encounter",
      () =>
        inA((tx) =>
          tx.treatmentPlan.create({
            data: {
              tenantId: a,
              patientId: A.patientId,
              branchId: branchA,
              encounterId: B.encounterId,
              title: "x",
              createdBy: "u",
            },
          }),
        ),
    ],
    [
      "item claiming another patient than its plan",
      () =>
        inA((tx) =>
          tx.planItem.create({
            data: {
              tenantId: a,
              planId: B.plan.id,
              patientId: A.patientId,
              serviceId: svc.id,
              estimatePricePaise: 1,
              priceSource: "BASE",
              createdBy: "u",
            },
          }),
        ),
    ],
    [
      "version claiming another patient than its plan",
      () =>
        inA((tx) =>
          tx.treatmentPlanVersion.create({
            data: {
              tenantId: a,
              planId: B.plan.id,
              patientId: A.patientId,
              version: 2,
              snapshot: {},
              createdBy: "u",
            },
          }),
        ),
    ],
    [
      "A's appointment linked to B's plan item",
      () =>
        inA((tx) =>
          tx.appointment.create({
            data: appt(a, branchA, A.patientId, { planItemId: B.item.id }),
          }),
        ),
    ],
    [
      "A's procedure completes B's plan item",
      () => procedure(A.encounterId, A.patientId, B.item.id),
    ],
    [
      "B's item session on A's appointment",
      () => session(B.item.id, B.patientId, { sessionNo: 2, appointmentId: A.appointmentId }),
    ],
    [
      "B's item session on A's encounter",
      () => session(B.item.id, B.patientId, { sessionNo: 3, encounterId: A.encounterId }),
    ],
    ["session claiming A for B's item", () => session(B.item.id, A.patientId, { sessionNo: 4 })],
    ["A's consent bound to B's plan version", () => consent(A.patientId, B.version.id)],
  ];
  for (const [name, fn] of attempts) {
    // Must fail on a foreign key (P2003), not incidentally on something else.
    const outcome = await fn().then(
      () => "allowed",
      (e: unknown) =>
        (e as { code?: string }).code === "P2003" ? "fk_violation" : String((e as Error).message),
    );
    expect([name, outcome]).toEqual([name, "fk_violation"]);
  }
});

test("template-only consent types need a template version; plan version iff TREATMENT_PLAN", async () => {
  const svc = await inA((tx) =>
    tx.service.create({
      data: {
        tenantId: a,
        code: `CS-${rid()}`.toUpperCase(),
        name: "X",
        durationMin: 30,
        basePricePaise: 1,
      },
    }),
  );
  const P = await patientWithPlan(svc.id);
  const tv = await templateVersion();
  const consent = (over: Record<string, unknown>) =>
    inA((tx) =>
      tx.patientConsent.create({
        data: {
          tenantId: a,
          patientId: P.patientId,
          type: "PROCEDURE",
          version: "1",
          status: "GRANTED",
          capturedBy: "u",
          ...over,
        },
      }),
    );
  // M1 free-form types keep working without a template.
  await consent({ type: "DATA_PROCESSING", method: "VERBAL" });
  await consent({ type: "CLINICAL_PHOTOGRAPHY" });
  await consent({ templateVersionId: tv.id });
  await consent({ type: "TREATMENT_PLAN", templateVersionId: tv.id, planVersionId: P.version.id });
  for (const bad of [
    { type: "PROCEDURE" },
    { type: "RADIOGRAPH" },
    { type: "COMMUNICATION" },
    { type: "TREATMENT_PLAN", templateVersionId: tv.id }, // no plan version
    { type: "TREATMENT_PLAN", planVersionId: P.version.id }, // no template version
    { type: "PROCEDURE", templateVersionId: tv.id, planVersionId: P.version.id }, // plan link on a non-plan type
  ]) {
    const rejected = await consent(bad).then(
      () => false,
      () => true,
    );
    expect([bad, rejected]).toEqual([bad, true]);
  }
});

test("dentist columns must be tenant members when written; removal keeps existing rows usable", async () => {
  const p = await inA((tx) => tx.patient.create({ data: patient(a, branchA) }));
  const otherTenantDentist = await member(b);
  const nonMember = `nobody-${rid()}`;
  const tries: [string, () => Promise<unknown>][] = [
    [
      "appointment dentist from another tenant",
      () =>
        inA((tx) =>
          tx.appointment.create({
            data: appt(a, branchA, p.id, { dentistUserId: otherTenantDentist }),
          }),
        ),
    ],
    [
      "encounter treating dentist not a member",
      () =>
        inA((tx) =>
          tx.encounter.create({
            data: {
              tenantId: a,
              patientId: p.id,
              branchId: branchA,
              treatingDentistUserId: nonMember,
              openedBy: nonMember,
            },
          }),
        ),
    ],
    [
      "working hours dentist not a member",
      () =>
        inA((tx) =>
          tx.workingHours.create({
            data: {
              tenantId: a,
              branchId: branchA,
              scope: "DENTIST",
              userId: otherTenantDentist,
              weekday: 2,
              startMinute: 540,
              endMinute: 600,
              effectiveFrom: new Date("2031-01-01"),
              createdBy: "u",
            },
          }),
        ),
    ],
  ];
  for (const [name, fn] of tries) {
    const err = await fn().then(
      () => "",
      (e: unknown) => String((e as Error).message),
    );
    expect([name, /not_a_member/.test(err)]).toEqual([name, true]);
  }

  // A removed member's existing appointment can still change status; re-assigning to them cannot.
  const dentist = await member(a);
  const ap = await inA((tx) =>
    tx.appointment.create({
      data: appt(a, branchA, p.id, {
        dentistUserId: dentist,
        startsAt: at("18:00"),
        endsAt: at("18:30"),
      }),
    }),
  );
  await admin.membership.delete({ where: { tenantId_userId: { tenantId: a, userId: dentist } } });
  await inA((tx) =>
    tx.appointment.update({
      where: { id: ap.id },
      data: { status: "CANCELLED", cancelReason: "dentist left" },
    }),
  );
  const other = await inA((tx) =>
    tx.appointment.create({
      data: appt(a, branchA, p.id, { startsAt: at("19:00"), endsAt: at("19:30") }),
    }),
  );
  await expect(
    inA((tx) =>
      tx.appointment.update({ where: { id: other.id }, data: { dentistUserId: dentist } }),
    ),
  ).rejects.toThrow(/not_a_member/);
});
