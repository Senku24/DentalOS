import { API_PREFIX } from "./routes";

/**
 * Notification paths, aligned with the Wave 1 controllers
 * (apps/api/src/notifications/{notifications,templates}.controller.ts). Kept apart from the frozen
 * `routes.ts` until the Commander merges the tables.
 */
const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const notificationRoutes = {
  /** GET listOutboxQuery -> page(outboxResponse). comms:read */
  outbox: () => p("/notifications/outbox"),
  /** GET -> outboxResponse. comms:read */
  outboxItem: (outboxId: string) => p(`/notifications/outbox/${id(outboxId)}`),
  /** POST (FAILED -> a NEW queued row). comms:send */
  outboxRetry: (outboxId: string) => p(`/notifications/outbox/${id(outboxId)}/retry`),
  /** POST (QUEUED -> FAILED "cancelled"). comms:send */
  outboxCancel: (outboxId: string) => p(`/notifications/outbox/${id(outboxId)}/cancel`),
  /** POST sendTestNotificationRequest -> { outboxId, status }. comms:templates ONLY */
  test: () => p("/notifications/test"),
  /** GET checkPreferencesQuery -> preferenceCheckResponse. comms:read */
  preferencesCheck: () => p("/notifications/preferences/check"),
  /** GET -> { settings, effective }, PATCH updateNotificationSettingsRequest. comms:templates */
  settings: () => p("/notifications/settings"),
  /** GET listRecallSettingsQuery -> page, PUT upsertRecallSettingRequest. comms:templates */
  recallSettings: () => p("/notifications/recall-settings"),
  /** POST { asOf? } -> 202 { queued }. comms:templates */
  recallSweep: () => p("/notifications/recall-sweep"),

  /** GET listNotificationTemplatesQuery -> page (comms:read), POST createNotificationTemplateRequest */
  templates: () => p("/notification-templates"),
  /** POST previewNotificationTemplateRequest (?code=) -> { text, missing, unknown } */
  templatePreview: () => p("/notification-templates/preview"),
  /** GET (comms:read), PATCH updateNotificationTemplateRequest ({ name?, active? }) */
  template: (templateId: string) => p(`/notification-templates/${id(templateId)}`),
  /** GET -> { items } newest first (comms:read), POST publishNotificationTemplateVersionRequest */
  templateVersions: (templateId: string) => p(`/notification-templates/${id(templateId)}/versions`),
};
