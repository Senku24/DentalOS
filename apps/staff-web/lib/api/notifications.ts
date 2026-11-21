import type {
  CheckPreferencesQuery,
  CreateNotificationTemplateRequest,
  ListNotificationTemplatesQuery,
  ListOutboxQuery,
  ListRecallSettingsQuery,
  NotificationSettings,
  NotificationTemplateResponse,
  NotificationTemplateVersionResponse,
  OutboxResponse,
  PreferenceCheckResponse,
  PreviewNotificationTemplateRequest,
  PreviewNotificationTemplateResponse,
  PublishNotificationTemplateVersionRequest,
  RecallSettingResponse,
  ResolvedNotificationSettings,
  SendTestNotificationRequest,
  SendTestNotificationResponse,
  UpdateNotificationTemplateRequest,
  UpsertRecallSettingRequest,
} from "@dentalos/validation";
import type { ApiClient } from "./client";
import { notificationsClient } from "./notifications-client";
import { notificationRoutes as r } from "./notifications-routes";
import type { Items, Page } from "./types";

export interface NotificationSettingsResponse {
  /** The raw `notifications` section as stored (PATCH replaces all of it). */
  settings: NotificationSettings;
  /** Defaults applied. */
  effective: ResolvedNotificationSettings;
}

export type OutboxQuery = Partial<Omit<ListOutboxQuery, "limit">> & { limit?: number };
export type TemplateQuery = Partial<Omit<ListNotificationTemplatesQuery, "limit">> & {
  limit?: number;
};

/** Typed notifications surface: outbox, templates, test send, consent preview, settings, recall. */
export function createNotificationsApi(c: ApiClient) {
  const get = <T>(path: string, query?: object) =>
    c.request<T>("GET", path, { query: query as Record<string, string> });
  const send = <T>(method: "POST" | "PATCH" | "PUT", path: string, body?: unknown) =>
    c.request<T>(method, path, { body: body ?? {} });

  return {
    outbox: {
      list: (q: OutboxQuery) => get<Page<OutboxResponse>>(r.outbox(), q),
      get: (id: string) => get<OutboxResponse>(r.outboxItem(id)),
      retry: (id: string) => send<OutboxResponse>("POST", r.outboxRetry(id)),
      cancel: (id: string) => send<OutboxResponse>("POST", r.outboxCancel(id)),
    },
    sendTest: (
      b: Partial<SendTestNotificationRequest> &
        Pick<SendTestNotificationRequest, "channel" | "toAddress">,
    ) => send<SendTestNotificationResponse>("POST", r.test(), b),
    checkPreferences: (q: CheckPreferencesQuery) =>
      get<PreferenceCheckResponse>(r.preferencesCheck(), q),
    settings: {
      get: () => get<NotificationSettingsResponse>(r.settings()),
      update: (b: NotificationSettings) =>
        send<NotificationSettingsResponse>("PATCH", r.settings(), b),
    },
    recall: {
      list: (q: Partial<ListRecallSettingsQuery> = {}) =>
        get<Page<RecallSettingResponse>>(r.recallSettings(), q),
      upsert: (b: UpsertRecallSettingRequest) =>
        send<RecallSettingResponse>("PUT", r.recallSettings(), b),
      sweep: (asOf?: string) =>
        send<{ queued: boolean }>("POST", r.recallSweep(), asOf ? { asOf } : {}),
    },
    templates: {
      list: (q: TemplateQuery = {}) => get<Page<NotificationTemplateResponse>>(r.templates(), q),
      get: (id: string) => get<NotificationTemplateResponse>(r.template(id)),
      create: (
        b: Partial<CreateNotificationTemplateRequest> &
          Pick<CreateNotificationTemplateRequest, "code" | "channel" | "name" | "body">,
      ) => send<NotificationTemplateResponse>("POST", r.templates(), b),
      update: (id: string, b: UpdateNotificationTemplateRequest) =>
        send<NotificationTemplateResponse>("PATCH", r.template(id), b),
      versions: (id: string) =>
        get<Items<NotificationTemplateVersionResponse>>(r.templateVersions(id)),
      publish: (id: string, b: PublishNotificationTemplateVersionRequest) =>
        send<NotificationTemplateResponse>("POST", r.templateVersions(id), b),
      /** Server-side render (same helper as the send job). `code` enables the unknown-placeholder check. */
      preview: (b: PreviewNotificationTemplateRequest, code?: string) =>
        c.request<PreviewNotificationTemplateResponse>("POST", r.templatePreview(), {
          body: b,
          query: code ? { code } : undefined,
        }),
    },
  };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;
export const notificationsApi: NotificationsApi = createNotificationsApi(notificationsClient);
