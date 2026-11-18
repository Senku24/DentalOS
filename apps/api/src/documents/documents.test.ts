import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Harness, startHarness } from "../org/test-harness";
import { StorageService } from "../storage/storage.service";
import { type ObjectHead, objectStore } from "./object-store";

/**
 * Documents API with a fake object store (no S3 needed): presign calls are stubbed on the app's
 * StorageService instance and the confirm-step HEAD is served from `objects`.
 */
let h: Harness;
let tA: string;
let tB: string;
let b1: string;
let b2: string;
let owner: string;
let rec: string;
let acct: string;
let ownerB: string;
let patient: string;
const objects = new Map<string, ObjectHead>();
const signedDownloads: string[] = [];
const realHead = objectStore.head;

async function newPatient(tenantId: string, branchId: string) {
  return (
    await h.admin.patient.create({
      data: {
        tenantId,
        originBranchId: branchId,
        firstName: "Doc",
        nameNormalized: "doc test",
        intakeType: "WALK_IN",
        createdBy: "seed",
      },
    })
  ).id;
}

beforeAll(async () => {
  h = await startHarness();
  const storage = h.app.get(StorageService);
  let n = 0;
  storage.presignUpload = async (p, opts) => {
    const key = `${StorageService.keyPrefix(p.tenantId)}fake-${Date.now()}-${n++}`;
    return {
      key,
      url: "https://s3.test/bucket",
      fields: { key, "Content-Type": opts.contentType, max: String(opts.maxBytes) },
    };
  };
  storage.presignDownload = async (p, key) => {
    storage.assertOwnKey(p, key);
    signedDownloads.push(key);
    return `https://s3.test/bucket/${key}?sig=fake`;
  };
  objectStore.head = async (key) => objects.get(key) ?? null;

  tA = await h.tenant("Doc-A");
  tB = await h.tenant("Doc-B");
  b1 = await h.branch(tA);
  b2 = await h.branch(tA);
  owner = await h.member(tA, ["OWNER"], { orgWide: true });
  rec = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
  acct = await h.member(tA, ["ACCOUNTANT"], { branchScope: [b1] });
  ownerB = await h.member(tB, ["OWNER"], { orgWide: true });
  patient = await newPatient(tA, b1);
});
afterAll(async () => {
  objectStore.head = realHead;
  await h.close();
});

const call = (method: string, path: string, user: string, body?: unknown, tenant = tA) =>
  h.call(method, path, { user, tenant, body });

const uploadReq = (extra: Record<string, unknown> = {}) => ({
  patientId: patient,
  branchId: b1,
  fileName: "xray-01.png",
  contentType: "image/png",
  sizeBytes: 2048,
  category: "XRAY",
  ...extra,
});

async function uploaded(user = rec, extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/documents/uploads", user, uploadReq(extra));
  expect(r.status).toBe(201);
  const row = await h.admin.patientDocument.findUniqueOrThrow({ where: { id: r.body.documentId } });
  objects.set(row.storageKey, { contentLength: 2000, contentType: row.contentType });
  const c = await call("POST", `/documents/${r.body.documentId}/confirm`, user, {});
  expect(c.status).toBe(200);
  return c.body as { id: string; status: string; sizeBytes: number };
}

test("upload request -> confirm -> list -> download -> soft delete", async () => {
  const r = await call("POST", "/documents/uploads", rec, uploadReq());
  expect(r.status).toBe(201);
  expect(r.body.fields.max).toBe("2048"); // storage policy capped at the declared size
  const row = await h.admin.patientDocument.findUniqueOrThrow({ where: { id: r.body.documentId } });
  expect(row.status).toBe("PENDING_UPLOAD");
  expect(row.storageKey.startsWith(`t/${tA}/`)).toBe(true);

  // Pending documents are not listed and cannot be downloaded.
  let list = await call("GET", `/documents?patientId=${patient}`, rec);
  expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(row.id);
  expect((await call("GET", `/documents/${row.id}/download-url`, rec)).status).toBe(409);

  // Confirm before the object exists -> 409; after -> AVAILABLE with the real size.
  expect((await call("POST", `/documents/${row.id}/confirm`, rec, {})).status).toBe(409);
  objects.set(row.storageKey, { contentLength: 1999, contentType: "image/png" });
  const sha = "a".repeat(64);
  const c = await call("POST", `/documents/${row.id}/confirm`, rec, { sha256: sha });
  expect(c.status).toBe(200);
  expect(c.body.status).toBe("AVAILABLE");
  expect(c.body.sizeBytes).toBe(1999);
  expect((await call("POST", `/documents/${row.id}/confirm`, rec, {})).status).toBe(200); // idempotent

  list = await call("GET", `/documents?patientId=${patient}&category=XRAY`, rec);
  expect(list.body.items.map((d: { id: string }) => d.id)).toContain(row.id);

  const dl = await call("GET", `/documents/${row.id}/download-url`, rec);
  expect(dl.status).toBe(200);
  expect(dl.body.expiresInSeconds).toBe(60);
  expect(signedDownloads).toContain(row.storageKey);
  const audit = await h.admin.auditEvent.findMany({
    where: { tenantId: tA, resourceId: row.id },
    orderBy: { chainPos: "asc" },
  });
  expect(audit.map((a) => a.action)).toEqual([
    "document.upload_request",
    "document.confirm",
    "document.download",
  ]);
  expect(audit.every((a) => a.branchId === b1 && a.actorId === rec)).toBe(true);

  expect((await call("POST", `/documents/${row.id}/delete`, rec, {})).status).toBe(400); // reason
  const del = await call("POST", `/documents/${row.id}/delete`, rec, { reason: "Wrong patient" });
  expect(del.status).toBe(200);
  expect(del.body.status).toBe("DELETED");
  const after = await h.admin.patientDocument.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.deletedBy).toBe(rec);
  expect((await call("GET", `/documents/${row.id}/download-url`, rec)).status).toBe(409);
  list = await call("GET", `/documents?patientId=${patient}`, rec);
  expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(row.id);
});

