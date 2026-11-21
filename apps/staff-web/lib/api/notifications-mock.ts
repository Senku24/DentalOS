import {
  type NotificationSettings,
  type NotificationTemplateResponse,
  type NotificationTemplateVersionResponse,
  type OutboxResponse,
  type RecallSettingResponse,
  SYSTEM_TEMPLATES,
  createNotificationTemplateRequest,
  extractPlaceholders,
  listNotificationTemplatesQuery,
  listOutboxQuery,
  maskAddress,
  normalizeEmail,
  normalizePhoneIN,
  notificationSettings,
  placeholdersFor,
  previewNotificationTemplateRequest,
  publishNotificationTemplateVersionRequest,
  renderTemplate,
  resolveConsent,
  resolveNotificationSettings,
  sendTestNotificationRequest,
  unknownPlaceholders,
  updateNotificationTemplateRequest,
  upsertRecallSettingRequest,
  validateTemplateBody,
  z,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import { clinicalMockHandler as fallback } from "./clinical-mock";
import { mapHttpError } from "./errors";
import { branches, fid, patients, services } from "./fixtures";
import { API_PREFIX } from "./routes";
import type { Items, Page } from "./types";

/**
 * In-memory fake of the notifications API (outbox, templates, test send, consent preview, settings,
 * recall) for mock mode, following the Wave 1 services' rules and error codes. A queued message
 * "sends" after ~1.5 s so the polling UI can be exercised. Patients and the catalogue come from the
 * shared mocks. The caller is always `dev-user`.
 */
const ME = "dev-user";
const LATENCY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (d: Date) => d.toISOString();
const ago = (minutes: number) => iso(new Date(Date.now() - minutes * 60_000));

let seq = 9000;
const newId = (kind: string) => fid(kind, ++seq);

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw mapHttpError(status, { error, ...extra });
};
function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    fail(400, "validation_failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return (r as { data: z.output<T> }).data;
}
function paginate<T>(rows: T[], q: Record<string, string>): Page<T> {
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
  const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
  return {
    items: rows.slice(offset, offset + limit),
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
}

// ---- Fixtures ---------------------------------------------------------------------------------

const B1 = branches[0]?.id ?? fid("0b", 1);
const TEXTS: Record<string, { subject?: string; body: string }> = {
  APPT_CONFIRMATION: {
    subject: "Your appointment at {{branchName}}",
    body: "Hi {{patientName}}, your visit with {{dentistName}} is confirmed for {{appointmentDate}} at {{appointmentTime}}, {{branchName}}. Call {{branchPhone}} to change it.",
  },
  APPT_REMINDER_24H: {
    subject: "Reminder: appointment tomorrow",
    body: "Hi {{patientName}}, a reminder of your appointment on {{appointmentDate}} at {{appointmentTime}} with {{dentistName}} at {{branchName}}.",
  },
  APPT_REMINDER_2H: {
    body: "Hi {{patientName}}, see you at {{branchName}} at {{appointmentTime}} today. Questions? {{branchPhone}}.",
  },
  PAYMENT_RECEIPT: {
    subject: "Receipt {{receiptNumber}}",
    body: "Thank you {{patientName}}. We received {{paidAmount}} by {{paymentMethod}} on {{paymentDate}} against invoice {{invoiceNumber}}. Balance: {{balanceAmount}}.",
  },
  RECALL_REMINDER: {
    body: "Hi {{patientName}}, it is time for your next {{serviceName}} (due {{dueDate}}). Call {{branchPhone}} to book at {{branchName}}.",
  },
  TEST_MESSAGE: { body: "Test message for {{patientName}} from {{branchName}}." },
};

interface TemplateRow
  extends Omit<NotificationTemplateResponse, "latest" | "allowedPlaceholders"> {}
const db = {
  templates: [] as TemplateRow[],
  versions: [] as NotificationTemplateVersionResponse[],
  outbox: [] as (OutboxResponse & { toAddress: string; key: string })[],
  settings: {
    quietHours: { enabled: true, start: "21:00", end: "08:00", timeZone: "Asia/Kolkata" },
    implicitConsent: { transactional: true, reminder: false },
    recallLeadDays: 7,
  } as NotificationSettings,
  recall: [] as RecallSettingResponse[],
};

function seedTemplate(
  code: string,
  channel: "WHATSAPP" | "SMS" | "EMAIL",
  name: string,
  versions: number,
) {
  const sys = (SYSTEM_TEMPLATES as Record<string, { purpose: "TRANSACTIONAL" | "REMINDER" }>)[code];
  const t: TemplateRow = {
    id: newId("70"),
    code,
    channel,
    language: "en",
    purpose: sys?.purpose ?? "TRANSACTIONAL",
    name,
    active: true,
    currentVersion: versions,
    createdAt: ago(60 * 24 * 40),
    updatedAt: ago(60 * 24 * 3),
  };
  db.templates.push(t);
  const text = TEXTS[code] ?? { body: "Hello {{patientName}}." };
  for (let v = 1; v <= versions; v++) {
    const body =
      v < versions ? text.body.replace("Hi ", "Hello ").replace(/\.$/, " Thanks!") : text.body;
    db.versions.push({
      id: newId("71"),
      templateId: t.id,
      version: v,
      subject: channel === "EMAIL" ? (text.subject ?? name) : null,
      body,
      placeholders: extractPlaceholders(body),
      providerTemplateRef: null,
      createdBy: ME,
      createdAt: ago(60 * 24 * (40 - v * 10)),
    });
  }
}
seedTemplate("APPT_CONFIRMATION", "WHATSAPP", "Appointment confirmation", 2);
seedTemplate("APPT_CONFIRMATION", "EMAIL", "Appointment confirmation (email)", 1);
seedTemplate("APPT_REMINDER_24H", "WHATSAPP", "Reminder 24 hours before", 1);
seedTemplate("APPT_REMINDER_2H", "SMS", "Reminder 2 hours before", 3);
seedTemplate("PAYMENT_RECEIPT", "EMAIL", "Payment receipt", 1);
seedTemplate("RECALL_REMINDER", "SMS", "Recall reminder", 1);
seedTemplate("TEST_MESSAGE", "SMS", "Test message", 1);

const P = (n: number) => patients.find((p) => p.id === fid("01", n)) ?? patients[0];
function seedOutbox(
  n: number,
  channel: "WHATSAPP" | "SMS" | "EMAIL",
  code: string,
  status: OutboxResponse["status"],
  minutes: number,
  extra: Partial<OutboxResponse> = {},
) {
  const patient = P(n);
  const tpl = db.templates.find((t) => t.code === code && t.channel === channel);
  const ver = db.versions.find(
    (v) => v.templateId === tpl?.id && v.version === tpl?.currentVersion,
  );
  const address =
    channel === "EMAIL"
      ? (patient?.email ?? "patient@example.com")
      : (patient?.phone ?? "+919000000000");
  const id = newId("72");
  db.outbox.push({
    id,
    key: `seed:${id}`,
    toAddress: address,
    branchId: B1,
    patientId: patient?.id ?? null,
    channel,
    purpose: tpl?.purpose ?? "TRANSACTIONAL",
    templateCode: code,
    templateVersionId: ver?.id ?? fid("71", 1),
    toAddressMasked: maskAddress(address),
    status,
    attempts: status === "SENT" || status === "FAILED" ? (status === "FAILED" ? 5 : 1) : 0,
    scheduledFor: ago(minutes),
    nextAttemptAt: status === "QUEUED" ? ago(-5) : null,
    provider: status === "SENT" || status === "FAILED" ? "CONSOLE" : null,
    providerMessageId: status === "SENT" ? `console-${id.slice(-6)}` : null,
    deliveryStatus: status === "SENT" ? "sent" : null,
    deliveredAt: null,
    lastError: null,
    source: "appointment.reminder",
    refType: "appointment",
    refId: fid("30", n),
    actorId: "system",
    createdAt: ago(minutes + 1),
    sentAt: status === "SENT" ? ago(minutes - 0.5) : null,
    ...extra,
  });
}
seedOutbox(41, "WHATSAPP", "APPT_REMINDER_24H", "QUEUED", 2);
seedOutbox(41, "SMS", "APPT_REMINDER_2H", "SENT", 35, {
  deliveryStatus: "delivered",
  deliveredAt: ago(34),
});
seedOutbox(43, "WHATSAPP", "APPT_CONFIRMATION", "SENT", 90, {
  deliveryStatus: "read",
  deliveredAt: ago(89),
});
seedOutbox(43, "EMAIL", "PAYMENT_RECEIPT", "FAILED", 180, { lastError: "provider_timeout" });
seedOutbox(44, "WHATSAPP", "APPT_REMINDER_24H", "SKIPPED_NO_CONSENT", 240, {
  lastError: "no_preference",
});
seedOutbox(46, "SMS", "RECALL_REMINDER", "OPTED_OUT", 300, {
  purpose: "REMINDER",
  lastError: "channel_opt_out",
  source: "recall.sweep",
  refType: "service",
});
seedOutbox(41, "EMAIL", "APPT_CONFIRMATION", "SENT", 60 * 26, {
  deliveryStatus: "delivered",
  deliveredAt: ago(60 * 26 - 1),
});
seedOutbox(3, "SMS", "RECALL_REMINDER", "FAILED", 60 * 30, {
  lastError: "address_invalid",
  purpose: "REMINDER",
});

const svc = (n: number) => services[n - 1];
for (const [n, days] of [
  [4, 180],
  [5, 365],
] as const) {
  const s = svc(n);
  if (s)
    db.recall.push({
      id: newId("73"),
      serviceId: s.id,
      serviceName: s.name,
      intervalDays: days,
      active: true,
      updatedBy: ME,
      updatedAt: ago(60 * 24 * 12),
    });
}

// ---- Helpers ----------------------------------------------------------------------------------

const withLatest = (t: TemplateRow): NotificationTemplateResponse => ({
  ...t,
  allowedPlaceholders: placeholdersFor(t.code)
    ? [...(placeholdersFor(t.code) as readonly string[])]
    : null,
  latest: db.versions.find((v) => v.templateId === t.id && v.version === t.currentVersion) ?? null,
});
const template = (id: string | undefined) =>
  db.templates.find((t) => t.id === id) ?? fail(404, "template_not_found");
const strip = (r: (typeof db.outbox)[number]): OutboxResponse => {
  const { toAddress: _a, key: _k, ...rest } = r;
  return { ...rest };
};
const row = (id: string | undefined) =>
  db.outbox.find((r) => r.id === id) ?? fail(404, "outbox_not_found");

function assertBody(code: string, channel: "WHATSAPP" | "SMS" | "EMAIL", body: string) {
  const issues = validateTemplateBody(code, channel, body);
  if (issues.includes("template_placeholder_unknown"))
    fail(400, "template_placeholder_unknown", {
      placeholders: unknownPlaceholders(body, placeholdersFor(code)),
      allowed: placeholdersFor(code),
    });
  if (issues.includes("template_body_too_long")) fail(400, "template_body_too_long");
}

/** The worker is a timer here: a queued row is "sent" shortly after (or fails for +91 ...0000). */
function simulateWorker(id: string) {
  setTimeout(() => {
    const r = db.outbox.find((x) => x.id === id);
    if (!r || r.status !== "QUEUED") return;
    const bad = r.toAddress.endsWith("0000");
    r.attempts = bad ? 5 : 1;
    r.provider = "CONSOLE";
    if (bad) {
      r.status = "FAILED";
      r.lastError = "console_rejected_test_address";
      r.nextAttemptAt = null;
    } else {
      r.status = "SENT";
      r.sentAt = iso(new Date());
      r.providerMessageId = `console-${id.slice(-6)}`;
      r.deliveryStatus = "sent";
      r.nextAttemptAt = null;
    }
  }, 1500);
}

// ---- Routes -----------------------------------------------------------------------------------

type Handler = (params: string[], q: Record<string, string>, body: unknown) => unknown;
const table: [Method, RegExp, Handler][] = [];
const on = (method: Method, pattern: string, h: Handler) =>
  table.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

on("GET", "/notifications/outbox", (_p, q) => {
  const f = parse(listOutboxQuery, q);
  const rows = db.outbox
    .filter(
      (r) =>
        (!f.status || r.status === f.status) &&
        (!f.channel || r.channel === f.channel) &&
        (!f.patientId || r.patientId === f.patientId) &&
        (!f.branchId || r.branchId === f.branchId) &&
        (!f.templateCode || r.templateCode === f.templateCode.toUpperCase()) &&
        (!f.from || r.createdAt.slice(0, 10) >= f.from) &&
        (!f.to || r.createdAt.slice(0, 10) <= f.to),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(strip);
  return paginate(rows, q);
});
on("GET", "/notifications/outbox/:id", ([id]) => strip(row(id)));
on("POST", "/notifications/outbox/:id/retry", ([id]) => {
  const orig = row(id);
  if (orig.status !== "FAILED") fail(409, "notification_state", { status: orig.status });
  const key = `retry:${orig.id}`;
  const existing = db.outbox.find((r) => r.key === key);
  if (existing) return strip(existing);
  const rid = newId("72");
  const created = {
    ...orig,
    id: rid,
    key,
    status: "QUEUED" as const,
    attempts: 0,
    provider: null,
    providerMessageId: null,
    deliveryStatus: null,
    deliveredAt: null,
    lastError: null,
    sentAt: null,
    source: `retry:${orig.id}`,
    actorId: ME,
    scheduledFor: iso(new Date()),
    nextAttemptAt: iso(new Date()),
    createdAt: iso(new Date()),
  };
  db.outbox.unshift(created);
  simulateWorker(rid);
  return strip(created);
});
on("POST", "/notifications/outbox/:id/cancel", ([id]) => {
  const r = row(id);
  if (r.status !== "QUEUED") fail(409, "notification_state", { status: r.status });
  r.status = "FAILED";
  r.lastError = "cancelled";
  r.nextAttemptAt = null;
  return strip(r);
});

on("POST", "/notifications/test", (_p, _q, body) => {
  const b = parse(sendTestNotificationRequest, body);
  const to =
    b.channel === "EMAIL"
      ? (() => {
          const e = normalizeEmail(b.toAddress);
          return e && z.email().safeParse(e).success ? e : null;
        })()
      : normalizePhoneIN(b.toAddress);
  if (!to)
    fail(400, "address_invalid", {
      issues: [{ path: "toAddress", message: "Invalid address for the channel" }],
    });
  const eff = resolveNotificationSettings({ notifications: db.settings });
  if (!eff.enabledChannels.includes(b.channel)) fail(409, "channel_disabled");
  const tpl = db.templates.find(
    (t) =>
      t.code === b.templateCode && t.channel === b.channel && t.language === b.language && t.active,
  );
  if (!tpl) fail(404, "template_not_found");
  const ver = db.versions.find(
    (v) => v.templateId === tpl?.id && v.version === tpl?.currentVersion,
  );
  const id = newId("72");
  db.outbox.unshift({
    id,
    key: `test:${id}`,
    toAddress: to as string,
    branchId: b.branchId ?? null,
    patientId: null,
    channel: b.channel,
    purpose: tpl?.purpose ?? "TRANSACTIONAL",
    templateCode: b.templateCode,
    templateVersionId: ver?.id ?? fid("71", 1),
    toAddressMasked: maskAddress(to as string),
    status: "QUEUED",
    attempts: 0,
    scheduledFor: iso(new Date()),
    nextAttemptAt: iso(new Date()),
    provider: null,
    providerMessageId: null,
    deliveryStatus: null,
    deliveredAt: null,
    lastError: null,
    source: "notification.test",
    refType: null,
    refId: null,
    actorId: ME,
    createdAt: iso(new Date()),
    sentAt: null,
  });
  simulateWorker(id);
  return { outboxId: id, status: "QUEUED" };
});

on("GET", "/notifications/preferences/check", async (_p, q) => {
  const patientId = q.patientId;
  const channel = q.channel as "WHATSAPP" | "SMS" | "EMAIL";
  const purpose = q.purpose as "TRANSACTIONAL" | "REMINDER" | "MARKETING";
  if (!patientId || !channel || !purpose)
    fail(400, "validation_failed", { issues: [{ path: "patientId", message: "Required" }] });
  const patient = patients.find((p) => p.id === patientId);
  if (!patient) fail(404, "patient_not_found");
  const prefs = (await fallback(
    "GET",
    `${API_PREFIX}/patients/${patientId}/communication-preferences`,
    {},
    undefined,
  )) as Items<{ channel: string; purpose: string; optIn: boolean }>;
  const eff = resolveNotificationSettings({ notifications: db.settings });
  const d = resolveConsent(prefs.items, channel, purpose, eff.consent);
  return {
    patientId,
    channel,
    purpose,
    decision: d.decision,
    reason: d.reason,
    hasAddress: channel === "EMAIL" ? Boolean(patient?.email) : Boolean(patient?.phone),
  };
});

on("GET", "/notifications/settings", () => ({
  settings: db.settings,
  effective: resolveNotificationSettings({ notifications: db.settings }),
}));
on("PATCH", "/notifications/settings", (_p, _q, body) => {
  db.settings = parse(notificationSettings, body);
  return {
    settings: db.settings,
    effective: resolveNotificationSettings({ notifications: db.settings }),
  };
});

on("GET", "/notifications/recall-settings", (_p, q) =>
  paginate(
    db.recall.filter((r) => q.active === undefined || String(r.active) === q.active),
    q,
  ),
);
on("PUT", "/notifications/recall-settings", (_p, _q, body) => {
  const b = parse(upsertRecallSettingRequest, body);
  const s = services.find((x) => x.id === b.serviceId);
  if (!s) fail(404, "service_not_found");
  const cur = db.recall.find((r) => r.serviceId === b.serviceId);
  if (cur) {
    Object.assign(cur, {
      intervalDays: b.intervalDays,
      active: b.active,
      updatedAt: iso(new Date()),
    });
    return cur;
  }
  const created: RecallSettingResponse = {
    id: newId("73"),
    serviceId: b.serviceId,
    serviceName: s?.name,
    intervalDays: b.intervalDays,
    active: b.active,
    updatedBy: ME,
    updatedAt: iso(new Date()),
  };
  db.recall.unshift(created);
  return created;
});
on("POST", "/notifications/recall-sweep", () => ({ queued: true }));

on("GET", "/notification-templates", (_p, q) => {
  const f = parse(listNotificationTemplatesQuery, q);
  return paginate(
    db.templates
      .filter(
        (t) =>
          (!f.channel || t.channel === f.channel) &&
          (!f.language || t.language === f.language) &&
          (!f.code || t.code === f.code.toUpperCase()) &&
          (f.active === undefined || t.active === f.active),
      )
      .map(withLatest),
    q,
  );
});
on("POST", "/notification-templates", (_p, _q, body) => {
  const b = parse(createNotificationTemplateRequest, body);
  const sys = (SYSTEM_TEMPLATES as Record<string, { purpose: "TRANSACTIONAL" | "REMINDER" }>)[
    b.code
  ];
  if (sys && b.purpose && b.purpose !== sys.purpose)
    fail(400, "validation_failed", {
      issues: [{ path: "purpose", message: `${b.code} is a ${sys.purpose} template` }],
    });
  assertBody(b.code, b.channel, b.body);
  if (
    db.templates.some(
      (t) => t.code === b.code && t.channel === b.channel && t.language === b.language,
    )
  )
    fail(409, "template_exists", { code: b.code, channel: b.channel, language: b.language });
  const t: TemplateRow = {
    id: newId("70"),
    code: b.code,
    channel: b.channel,
    language: b.language,
    purpose: sys?.purpose ?? b.purpose ?? "TRANSACTIONAL",
    name: b.name,
    active: true,
    currentVersion: 1,
    createdAt: iso(new Date()),
    updatedAt: iso(new Date()),
  };
  db.templates.unshift(t);
  db.versions.push({
    id: newId("71"),
    templateId: t.id,
    version: 1,
    subject: b.subject || null,
    body: b.body,
    placeholders: extractPlaceholders(b.body),
    providerTemplateRef: b.providerTemplateRef || null,
    createdBy: ME,
    createdAt: iso(new Date()),
  });
  return withLatest(t);
});
on("POST", "/notification-templates/preview", (_p, q, body) => {
  const b = parse(previewNotificationTemplateRequest, body);
  const { text, missing } = renderTemplate(b.body, b.variables);
  return {
    text,
    missing,
    unknown: unknownPlaceholders(
      b.body,
      q.code ? placeholdersFor(q.code.toUpperCase()) : undefined,
    ),
  };
});
on("GET", "/notification-templates/:id", ([id]) => withLatest(template(id)));
on("PATCH", "/notification-templates/:id", ([id], _q, body) => {
  const t = template(id);
  const b = parse(updateNotificationTemplateRequest, body);
  if (b.name !== undefined) t.name = b.name;
  if (b.active !== undefined) t.active = b.active;
  t.updatedAt = iso(new Date());
  return withLatest(t);
});
on("GET", "/notification-templates/:id/versions", ([id]) => {
  template(id);
  return {
    items: db.versions.filter((v) => v.templateId === id).sort((a, b) => b.version - a.version),
  };
});
on("POST", "/notification-templates/:id/versions", ([id], _q, body) => {
  const t = template(id);
  const b = parse(publishNotificationTemplateVersionRequest, body);
  assertBody(t.code, t.channel, b.body);
  t.currentVersion += 1;
  t.updatedAt = iso(new Date());
  db.versions.push({
    id: newId("71"),
    templateId: t.id,
    version: t.currentVersion,
    subject: b.subject || null,
    body: b.body,
    placeholders: extractPlaceholders(b.body),
    providerTemplateRef: b.providerTemplateRef || null,
    createdBy: ME,
    createdAt: iso(new Date()),
  });
  return withLatest(t);
});

export const notificationsMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) {
      await sleep(LATENCY_MS);
      return structuredClone(await h(match.slice(1).map(decodeURIComponent), query, body));
    }
  }
  return fallback(method, fullPath, query, body);
};
