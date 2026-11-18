import { afterAll, beforeAll, expect, test } from "bun:test";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Harness } from "../org/test-harness";

/**
 * Real end-to-end documents flow against an S3-compatible server (compose `s3` service): presigned POST
 * upload, confirm (real HEAD), presigned download. Skipped unless S3_TEST_ENDPOINT is set.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const run = endpoint ? test : test.skip;
const bucket = `dentalos-docs-${Date.now()}`;

let h: Harness;
let s3: S3Client;
let tA: string;
let b1: string;
let rec: string;
let patient: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  if (!endpoint) return;
  for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET"])
    saved[k] = process.env[k];
  Object.assign(process.env, {
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY: "dev",
    S3_SECRET_KEY: "devdevdev",
    S3_BUCKET: bucket,
  });
  s3 = new S3Client({
    region: "ap-south-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "dev", secretAccessKey: "devdevdev" },
  });
  for (let i = 0; ; i++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "warmup", Body: "x" }));
      break;
    } catch (e) {
      if (i >= 40) throw e;
      await Bun.sleep(1500);
    }
  }
  const { startHarness } = await import("../org/test-harness");
  h = await startHarness();
  tA = await h.tenant("Doc-S3");
  b1 = await h.branch(tA);
  rec = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
  patient = (
    await h.admin.patient.create({
      data: {
        tenantId: tA,
        originBranchId: b1,
        firstName: "S3",
        nameNormalized: "s3",
        intakeType: "WALK_IN",
        createdBy: "seed",
      },
    })
  ).id;
}, 120_000);
afterAll(async () => {
  if (!endpoint) return;
  await h?.close();
  s3?.destroy();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

run("presigned upload -> confirm (HEAD) -> presigned download returns the bytes", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const r = await h.call("POST", "/documents/uploads", {
    user: rec,
    tenant: tA,
    body: {
      patientId: patient,
      branchId: b1,
      fileName: "scan.png",
      contentType: "image/png",
      sizeBytes: bytes.length,
    },
  });
  expect(r.status).toBe(201);
  // Not uploaded yet -> confirm refuses.
  const early = await h.call("POST", `/documents/${r.body.documentId}/confirm`, {
    user: rec,
    tenant: tA,
    body: {},
  });
  expect(early.status).toBe(409);

  const form = new FormData();
  for (const [k, v] of Object.entries(r.body.fields as Record<string, string>)) form.append(k, v);
  form.append("file", new Blob([bytes], { type: "image/png" }));
  expect((await fetch(r.body.url, { method: "POST", body: form })).status).toBeLessThan(300);

  const c = await h.call("POST", `/documents/${r.body.documentId}/confirm`, {
    user: rec,
    tenant: tA,
    body: {},
  });
  expect(c.status).toBe(200);
  expect(c.body.status).toBe("AVAILABLE");
  const dl = await h.call("GET", `/documents/${r.body.documentId}/download-url`, {
    user: rec,
    tenant: tA,
  });
  expect(dl.status).toBe(200);
  const got = new Uint8Array(await (await fetch(dl.body.url)).arrayBuffer());
  expect([...got]).toEqual([...bytes]);
});
