import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { webhookSecrets } from "@dentalos/config";
import { PrismaClient, withTenant } from "@dentalos/db";
import {
  type DeliveryReceiptPayload,
  GATEWAY_SIGNATURE_HEADER,
  deliveryReceiptPayload,
  isWebhookTimestampFresh,
  parseWebhookSignatureHeader,
} from "@dentalos/validation";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { mapNotificationDbError } from "./notifications-common";

const RANK: Record<string, number> = { failed: -1, queued: 0, sent: 1, delivered: 2, read: 3 };
class Rollback extends Error {}

/**
 * Provider delivery receipts (ADR 0004 §9.2), public route with a signed body:
 *  1. HMAC over the RAW body ("t.body", header x-dentalos-signature, secret from `webhookSecrets(provider, tenantId)`,
 *     constant-time compare, several secrets / v1 values for rotation, 5-minute timestamp window) -> else 401
 *     `webhook_signature_invalid`; no configured secret also answers 401 (never accept unsigned).
 *  2. ONE transaction: `RequestDedupe(notification.delivery:<provider>, eventId)` inserted FIRST (a replay inserts
 *     nothing and answers 200 `duplicate: true`), then the append-only `NotificationDeliveryEvent`, then the outbox
 *     `deliveryStatus` / `deliveredAt` (never regresses: delivered / read win over late sent receipts) and the audit row
 *     (ids only, source `webhook:<provider>`). Any failure rolls all of it back and answers 5xx so the provider retries.
 *  A receipt for a provider message id we do not know yet is a 404 and stores nothing (it may race ahead of our own
 *  SENT update and succeed on retry). The message content and status SENT are never edited (the DB forbids it).
 */
@Injectable()
export class DeliveryService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private verify(provider: string, tenantId: string, header: string | undefined, raw: Buffer) {
    const secrets = webhookSecrets(provider, tenantId);
    const parsed = parseWebhookSignatureHeader(header);
    const bad = () => new UnauthorizedException({ error: "webhook_signature_invalid" });
    if (secrets.length === 0 || !parsed) throw bad();
    if (!isWebhookTimestampFresh(parsed.timestamp, Math.floor(Date.now() / 1000))) throw bad();
    const ok = secrets.some((s) => {
      const expected = createHmac("sha256", s).update(`${parsed.timestamp}.`).update(raw).digest();
      return parsed.signatures.some((sig) => {
        const got = Buffer.from(sig, "hex");
        return got.length === expected.length && timingSafeEqual(got, expected);
      });
    });
    if (!ok) throw bad();
  }

  async receipt(
    provider: string,
    tenantId: string,
    headers: Record<string, string | string[] | undefined>,
    raw: Buffer | undefined,
  ) {
    if (!raw) throw new BadRequestException({ error: "validation_failed" });
    const sigHeader = headers[GATEWAY_SIGNATURE_HEADER];
    this.verify(provider, tenantId, Array.isArray(sigHeader) ? sigHeader[0] : sigHeader, raw);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new BadRequestException({ error: "validation_failed" });
    }
    const parsed = deliveryReceiptPayload.safeParse(json);
    if (!parsed.success)
      throw new BadRequestException({
        error: "validation_failed",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    return this.apply(
      provider,
      tenantId,
      parsed.data,
      createHash("sha256").update(raw).digest("hex"),
    );
  }

  private async apply(
    provider: string,
    tenantId: string,
    ev: DeliveryReceiptPayload,
    bodyHash: string,
  ): Promise<{ ok: true; duplicate: boolean }> {
    const source = `webhook:${provider.toLowerCase()}`;
    const occurredAt = new Date(ev.occurredAt);
    try {
      return await withTenant(
        this.prisma,
        tenantId,
        async (tx) => {
          const claimed = await tx.requestDedupe.createMany({
            data: [
              {
                tenantId,
                scope: `notification.delivery:${provider.toLowerCase()}`,
                idempotencyKey: ev.eventId,
                requestHash: bodyHash,
                createdBy: source,
              },
            ],
            skipDuplicates: true,
          });
          if (claimed.count === 0) return { ok: true as const, duplicate: true };
          const msg = await tx.notificationOutbox.findFirst({
            where: {
              provider: provider.toUpperCase(),
              providerMessageId: ev.providerMessageId,
            },
          });
          if (!msg) throw new Rollback();
          await tx.notificationDeliveryEvent.create({
            data: {
              tenantId,
              outboxId: msg.id,
              status: ev.status,
              providerMessageId: ev.providerMessageId,
              errorCode: ev.errorCode ?? null,
              occurredAt,
            },
          });
          const cur = msg.deliveryStatus;
          const advance =
            ev.status === "failed"
              ? cur !== "delivered" && cur !== "read"
              : (RANK[ev.status] ?? 0) > (RANK[cur ?? ""] ?? -2);
          if (advance) {
            await tx.notificationOutbox.update({
              where: { id: msg.id },
              data: {
                deliveryStatus: ev.status,
                ...((ev.status === "delivered" || ev.status === "read") && !msg.deliveredAt
                  ? { deliveredAt: occurredAt }
                  : {}),
                ...(ev.status === "failed"
                  ? { lastError: `delivery_failed:${ev.errorCode ?? "unknown"}`.slice(0, 120) }
                  : {}),
              },
            });
          }
          await tx.auditEvent.create({
            data: {
              tenantId,
              actorId: source,
              source,
              branchId: msg.branchId,
              action: "notification.delivery.receipt",
              resource: "notification_outbox",
              resourceId: ev.eventId,
              outcome: "success",
            },
          });
          return { ok: true as const, duplicate: false };
        },
        { actorId: source },
      );
    } catch (e) {
      if (e instanceof Rollback) throw new NotFoundException({ error: "outbox_not_found" });
      return mapNotificationDbError(e);
    }
  }
}
