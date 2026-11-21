import type {
  NotificationOutbox,
  NotificationTemplate,
  NotificationTemplateVersion,
} from "@dentalos/db";
import {
  type NotificationTemplateResponse,
  type NotificationTemplateVersionResponse,
  type OutboxResponse,
  extractPlaceholders,
  maskAddress,
  placeholdersFor,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  M3_GUARD_HTTP,
  isRetryableTxError,
  m3GuardError,
  privilegeDenied,
} from "../common/db-errors";

export const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------------------------
// Errors (stable codes: NOTIFICATION_ERROR_CODES + a few resource codes)
// ---------------------------------------------------------------------------------------------

export const templateNotFound = () => new NotFoundException({ error: "template_not_found" });
export const outboxNotFound = () => new NotFoundException({ error: "outbox_not_found" });
export const badField = (path: string, message: string, error = "validation_failed") =>
  new BadRequestException({ error, issues: [{ path, message }] });

/**
 * Maps database-enforced rules to API errors: M3 trigger codes (notification_state ...), deadlock / serialization
 * (409 retry_later), and privilege errors (a programming error: logged by the exception filter, answered 500).
 */
export function mapNotificationDbError(e: unknown): never {
  const g = m3GuardError(e);
  if (g) {
    const status = M3_GUARD_HTTP[g];
    if (status === 500) throw new InternalServerErrorException({ error: g });
    if (status === 400) throw new BadRequestException({ error: g });
    throw new ConflictException({ error: g });
  }
  if (isRetryableTxError(e)) throw new ConflictException({ error: "retry_later" });
  if (privilegeDenied(e)) throw new InternalServerErrorException({ error: "internal_error" });
  throw e;
}

// ---------------------------------------------------------------------------------------------
// Keyset cursor (createdAt desc, id desc)
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badField("cursor", "Invalid cursor");
  return { createdAt, id: id as string };
}

// ---------------------------------------------------------------------------------------------
// Response mappers (never expose toAddress or variables: masked address only)
// ---------------------------------------------------------------------------------------------

export const toOutbox = (r: NotificationOutbox): OutboxResponse => ({
  id: r.id,
  branchId: r.branchId,
  patientId: r.patientId,
  channel: r.channel as OutboxResponse["channel"],
  purpose: r.purpose,
  templateCode: r.templateCode,
  templateVersionId: r.templateVersionId,
  toAddressMasked: maskAddress(r.toAddress),
  status: r.status,
  attempts: r.attempts,
  scheduledFor: r.scheduledFor.toISOString(),
  nextAttemptAt: iso(r.nextAttemptAt),
  provider: r.provider,
  providerMessageId: r.providerMessageId,
  deliveryStatus: r.deliveryStatus,
  deliveredAt: iso(r.deliveredAt),
  lastError: r.lastError,
  source: r.source,
  refType: r.refType,
  refId: r.refId,
  actorId: r.actorId,
  createdAt: r.createdAt.toISOString(),
  sentAt: iso(r.sentAt),
});

export const toVersion = (v: NotificationTemplateVersion): NotificationTemplateVersionResponse => ({
  id: v.id,
  templateId: v.templateId,
  version: v.version,
  subject: v.subject,
  body: v.body,
  placeholders: extractPlaceholders(v.body),
  providerTemplateRef: v.providerTemplateRef,
  createdBy: v.createdBy,
  createdAt: v.createdAt.toISOString(),
});

export const toTemplate = (
  t: NotificationTemplate,
  latest: NotificationTemplateVersion | undefined | null,
): NotificationTemplateResponse => ({
  id: t.id,
  code: t.code,
  channel: t.channel as NotificationTemplateResponse["channel"],
  language: t.language,
  purpose: t.purpose,
  name: t.name,
  active: t.active,
  currentVersion: t.currentVersion,
  allowedPlaceholders: placeholdersFor(t.code)
    ? [...(placeholdersFor(t.code) as readonly string[])]
    : null,
  latest: latest ? toVersion(latest) : null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});
