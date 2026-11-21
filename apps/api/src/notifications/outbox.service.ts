import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type CheckPreferencesQuery,
  type ListOutboxQuery,
  type PreferenceCheckResponse,
  type SendTestNotificationRequest,
  normalizeEmail,
  normalizePhoneIN,
  resolveConsent,
  z,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { assertCan, withBranchScope } from "../common/principal";
import { NotificationEnqueueService } from "./enqueue.service";
import {
  badField,
  decodeCursor,
  encodeCursor,
  mapNotificationDbError,
  outboxNotFound,
  toOutbox,
} from "./notifications-common";

/**
 * Outbox: list / get / retry failed / cancel queued (comms:read / comms:send, branch scoped — a row without a branch,
 * such as a test message, is visible to org-wide principals only), test send (comms:templates ONLY, never comms:send:
 * `toAddress` would be an open relay) and the consent preview endpoint. Status moves only along the DB-allowed paths
 * (QUEUED is the only status that can change; FAILED / SENT / SKIPPED are final).
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly enq: NotificationEnqueueService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(
      mapNotificationDbError,
    );
  }

  private record(p: Principal, action: string, id: string, branchId?: string | null) {
    return this.audit.record(p, {
      action,
      resource: "notification_outbox",
      resourceId: id,
      branchId: branchId ?? undefined,
      outcome: "success",
    });
  }

  async list(p: Principal, q: ListOutboxQuery) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const and: Prisma.NotificationOutboxWhereInput[] = [withBranchScope(p, {})];
    if (q.branchId) and.push({ branchId: q.branchId });
    if (q.patientId) and.push({ patientId: q.patientId });
    if (q.status) and.push({ status: q.status });
    if (q.channel) and.push({ channel: q.channel });
    if (q.templateCode) and.push({ templateCode: q.templateCode.toUpperCase() });
    if (q.refType) and.push({ refType: q.refType });
    if (q.refId) and.push({ refId: q.refId });
    if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
    if (q.to)
      and.push({
        createdAt: { lt: new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000) },
      });
    if (cursor)
      and.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      });
    const rows = await this.tx(p, (tx) =>
      tx.notificationOutbox.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(toOutbox),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** Loads a row within the caller's branch scope (a foreign / out-of-scope id is a 404). */
  private async find(tx: Tx, p: Principal, id: string) {
    const row = await tx.notificationOutbox.findFirst({
      where: withBranchScope(p, { id }),
    });
    if (!row) throw outboxNotFound();
    return row;
  }

  async get(p: Principal, id: string) {
    return toOutbox(await this.tx(p, (tx) => this.find(tx, p, id)));
  }

  /** FAILED -> a new QUEUED row (idempotent: key `retry:<id>`), consent and quiet hours re-evaluated. */
  async retry(p: Principal, id: string) {
    const { row, created } = await this.tx(p, async (tx) => {
      const orig = await this.find(tx, p, id);
      assertCan(p, "comms:send", { branchId: orig.branchId ?? undefined });
      if (orig.status !== "FAILED")
        throw new ConflictException({ error: "notification_state", status: orig.status });
      const settings = await this.enq.settings(tx, p.tenantId);
      return this.enq.retry(tx, p.tenantId, settings, orig, p.userId);
    });
    if (created) {
      await this.record(p, "notification.retry", row.id, row.branchId);
      await this.enq.dispatch(p.tenantId, p.userId, row);
    }
    return toOutbox(row);
  }

  /** QUEUED -> FAILED (`lastError = cancelled`): the pending job finds a non-QUEUED row and does nothing. */
  async cancel(p: Principal, id: string) {
    const row = await this.tx(p, async (tx) => {
      const cur = await this.find(tx, p, id);
      assertCan(p, "comms:send", { branchId: cur.branchId ?? undefined });
      const n = await tx.notificationOutbox.updateMany({
        where: { id, status: "QUEUED" },
        data: { status: "FAILED", lastError: "cancelled", nextAttemptAt: null },
      });
      if (n.count === 0)
        throw new ConflictException({ error: "notification_state", status: cur.status });
      return tx.notificationOutbox.findUniqueOrThrow({ where: { id } });
    });
    await this.record(p, "notification.cancel", id, row.branchId);
    return toOutbox(row);
  }

  /**
   * Sends a template through the real pipeline (outbox + send job) to an arbitrary address, without a patient (so no
   * consent row applies). comms:templates only (org-wide OWNER).
   */
  async sendTest(p: Principal, body: SendTestNotificationRequest) {
    const toAddress =
      body.channel === "EMAIL"
        ? (() => {
            const e = normalizeEmail(body.toAddress);
            return e && z.email().safeParse(e).success ? e : null;
          })()
        : normalizePhoneIN(body.toAddress);
    if (!toAddress)
      throw badField("toAddress", "Invalid address for the channel", "address_invalid");
    const res = await this.tx(p, async (tx) => {
      if (
        body.branchId &&
        !(await tx.branch.findUnique({ where: { id: body.branchId }, select: { id: true } }))
      )
        throw badField("branchId", "Unknown branch");
      const settings = await this.enq.settings(tx, p.tenantId);
      const r = await this.enq.enqueue(tx, p.tenantId, settings, {
        actorId: p.userId,
        branchId: body.branchId ?? null,
        channel: body.channel,
        templateCode: body.templateCode,
        language: body.language,
        toAddress,
        variables: body.variables,
        idempotencyKey: `test:${crypto.randomUUID()}`,
        source: "notification.test",
      });
      if (!r.ok) {
        if (r.reason === "channel_disabled")
          throw new ConflictException({ error: "channel_disabled" });
        throw new NotFoundException({ error: "template_not_found" });
      }
      return r.row;
    });
    await this.record(p, "notification.send_test", res.id, res.branchId);
    await this.enq.dispatch(p.tenantId, p.userId, res);
    return { outboxId: res.id, status: res.status };
  }

  /** Would a message of this purpose reach the patient on this channel (consent rule of ADR 0004 §9.3)? */
  async checkPreferences(p: Principal, q: CheckPreferencesQuery): Promise<PreferenceCheckResponse> {
    return this.tx(p, async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id: q.patientId } });
      if (!patient) throw new NotFoundException({ error: "patient_not_found" });
      const [prefs, settings] = await Promise.all([
        tx.communicationPreference.findMany({
          where: { patientId: q.patientId },
          select: { channel: true, purpose: true, optIn: true },
        }),
        this.enq.settings(tx, p.tenantId),
      ]);
      const d = resolveConsent(prefs, q.channel, q.purpose, settings.consent);
      return {
        patientId: q.patientId,
        channel: q.channel,
        purpose: q.purpose,
        decision: d.decision,
        reason: d.reason,
        hasAddress: !!(q.channel === "EMAIL" ? patient.emailNormalized : patient.phoneNormalized),
      };
    });
  }
}
