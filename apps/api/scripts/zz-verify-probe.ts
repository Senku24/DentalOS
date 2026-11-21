import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
const BASE = "http://localhost:3105";
const A = "16f89d81-ce01-4a9a-b825-e70cbc8996e9";
const B = "c6d4a6b4-9ed8-4133-a0c8-d6f680a71377";
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const tok = (sub: string) =>
  new SignJWT({ mfa: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(sub)
    .setExpirationTime("1h")
    .sign(key);
const u = (t: string, r: string) => `demo-35b737e6-${t}-${r}`;
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
  const t = await r.text();
  return `${r.status} ${t.slice(0, 220)}`;
}
const out = async (label: string, p: Promise<string>) => console.log(label.padEnd(46), await p);
// ids
const q = (s: string) =>
  Bun.spawnSync(
    ["psql", "-h", "localhost", "-p", "5433", "-U", "postgres", "-d", "dentalos", "-At", "-c", s],
    { env: { ...process.env, PGPASSWORD: "postgres" } },
  )
    .stdout.toString()
    .trim();
const noida = q(
  `select id from "NotificationOutbox" where "branchId"='41fdc7d6-8725-4e79-9033-cc920f313c48' and status='FAILED' limit 1`,
);
const saketQueued = q(
  `select id from "NotificationOutbox" where "tenantId"='${A}' and "branchId"='47f1ed55-7537-4de0-ad38-91b225c1f49b' limit 1`,
);
const tplA = q(`select id from "NotificationTemplate" where "tenantId"='${A}' limit 1`);
console.log({ noida, saketQueued, tplA });
await out(
  "B owner reads A outbox row (own tenant hdr)",
  call(u("b", "owner"), B, "GET", `/notifications/outbox/${noida}`),
);
await out(
  "B owner w/ A tenant header",
  call(u("b", "owner"), A, "GET", `/notifications/outbox/${noida}`),
);
await out(
  "B owner reads A template",
  call(u("b", "owner"), B, "GET", `/notification-templates/${tplA}`),
);
await out(
  "B owner patch A template",
  call(u("b", "owner"), B, "PATCH", `/notification-templates/${tplA}`, { name: "x" }),
);
await out(
  "B owner publish A template",
  call(u("b", "owner"), B, "POST", `/notification-templates/${tplA}/versions`, {
    body: "hi {{patientName}}",
  }),
);
await out(
  "B owner retry A row",
  call(u("b", "owner"), B, "POST", `/notifications/outbox/${noida}/retry`),
);
await out(
  "B owner cancel A row",
  call(u("b", "owner"), B, "POST", `/notifications/outbox/${noida}/cancel`),
);
await out(
  "A manager(Saket) get Noida row",
  call(u("a", "manager"), A, "GET", `/notifications/outbox/${noida}`),
);
await out(
  "A manager(Saket) retry Noida row",
  call(u("a", "manager"), A, "POST", `/notifications/outbox/${noida}/retry`),
);
await out(
  "A manager(Saket) cancel Noida row",
  call(u("a", "manager"), A, "POST", `/notifications/outbox/${noida}/cancel`),
);
await out(
  "A manager list branchId=Noida",
  call(
    u("a", "manager"),
    A,
    "GET",
    `/notifications/outbox?branchId=41fdc7d6-8725-4e79-9033-cc920f313c48`,
  ),
);
await out(
  "A manager list all (count)",
  call(u("a", "manager"), A, "GET", `/notifications/outbox?limit=100`).then((s) => s.slice(0, 60)),
);
await out("A recep list", call(u("a", "receptionist"), A, "GET", `/notifications/outbox?limit=2`));
await out("A dentist list", call(u("a", "dentist"), A, "GET", `/notifications/outbox`));
await out("A accountant list", call(u("a", "accountant"), A, "GET", `/notifications/outbox`));
await out("A dentist2 list", call(u("a", "dentist2"), A, "GET", `/notifications/templates`));
await out(
  "A recep templates list",
  call(u("a", "receptionist"), A, "GET", `/notification-templates?limit=1`).then((s) =>
    s.slice(0, 80),
  ),
);
await out(
  "A recep POST test",
  call(u("a", "receptionist"), A, "POST", `/notifications/test`, {
    channel: "SMS",
    templateCode: "APPT_CONFIRMATION",
    toAddress: "9999999999",
    variables: {},
  }),
);
await out(
  "A manager POST test",
  call(u("a", "manager"), A, "POST", `/notifications/test`, {
    channel: "SMS",
    templateCode: "APPT_CONFIRMATION",
    toAddress: "9999999999",
    variables: {},
  }),
);
await out("A recep settings", call(u("a", "receptionist"), A, "GET", `/notifications/settings`));
await out(
  "A recep recall-sweep",
  call(u("a", "receptionist"), A, "POST", `/notifications/recall-sweep`, {}),
);
await out(
  "A recep patch template",
  call(u("a", "receptionist"), A, "PATCH", `/notification-templates/${tplA}`, { name: "hax" }),
);
await out(
  "A recep preferences/check bogus",
  call(
    u("a", "receptionist"),
    A,
    "GET",
    `/notifications/preferences/check?patientId=${crypto.randomUUID()}&channel=SMS&purpose=MARKETING`,
  ),
);
// mass assignment
await out(
  "owner PATCH tpl extra fields",
  call(u("a", "owner"), A, "PATCH", `/notification-templates/${tplA}`, {
    name: "keep",
    currentVersion: 99,
    tenantId: B,
    code: "HACK",
    active: true,
    id: crypto.randomUUID(),
  }),
);
console.log(
  q(`select code,"currentVersion","tenantId",name from "NotificationTemplate" where id='${tplA}'`),
);
await out(
  "owner POST version extra fields",
  call(u("a", "owner"), A, "POST", `/notification-templates/${tplA}/versions`, {
    body: "Hi {{patientName}} from {{branchName}}",
    version: 77,
    createdBy: "x",
    templateId: crypto.randomUUID(),
    tenantId: B,
  }),
);
console.log(
  q(
    `select version,"createdBy","tenantId" from "NotificationTemplateVersion" where "templateId"='${tplA}' order by version desc limit 2`,
  ),
);
await out(
  "owner template w/ unknown placeholder {{x}}",
  call(u("a", "owner"), A, "POST", `/notification-templates/${tplA}/versions`, {
    body: "Hi {{__proto__}} {{constructor}}",
  }),
);
await out(
  "owner settings patch extra",
  call(u("a", "owner"), A, "PATCH", `/notifications/settings`, {
    enabledChannels: ["SMS"],
    evil: 1,
  }),
);
