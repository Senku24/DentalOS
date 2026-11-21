import { createHmac } from "node:crypto";
import { SignJWT } from "jose";
const BASE = "http://localhost:3105";
const A = "16f89d81-ce01-4a9a-b825-e70cbc8996e9";
const B = "c6d4a6b4-9ed8-4133-a0c8-d6f680a71377";
const SECRET = "probe-secret-xyz";
const q = (s: string) =>
  Bun.spawnSync(
    ["psql", "-h", "localhost", "-p", "5433", "-U", "postgres", "-d", "dentalos", "-At", "-c", s],
    { env: { ...process.env, PGPASSWORD: "postgres" } },
  )
    .stdout.toString()
    .trim();
const pm = q(
  `select "providerMessageId" from "NotificationOutbox" where "tenantId"='${A}' and provider='CONSOLE' and "providerMessageId" is not null limit 1`,
);
console.log("pm", pm);
async function hook(
  label: string,
  tenant: string,
  body: string,
  opts: { t?: number; sig?: string; header?: string; provider?: string; ct?: string } = {},
) {
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = opts.sig ?? createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex");
  const header = opts.header ?? `t=${t},v1=${sig}`;
  const r = await fetch(`${BASE}/webhooks/notifications/${opts.provider ?? "console"}/${tenant}`, {
    method: "POST",
    headers: { "content-type": opts.ct ?? "application/json", "x-dentalos-signature": header },
    body,
  });
  console.log(label.padEnd(44), r.status, (await r.text()).slice(0, 200));
}
const ev = (id: string, status = "delivered", extra: object = {}) =>
  JSON.stringify({
    eventId: id,
    providerMessageId: pm,
    status,
    occurredAt: new Date().toISOString(),
    ...extra,
  });
const e1 = "ev-" + crypto.randomUUID();
await hook("valid first", A, ev(e1));
await hook("replay same body", A, ev(e1));
await hook("same eventId different whitespace/body", A, ev(e1, "read"));
await hook("future t within tol", A, ev("ev-" + crypto.randomUUID()), {
  t: Math.floor(Date.now() / 1000) + 250,
});
await hook("future t beyond tol", A, ev("ev-" + crypto.randomUUID()), {
  t: Math.floor(Date.now() / 1000) + 400,
});
await hook("uppercase hex sig", A, ev("ev-" + crypto.randomUUID()), {
  sig: createHmac("sha256", SECRET)
    .update(`${Math.floor(Date.now() / 1000)}.`)
    .update("x")
    .digest("hex")
    .toUpperCase(),
});
await hook("no sig header", A, ev("x"), { header: "" });
await hook("sig only v1 garbage", A, ev("x"), {
  header: `t=${Math.floor(Date.now() / 1000)},v1=zz`,
});
await hook("tenant B w/ A's provider msg id", B, ev("ev-" + crypto.randomUUID()));
await hook("random tenant uuid (signed)", crypto.randomUUID(), ev("ev-" + crypto.randomUUID()));
await hook("provider 'STUB' no secret", A, ev("ev-" + crypto.randomUUID()), { provider: "stub" });
await hook("provider case 'CoNsOlE'", A, ev("ev-" + crypto.randomUUID()), { provider: "CoNsOlE" });
await hook("text/plain content-type signed", A, ev("ev-" + crypto.randomUUID()), {
  ct: "text/plain",
});
await hook(
  "failed receipt after delivered (no regress)",
  A,
  ev("ev-" + crypto.randomUUID(), "failed", { errorCode: "user@example.com +919999999999" }),
);
console.log(
  q(
    `select "deliveryStatus","lastError" from "NotificationOutbox" where "providerMessageId"='${pm}'`,
  ),
);
console.log(
  q(
    `select "errorCode",status from "NotificationDeliveryEvent" where "providerMessageId"='${pm}' order by "occurredAt" desc limit 3`,
  ),
);
// large unsigned body
const big = "x".repeat(8_000_000);
const r = await fetch(`${BASE}/webhooks/notifications/console/${A}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: big,
});
console.log("8MB unsigned", r.status, (await r.text()).slice(0, 100));
// preview prototype keys
const tok = await new SignJWT({ mfa: true })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setSubject("demo-35b737e6-a-owner")
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.DEV_JWT_SECRET));
const pr = await fetch(`${BASE}/notification-templates/preview`, {
  method: "POST",
  headers: { authorization: `Bearer ${tok}`, "x-tenant-id": A, "content-type": "application/json" },
  body: JSON.stringify({ body: "{{constructor}} {{toString}} {{hasOwnProperty}}", variables: {} }),
});
console.log("preview proto", pr.status, (await pr.text()).slice(0, 300));
