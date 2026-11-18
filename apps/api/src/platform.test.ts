import { expect, test } from "bun:test";
import { makeLogger } from "./observability/logger";
import { MAX_UPLOAD_BYTES, StorageService } from "./storage/storage.service";

process.env.S3_ENDPOINT = "http://localhost:9000";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const principal = (tenantId: string) => ({
  userId: "u",
  tenantId,
  roles: ["DENTIST" as const],
  orgWide: false,
  branchScope: ["b1"],
});

test("presigned download is short-lived and signed", async () => {
  const s = new StorageService();
  const url = new URL(await s.presignDownload(principal(T1), `t/${T1}/doc-1`));
  expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
});

test("cannot sign a key from another tenant or with traversal", async () => {
  const s = new StorageService();
  await expect(s.presignDownload(principal(T1), `t/${T2}/doc-1`)).rejects.toThrow();
  await expect(s.presignDownload(principal(T1), `t/${T1}/../${T2}/x`)).rejects.toThrow();
  await expect(s.presignDownload(principal(T1), "anything")).rejects.toThrow();
});

test("presigned upload is tenant-prefixed and size/type-constrained by policy", async () => {
  const s = new StorageService();
  const up = await s.presignUpload(principal(T1), { contentType: "image/png", maxBytes: 10 ** 12 });
  expect(up.key.startsWith(`t/${T1}/`)).toBe(true);
  const policy = JSON.parse(Buffer.from(up.fields.Policy as string, "base64").toString());
  expect(policy.conditions).toContainEqual(["content-length-range", 1, MAX_UPLOAD_BYTES]);
  expect(policy.conditions).toContainEqual(["eq", "$Content-Type", "image/png"]);
});

test("logger emits JSON and redacts secrets", () => {
  const lines: string[] = [];
  const l = makeLogger({ write: (m: string) => void lines.push(m) });
  l.info({ req: { headers: { authorization: "Bearer SECRET" } }, auth: { token: "T0K3N" } }, "x");
  const o = JSON.parse(lines[0] ?? "{}");
  expect(o.msg).toBe("x");
  expect(JSON.stringify(o)).not.toContain("SECRET");
  expect(JSON.stringify(o)).not.toContain("T0K3N");
});
