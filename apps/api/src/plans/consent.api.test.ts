import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient, withTenant } from "@dentalos/db";
import { code } from "../org/test-harness";
import { type World, seedDocument, seedPatient, seedService, startWorld } from "./test-fixtures";

// Consent templates (versioned, append-only), signing a TREATMENT_PLAN consent against the current
// plan version, and plan approval gated on it. Fresh random tenants; never deletes shared rows.

let w: World;
let app: PrismaClient;
let patient: string;
let otherPatient: string;
let svc: string;

// biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON responses in tests
type Res = { status: number; body: any };
const as =
  (user: () => string, tenant?: () => string) =>
  (method: string, path: string, body?: unknown): Promise<Res> =>
    w.h.call(method, path, { user: user(), tenant: tenant ? tenant() : w.tA, body });

const owner = as(() => w.users.owner);
const manager = as(() => w.users.manager);
const dentist = as(() => w.users.dentist);
const rec = as(() => w.users.rec);
const recA2 = as(() => w.users.recA2);
const acct = as(() => w.users.acct);
const ownerB = as(
  () => w.users.ownerB,
  () => w.tB,
);

beforeAll(async () => {
  w = await startWorld("CONSENT");
  app = new PrismaClient({
    datasources: {
      db: { url: "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos" },
    },
  });
  patient = await seedPatient(w.h, w.tA, w.a1, "Meera");
  otherPatient = await seedPatient(w.h, w.tA, w.a1, "Kiran");
  svc = await seedService(w.h, w.tA, 40_000);
});
afterAll(async () => {
  await app.$disconnect();
  await w.h.close();
});

async function template(type = "TREATMENT_PLAN") {
  const r = await owner("POST", "/consent-templates", {
    code: code("tp-"),
    type,
    title: "Treatment plan consent",
    body: "I consent to the treatment plan explained to me.",
  });
  expect(r.status).toBe(201);
  return r.body;
}

/** Presented plan with every item accepted (status ACCEPTED). */
async function acceptedPlan(pt = patient, tenantCall = dentist, branchId = w.a1, service = svc) {
  const c = await tenantCall("POST", "/plans", {
    patientId: pt,
    branchId,
    title: "Plan",
    items: [{ serviceId: service }],
  });
  expect(c.status).toBe(201);
  await tenantCall("POST", `/plans/${c.body.id}/present`, {});
  const d = await tenantCall("POST", `/plans/${c.body.id}/decisions`, {
    decisions: [{ itemId: c.body.items[0].id, decision: "ACCEPTED" }],
  });
  expect(d.body.status).toBe("ACCEPTED");
  return d.body;
}

async function currentVersionId(planId: string) {
  const vs = await dentist("GET", `/plans/${planId}/versions`);
  return vs.body.items.at(-1).id as string;
}

