import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Real round trip against an S3-compatible server that VALIDATES SigV4 (compose `s3` service).
 * Skipped unless S3_TEST_ENDPOINT is set so a plain `bun test` works without Docker.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const run = endpoint ? test : test.skip;

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const principal = (tenantId: string) => ({
  userId: "u",
  tenantId,
  roles: ["DENTIST" as const],
  orgWide: false,
  branchScope: ["b1"],
});

let storage: import("./storage.service").StorageService;
let admin: S3Client;
const bucket = `dentalos-test-${Date.now()}`;

beforeAll(async () => {
  if (!endpoint) return;
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_ACCESS_KEY = "dev";
  process.env.S3_SECRET_KEY = "devdevdev";
  process.env.S3_BUCKET = bucket;
  const { StorageService } = await import("./storage.service");
  storage = new StorageService();
  admin = new S3Client({
    region: "ap-south-1",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "dev", secretAccessKey: "devdevdev" },
  });
  // A freshly started SeaweedFS accepts connections before it can serve (and allocates its first
  // volume lazily): retry bucket creation and a warm-up write so tests measure behaviour, not start-up.
  const retry = async (fn: () => Promise<unknown>) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= 40) throw e;
        await Bun.sleep(1500);
      }
    }
  };
  await retry(() => admin.send(new CreateBucketCommand({ Bucket: bucket })));
  await retry(() => admin.send(new PutObjectCommand({ Bucket: bucket, Key: "warmup", Body: "x" })));
}, 120_000);
afterAll(() => admin?.destroy());

async function upload(
  up: { url: string; fields: Record<string, string> },
  body: Blob,
  override: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...up.fields, ...override })) form.append(k, v);
  form.append("file", body); // file must be the last field
  return fetch(up.url, { method: "POST", body: form });
}

run("presigned POST upload then presigned GET download returns the same bytes", async () => {
  const up = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
  expect(up.key.startsWith(`t/${T1}/`)).toBe(true);
  const res = await upload(up, new Blob(["hello dental"], { type: "text/plain" }));
  expect(res.status).toBeLessThan(300);

  const head = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: up.key }));
  expect(head.ContentLength).toBe("hello dental".length);

  const url = await storage.presignDownload(principal(T1), up.key);
  const dl = await fetch(url);
  expect(dl.status).toBe(200);
  expect(await dl.text()).toBe("hello dental");
});

run("a download URL signed for one object cannot be re-pointed at another", async () => {
  const a = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
  const b = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
  await upload(a, new Blob(["A"], { type: "text/plain" }));
  await upload(b, new Blob(["B"], { type: "text/plain" }));
  const urlA = new URL(await storage.presignDownload(principal(T1), a.key));
  urlA.pathname = urlA.pathname.replace(a.key, b.key);
  expect((await fetch(urlA)).status).toBeGreaterThanOrEqual(400);
});

run("tampered signature is rejected", async () => {
  const up = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
  await upload(up, new Blob(["x"], { type: "text/plain" }));
  const u = new URL(await storage.presignDownload(principal(T1), up.key));
  const sig = u.searchParams.get("X-Amz-Signature") ?? "";
  u.searchParams.set("X-Amz-Signature", sig.replace(/.$/, sig.endsWith("0") ? "1" : "0"));
  expect((await fetch(u)).status).toBeGreaterThanOrEqual(400);
});

run("an unsigned request to a private object is refused", async () => {
  const up = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
  await upload(up, new Blob(["x"], { type: "text/plain" }));
  const bare = new URL(await storage.presignDownload(principal(T1), up.key));
  const res = await fetch(`${bare.origin}${bare.pathname}`); // no query/signature
  expect(res.status).toBeGreaterThanOrEqual(400);
});

run("upload policy: oversize and wrong content type are rejected by storage", async () => {
  const small = await storage.presignUpload(principal(T1), {
    contentType: "text/plain",
    maxBytes: 10,
  });
  const big = await upload(small, new Blob(["x".repeat(100)], { type: "text/plain" }));
  expect(big.status).toBeGreaterThanOrEqual(400);

  const typed = await storage.presignUpload(principal(T1), { contentType: "image/png" });
  const wrong = await upload(typed, new Blob(["x"], { type: "text/html" }), {
    "Content-Type": "text/html",
  });
  expect(wrong.status).toBeGreaterThanOrEqual(400);
});

run(
  "another tenant's key can never be signed, so its object is unreachable via the API",
  async () => {
    const up = await storage.presignUpload(principal(T1), { contentType: "text/plain" });
    await upload(up, new Blob(["secret"], { type: "text/plain" }));
    await expect(storage.presignDownload(principal(T2), up.key)).rejects.toThrow();
    // sanity: the object really exists, so the denial is the tenant check and not a missing key
    const got = await admin.send(new GetObjectCommand({ Bucket: bucket, Key: up.key }));
    expect(await got.Body?.transformToString()).toBe("secret");
  },
);
