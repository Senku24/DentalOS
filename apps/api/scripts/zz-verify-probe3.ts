import { SignJWT } from "jose";
const BASE = "http://localhost:3105";
const A = "16f89d81-ce01-4a9a-b825-e70cbc8996e9",
  B = "c6d4a6b4-9ed8-4133-a0c8-d6f680a71377";
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const tok = (sub: string) =>
  new SignJWT({ mfa: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(key);
async function call(user: string, tenant: string, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${await tok(user)}`,
      "x-tenant-id": tenant,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return `${r.status} ${(await r.text()).slice(0, 200)}`;
}
const q = (s: string) =>
  Bun.spawnSync(
    ["psql", "-h", "localhost", "-p", "5433", "-U", "postgres", "-d", "dentalos", "-At", "-c", s],
    { env: { ...process.env, PGPASSWORD: "postgres" } },
  )
    .stdout.toString()
    .trim();
const svcB = q(`select id from "Service" where "tenantId"='${B}' limit 1`);
const brB = q(`select id from "Branch" where "tenantId"='${B}' limit 1`);
const ptB = q(`select id from "Patient" where "tenantId"='${B}' limit 1`);
const nullBr = q(
  `select id from "NotificationOutbox" where "tenantId"='${A}' and "branchId" is null and status='FAILED' limit 1`,
);
const sent = q(
  `select id from "NotificationOutbox" where "tenantId"='${A}' and status='SENT' limit 1`,
);
const log = async (l: string, p: Promise<string>) => console.log(l.padEnd(40), await p);
await log(
  "recall upsert foreign service",
  call("demo-35b737e6-a-owner", A, "PUT", "/notifications/recall-settings", {
    serviceId: svcB,
    intervalDays: 30,
    active: true,
  }),
);
await log(
  "test send foreign branch",
  call("demo-35b737e6-a-owner", A, "POST", "/notifications/test", {
    channel: "SMS",
    templateCode: "APPT_CONFIRMATION",
    toAddress: "9876543210",
    branchId: brB,
    variables: {},
  }),
);
await log(
  "prefs check foreign patient",
  call(
    "demo-35b737e6-a-manager",
    A,
    "GET",
    `/notifications/preferences/check?patientId=${ptB}&channel=SMS&purpose=MARKETING`,
  ),
);
await log(
  "outbox list patientId foreign",
  call("demo-35b737e6-a-owner", A, "GET", `/notifications/outbox?patientId=${ptB}`),
);
await log(
  "branch-scoped retry null-branch row",
  call("demo-35b737e6-a-manager", A, "POST", `/notifications/outbox/${nullBr}/retry`),
);
await log(
  "branch-scoped get null-branch row",
  call("demo-35b737e6-a-receptionist", A, "GET", `/notifications/outbox/${nullBr}`),
);
await log(
  "retry SENT row",
  call("demo-35b737e6-a-owner", A, "POST", `/notifications/outbox/${sent}/retry`),
);
await log(
  "cancel SENT row",
  call("demo-35b737e6-a-owner", A, "POST", `/notifications/outbox/${sent}/cancel`),
);
await log(
  "owner of A w/ tenant B hdr",
  call("demo-35b737e6-a-owner", B, "GET", "/notifications/outbox"),
);
await log(
  "no token",
  fetch(BASE + "/notifications/outbox", { headers: { "x-tenant-id": A } }).then(
    async (r) => `${r.status}`,
  ),
);