describe("consent templates", () => {
  test("owner creates (v1); others cannot; readers list", async () => {
    const t = await template();
    expect(t).toMatchObject({ type: "TREATMENT_PLAN", active: true, currentVersion: 1 });
    expect(t.code).toBe(t.code.toUpperCase());
    expect(t.currentVersionId).toBeString();

    for (const who of [dentist, rec, manager])
      expect(
        (
          await who("POST", "/consent-templates", {
            code: code("x-"),
            type: "PROCEDURE",
            title: "x",
            body: "x",
          })
        ).status,
      ).toBe(403);
    expect((await dentist("PATCH", `/consent-templates/${t.id}`, { title: "x" })).status).toBe(403);
    expect((await rec("POST", `/consent-templates/${t.id}/versions`, { body: "x" })).status).toBe(
      403,
    );
    expect((await rec("GET", "/consent-templates?type=TREATMENT_PLAN")).status).toBe(200);
    expect((await acct("GET", "/consent-templates")).status).toBe(403);

    const dup = await owner("POST", "/consent-templates", {
      code: t.code,
      type: "PROCEDURE",
      title: "dup",
      body: "dup",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("template_code_taken");
  });

  test("versions are append-only; publishing never rewrites earlier text", async () => {
    const t = await template("PROCEDURE");
    const v2 = await owner("POST", `/consent-templates/${t.id}/versions`, { body: "Revised text" });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const vs = await rec("GET", `/consent-templates/${t.id}/versions`);
    expect(
      vs.body.items.map((v: { version: number; body: string }) => [v.version, v.body]),
    ).toEqual([
      [2, "Revised text"],
      [1, "I consent to the treatment plan explained to me."],
    ]);
    const got = await rec("GET", `/consent-templates/${t.id}`);
    expect(got.body).toMatchObject({ currentVersion: 2, currentVersionId: v2.body.id });

    // No route edits a version, and the app role cannot UPDATE / DELETE one.
    expect(
      (await owner("PATCH", `/consent-templates/${t.id}/versions/${v2.body.id}`, {})).status,
    ).toBe(404);
    const upd = await withTenant(app, w.tA, (tx) =>
      tx.consentTemplateVersion.updateMany({ where: { templateId: t.id }, data: { body: "x" } }),
    ).catch((e) => e);
    expect(String(upd?.message ?? upd)).toMatch(/permission denied/i);
    const del = await withTenant(app, w.tA, (tx) =>
      tx.consentTemplateVersion.deleteMany({ where: { templateId: t.id } }),
    ).catch((e) => e);
    expect(String(del?.message ?? del)).toMatch(/permission denied/i);
  });

  test("activate / deactivate; active filter", async () => {
    const t = await template("RADIOGRAPH");
    const off = await owner("POST", `/consent-templates/${t.id}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const inactive = await rec("GET", "/consent-templates?active=false");
    expect(inactive.body.items.map((x: { id: string }) => x.id)).toContain(t.id);
    const active = await rec("GET", "/consent-templates?active=true");
    expect(active.body.items.map((x: { id: string }) => x.id)).not.toContain(t.id);
    const on = await owner("POST", `/consent-templates/${t.id}/activate`);
    expect(on.body.active).toBe(true);
    const renamed = await owner("PATCH", `/consent-templates/${t.id}`, { title: "X-ray consent" });
    expect(renamed.body).toMatchObject({ title: "X-ray consent", currentVersion: 1 });
    expect((await ownerB("GET", `/consent-templates/${t.id}`)).status).toBe(404);
  });
});

describe("signing a plan consent and approving the plan", () => {
  test("approval blocked without consent, allowed after signing the current version", async () => {
    const t = await template();
    const plan = await acceptedPlan();
    const blocked = await dentist("POST", `/plans/${plan.id}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "consent_required", version: plan.currentVersion });

    const doc = await seedDocument(w.h, w.tA, patient, w.a1);
    const pv = await currentVersionId(plan.id);
    expect(blocked.body.planVersionId).toBe(pv);
    const signed = await rec("POST", `/patients/${patient}/consents/sign`, {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      planVersionId: pv,
      signatureDocumentId: doc,
      signerRelationship: "GUARDIAN",
      signerName: "Parent Name",
    });
    expect(signed.status).toBe(201);
    expect(signed.body).toMatchObject({
      type: "TREATMENT_PLAN",
      version: "1",
      status: "GRANTED",
      method: "DIGITAL",
      branchId: w.a1,
      documentId: doc,
      capturedBy: w.users.rec,
      templateVersionId: t.currentVersionId,
      planVersionId: pv,
      signerRelationship: "GUARDIAN",
      signerName: "Parent Name",
    });

    // Receptionist cannot approve (plan:approve); the dentist can.
    expect((await rec("POST", `/plans/${plan.id}/approve`, {})).status).toBe(403);
    const ok = await dentist("POST", `/plans/${plan.id}/approve`, { consentId: signed.body.id });
    expect(ok.status).toBe(200);
    expect(ok.body.approvedBy).toBe(w.users.dentist);
    expect(ok.body.approvedAt).toBeString();
    expect(ok.body.currentVersion).toBe(plan.currentVersion); // approval takes no version
    const twice = await dentist("POST", `/plans/${plan.id}/approve`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe("already_approved");

    const list = await rec("GET", `/plans/${plan.id}/consents`);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([signed.body.id]);
    // The M1 consent list sees it too.
    const m1 = await rec("GET", `/patients/${patient}/consents`);
    expect(m1.body.items.map((c: { id: string }) => c.id)).toContain(signed.body.id);

    // A later change makes a new version: the old consent no longer covers it.
    await dentist("PATCH", `/plans/${plan.id}`, { title: "Plan v2", reason: "scope change" });
    const stale = await dentist("POST", `/plans/${plan.id}/approve`, { consentId: signed.body.id });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("consent_required");
    const staleSign = await rec("POST", `/patients/${patient}/consents/sign`, {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      planVersionId: pv,
      signatureDocumentId: doc,
    });
    expect(staleSign.status).toBe(409);
    expect(staleSign.body.error).toBe("plan_version_not_current");
  });

  test("approval needs a decided plan", async () => {
    const c = await dentist("POST", "/plans", {
      patientId: patient,
      branchId: w.a1,
      title: "Undecided",
      items: [{ serviceId: svc }],
    });
    await dentist("POST", `/plans/${c.body.id}/present`, {});
    const r = await dentist("POST", `/plans/${c.body.id}/approve`, {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "plan_not_decided", status: "PRESENTED" });
  });

  test("consent tied to another patient's plan version is rejected (composite FK)", async () => {
    const t = await template();
    const plan = await acceptedPlan(otherPatient);
    const pv = await currentVersionId(plan.id);
    const doc = await seedDocument(w.h, w.tA, patient, w.a1);
    const r = await rec("POST", `/patients/${patient}/consents/sign`, {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      planVersionId: pv,
      signatureDocumentId: doc,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("plan_version_patient_mismatch");
    // The database refuses it directly as well (tenantId, planVersionId, patientId).
    const direct = await withTenant(app, w.tA, (tx) =>
      tx.patientConsent.create({
        data: {
          tenantId: w.tA,
          patientId: patient,
          type: "TREATMENT_PLAN",
          version: "1",
          status: "GRANTED",
          capturedBy: w.users.rec,
          templateVersionId: t.currentVersionId,
          planVersionId: pv,
        },
      }),
    ).catch((e) => e);
    expect(direct?.code).toBe("P2003");
    expect((await dentist("POST", `/plans/${plan.id}/approve`, {})).status).toBe(409);
  });

  test("sign validation: template version, plan link, document, signer, branch", async () => {
    const t = await template();
    const plan = await acceptedPlan();
    const pv = await currentVersionId(plan.id);
    const doc = await seedDocument(w.h, w.tA, patient, w.a1);
    const base = {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      planVersionId: pv,
      signatureDocumentId: doc,
    };
    const sign = (body: unknown, who = rec, pt = patient) =>
      who("POST", `/patients/${pt}/consents/sign`, body);

    const noPlan = await sign({ ...base, planVersionId: undefined });
    expect(noPlan.status).toBe(400);
    expect(noPlan.body.issues[0].path).toBe("planVersionId");
    expect((await sign({ ...base, signerRelationship: "GUARDIAN" })).status).toBe(400);

    const foreignDoc = await seedDocument(w.h, w.tA, otherPatient, w.a1);
    const d1 = await sign({ ...base, signatureDocumentId: foreignDoc });
    expect(d1.status).toBe(404);
    expect(d1.body.error).toBe("document_not_found");
    const other = await seedDocument(w.h, w.tA, patient, w.a1, { category: "OTHER" });
    const d2 = await sign({ ...base, signatureDocumentId: other });
    expect(d2.status).toBe(409);
    expect(d2.body).toMatchObject({
      error: "invalid_signature_document",
      reason: "not_consent_form",
    });
    const pending = await seedDocument(w.h, w.tA, patient, w.a1, { status: "PENDING_UPLOAD" });
    expect((await sign({ ...base, signatureDocumentId: pending })).body.reason).toBe(
      "not_uploaded",
    );

    // Other-branch receptionist: consent:manage is branch-scoped (body branch and plan branch).
    expect((await sign(base, recA2)).status).toBe(403);
    expect((await sign({ ...base, branchId: w.a2 }, recA2)).status).toBe(404); // plan out of scope

    // Non-plan templates must not link a plan version.
    const proc = await template("PROCEDURE");
    const p1 = await sign({ ...base, templateVersionId: proc.currentVersionId });
    expect(p1.status).toBe(400);
    const p2 = await sign({
      ...base,
      templateVersionId: proc.currentVersionId,
      planVersionId: undefined,
    });
    expect(p2.status).toBe(201);
    expect(p2.body).toMatchObject({
      type: "PROCEDURE",
      planVersionId: null,
      signerRelationship: "SELF",
    });

    // Only the current, active template version can be signed.
    await owner("POST", `/consent-templates/${t.id}/versions`, { body: "v2 text" });
    const outdated = await sign(base);
    expect(outdated.status).toBe(409);
    expect(outdated.body).toMatchObject({ error: "template_version_outdated", currentVersion: 2 });
    const t2 = await template();
    await owner("POST", `/consent-templates/${t2.id}/deactivate`);
    const inactive = await sign({ ...base, templateVersionId: t2.currentVersionId });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error).toBe("template_inactive");

    // Cross-tenant: unknown ids in another tenant.
    const cross = await ownerB("POST", `/patients/${patient}/consents/sign`, {
      ...base,
      branchId: w.b1,
    });
    expect(cross.status).toBe(404);
  });

  test("knob off: approval does not require consent", async () => {
    const tC = await w.h.tenant("CONSENT-C");
    const c1 = await w.h.branch(tC);
    const dentC = await w.h.member(tC, ["DENTIST"], { branchScope: [c1] });
    await w.h.admin.tenant.update({
      where: { id: tC },
      data: { settings: { clinical: { requirePlanConsentForApproval: false } } },
    });
    const pt = await seedPatient(w.h, tC, c1, "Knob");
    const s = await seedService(w.h, tC, 10_000);
    const callC = (method: string, path: string, body?: unknown) =>
      w.h.call(method, path, { user: dentC, tenant: tC, body });
    const plan = await acceptedPlan(pt, callC, c1, s);
    const r = await callC("POST", `/plans/${plan.id}/approve`, {});
    expect(r.status).toBe(200);
    expect(r.body.approvedBy).toBe(dentC);
  });
});

describe("review regressions", () => {
  test("signature document from a branch the signer cannot read is 404", async () => {
    const t = await template("PROCEDURE");
    const docA2 = await seedDocument(w.h, w.tA, patient, w.a2);
    const r = await rec("POST", `/patients/${patient}/consents/sign`, {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      signatureDocumentId: docA2,
    });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("document_not_found");
    const docA1 = await seedDocument(w.h, w.tA, patient, w.a1);
    const ok = await rec("POST", `/patients/${patient}/consents/sign`, {
      templateVersionId: t.currentVersionId,
      branchId: w.a1,
      signatureDocumentId: docA1,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.documentId).toBe(docA1);
  });
});