test("confirm rejects an object that does not match the declared upload", async () => {
  const r = await call("POST", "/documents/uploads", rec, uploadReq());
  const row = await h.admin.patientDocument.findUniqueOrThrow({ where: { id: r.body.documentId } });
  objects.set(row.storageKey, { contentLength: 4096, contentType: "image/png" });
  expect((await call("POST", `/documents/${row.id}/confirm`, rec, {})).status).toBe(409);
  objects.set(row.storageKey, { contentLength: 100, contentType: "text/html" });
  expect((await call("POST", `/documents/${row.id}/confirm`, rec, {})).status).toBe(409);
});

test("validation: content-type allow-list, size limit, file names, unknown patient", async () => {
  expect(
    (await call("POST", "/documents/uploads", rec, uploadReq({ contentType: "text/html" }))).status,
  ).toBe(400);
  expect(
    (await call("POST", "/documents/uploads", rec, uploadReq({ sizeBytes: 26 * 1024 * 1024 })))
      .status,
  ).toBe(400);
  expect(
    (await call("POST", "/documents/uploads", rec, uploadReq({ fileName: "../etc/passwd" })))
      .status,
  ).toBe(400);
  expect(
    (await call("POST", "/documents/uploads", rec, uploadReq({ patientId: crypto.randomUUID() })))
      .status,
  ).toBe(404);
  expect((await call("GET", "/documents", rec)).status).toBe(400); // patientId required
});

test("branch scope and roles: other branch 403/404, accountant has no document access", async () => {
  expect((await call("POST", "/documents/uploads", rec, uploadReq({ branchId: b2 }))).status).toBe(
    403,
  );
  expect((await call("POST", "/documents/uploads", acct, uploadReq())).status).toBe(403);
  expect((await call("GET", `/documents?patientId=${patient}`, acct)).status).toBe(403);

  // Owner files a document under b2 (patients are shared across branches).
  const d = await uploaded(owner, { branchId: b2 });
  const recList = await call("GET", `/documents?patientId=${patient}`, rec);
  expect(recList.body.items.map((x: { id: string }) => x.id)).not.toContain(d.id);
  expect((await call("GET", `/documents?patientId=${patient}&branchId=${b2}`, rec)).status).toBe(
    403,
  );
  expect((await call("GET", `/documents/${d.id}`, rec)).status).toBe(404);
  expect((await call("GET", `/documents/${d.id}/download-url`, rec)).status).toBe(404);
  expect(
    (await call("POST", `/documents/${d.id}/delete`, rec, { reason: "Not mine" })).status,
  ).toBe(404);
  const ownerList = await call("GET", `/documents?patientId=${patient}`, owner);
  expect(ownerList.body.items.map((x: { id: string }) => x.id)).toContain(d.id);
});

test("cross-tenant: patient, documents and branches of another tenant are 404", async () => {
  const d = await uploaded();
  expect((await call("GET", `/documents/${d.id}`, ownerB, undefined, tB)).status).toBe(404);
  expect((await call("GET", `/documents/${d.id}/download-url`, ownerB, undefined, tB)).status).toBe(
    404,
  );
  expect((await call("GET", `/documents?patientId=${patient}`, ownerB, undefined, tB)).status).toBe(
    404,
  );
  const bB = await h.branch(tB);
  expect(
    (await call("POST", "/documents/uploads", ownerB, uploadReq({ branchId: bB }), tB)).status,
  ).toBe(404);
  const pB = await newPatient(tB, bB);
  expect(
    (await call("POST", "/documents/uploads", owner, uploadReq({ patientId: pB }))).status,
  ).toBe(404);
});

test("pagination and merged patients", async () => {
  const p2 = await newPatient(tA, b1);
  for (let i = 0; i < 3; i++) await uploaded(rec, { patientId: p2 });
  const page1 = await call("GET", `/documents?patientId=${p2}&limit=2`, rec);
  expect(page1.body.items.length).toBe(2);
  const page2 = await call(
    "GET",
    `/documents?patientId=${p2}&limit=2&cursor=${page1.body.nextCursor}`,
    rec,
  );
  expect(page2.body.items.length).toBe(1);
  expect(page2.body.nextCursor).toBeNull();

  await h.admin.patient.update({
    where: { id: p2 },
    data: { mergedIntoId: patient, mergedAt: new Date() },
  });
  const r = await call("POST", "/documents/uploads", rec, uploadReq({ patientId: p2 }));
  expect(r.status).toBe(409);
});
