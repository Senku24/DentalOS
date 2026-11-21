import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ListRecallSettingsQuery,
  NOTIFICATION_QUEUES,
  type RecallSettingResponse,
  type UpdateNotificationSettingsRequest,
  type UpsertRecallSettingRequest,
  resolveNotificationSettings,
  tenantSettings,
} from "@dentalos/validation";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { JobQueueService } from "../common/job-queue.service";
import { decodeCursor, encodeCursor, mapNotificationDbError } from "./notifications-common";

type RecallRow = Prisma.RecallSettingGetPayload<{
  include: { service: { select: { name: true } } };
}>;
const toRecall = (r: RecallRow): RecallSettingResponse => ({
  id: r.id,
  serviceId: r.serviceId,
  serviceName: r.service.name,
  intervalDays: r.intervalDays,
  active: r.active,
  updatedBy: r.updatedBy,
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * `Tenant.settings.notifications` (channels, reminder offsets, quiet hours, implicit consent, recall lead days) and the
 * per-service recall intervals (`RecallSetting`). All comms:templates (org scope). A recall sweep can be requested on
 * demand besides the daily cron.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(
      mapNotificationDbError,
    );
  }

  private record(p: Principal, action: string, resource: string, id?: string) {
    return this.audit.record(p, { action, resource, resourceId: id, outcome: "success" });
  }

  async getSettings(p: Principal) {
    const t = await this.tx(p, (tx) =>
      tx.tenant.findUnique({ where: { id: p.tenantId }, select: { settings: true } }),
    );
    const raw = (t?.settings as { notifications?: unknown } | null)?.notifications ?? {};
    return { settings: raw, effective: resolveNotificationSettings(t?.settings) };
  }

  /** Replaces the whole `notifications` section (validated by `tenantSettings`); other sections are preserved. */
  async updateSettings(p: Principal, body: UpdateNotificationSettingsRequest) {
    const res = await this.tx(p, async (tx) => {
      // Lock: other writers (billing settings, org settings) update the same JSON column.
      const rows = await tx.$queryRaw<{ settings: unknown }[]>`
        SELECT "settings" FROM "Tenant" WHERE "id" = ${p.tenantId}::uuid FOR UPDATE`;
      const cur = (rows[0]?.settings ?? {}) as Record<string, unknown>;
      const next = tenantSettings.safeParse({ ...cur, notifications: body });
      if (!next.success)
        throw new BadRequestException({
          error: "validation_failed",
          issues: next.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      await tx.tenant.update({
        where: { id: p.tenantId },
        data: { settings: { ...cur, notifications: body } as Prisma.InputJsonValue },
      });
      return { settings: body, effective: resolveNotificationSettings({ notifications: body }) };
    });
    await this.record(p, "notification.settings.update", "tenant", p.tenantId);
    return res;
  }

  async listRecall(p: Principal, q: ListRecallSettingsQuery) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.tx(p, (tx) =>
      tx.recallSetting.findMany({
        where: {
          ...(q.active !== undefined ? { active: q.active } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        include: { service: { select: { name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(toRecall),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** One setting per service: creates it or changes its interval / active flag (never deleted). */
  async upsertRecall(p: Principal, body: UpsertRecallSettingRequest) {
    const res = await this.tx(p, async (tx) => {
      if (!(await tx.service.findUnique({ where: { id: body.serviceId }, select: { id: true } })))
        throw new NotFoundException({ error: "service_not_found" });
      const r = await tx.recallSetting.upsert({
        where: { tenantId_serviceId: { tenantId: p.tenantId, serviceId: body.serviceId } },
        create: {
          tenantId: p.tenantId,
          serviceId: body.serviceId,
          intervalDays: body.intervalDays,
          active: body.active,
          updatedBy: p.userId,
        },
        update: { intervalDays: body.intervalDays, active: body.active, updatedBy: p.userId },
        include: { service: { select: { name: true } } },
      });
      return toRecall(r);
    });
    await this.record(p, "recall.settings.update", "recall_setting", res.id);
    return res;
  }

  /** Requests a recall sweep for this tenant now (the cron does it daily). Returns whether a job was queued. */
  async requestRecallSweep(p: Principal, asOf?: string) {
    const id = await this.jobs.enqueue(NOTIFICATION_QUEUES.RECALL_SWEEP, {
      tenantId: p.tenantId,
      actorId: p.userId,
      source: "api",
      idempotencyKey: `recall-sweep:manual:${crypto.randomUUID()}`,
      data: asOf ? { asOf } : {},
    });
    await this.record(p, "recall.sweep.request", "recall_setting");
    return { queued: id !== null };
  }
}
