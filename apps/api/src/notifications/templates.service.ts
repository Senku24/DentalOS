import {
  type NotificationTemplate,
  type Prisma,
  PrismaClient,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  type CreateNotificationTemplateRequest,
  type ListNotificationTemplatesQuery,
  type PreviewNotificationTemplateRequest,
  type PublishNotificationTemplateVersionRequest,
  SYSTEM_TEMPLATES,
  type UpdateNotificationTemplateRequest,
  placeholdersFor,
  renderTemplate,
  unknownPlaceholders,
  validateTemplateBody,
} from "@dentalos/validation";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { isUniqueViolation } from "../common/db-errors";
import {
  badField,
  decodeCursor,
  encodeCursor,
  mapNotificationDbError,
  templateNotFound,
  toTemplate,
  toVersion,
} from "./notifications-common";

const withLatest = { versions: { orderBy: { version: "desc" as const }, take: 1 } };

/**
 * Notification templates (comms:templates, org scope): `code + channel + language` identify a template, its text lives in
 * append-only versions (a published version is immutable; outbox rows pin the exact version). Bodies may only use the
 * placeholders of their code (`SYSTEM_TEMPLATES`) and the per-channel length limit (`validateTemplateBody`).
 * Templates are deactivated, never deleted.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>) {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(
      mapNotificationDbError,
    );
  }

  private record(p: Principal, action: string, id: string) {
    return this.audit.record(p, {
      action,
      resource: "notification_template",
      resourceId: id,
      outcome: "success",
    });
  }

  /** 400 with the stable code (`template_placeholder_unknown` lists the offending placeholder names). */
  private assertBody(
    code: string,
    channel: CreateNotificationTemplateRequest["channel"],
    body: string,
  ) {
    const issues = validateTemplateBody(code, channel, body);
    if (issues.includes("template_placeholder_unknown"))
      throw new BadRequestException({
        error: "template_placeholder_unknown",
        placeholders: unknownPlaceholders(body, placeholdersFor(code)),
        allowed: placeholdersFor(code),
      });
    if (issues.includes("template_body_too_long"))
      throw new BadRequestException({ error: "template_body_too_long" });
  }

  async list(p: Principal, q: ListNotificationTemplatesQuery) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.tx(p, (tx) =>
      tx.notificationTemplate.findMany({
        where: {
          ...(q.channel ? { channel: q.channel } : {}),
          ...(q.language ? { language: q.language } : {}),
          ...(q.code ? { code: q.code.toUpperCase() } : {}),
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
        include: withLatest,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((t) => toTemplate(t, t.versions[0])),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async get(p: Principal, id: string) {
    return this.tx(p, async (tx) => {
      const t = await tx.notificationTemplate.findUnique({ where: { id }, include: withLatest });
      if (!t) throw templateNotFound();
      return toTemplate(t, t.versions[0]);
    });
  }

  async versions(p: Principal, id: string) {
    return this.tx(p, async (tx) => {
      if (!(await tx.notificationTemplate.findUnique({ where: { id }, select: { id: true } })))
        throw templateNotFound();
      const rows = await tx.notificationTemplateVersion.findMany({
        where: { templateId: id },
        orderBy: { version: "desc" },
      });
      return { items: rows.map(toVersion) };
    });
  }

  /** Creates the template and publishes its version 1 in one transaction. */
  async create(p: Principal, body: CreateNotificationTemplateRequest) {
    const system = (
      SYSTEM_TEMPLATES as Record<string, { purpose: NotificationTemplate["purpose"] }>
    )[body.code];
    if (system && body.purpose && body.purpose !== system.purpose)
      throw badField("purpose", `${body.code} is a ${system.purpose} template`);
    this.assertBody(body.code, body.channel, body.body);
    let res: ReturnType<typeof toTemplate>;
    try {
      res = await this.tx(p, async (tx) => {
        const t = await tx.notificationTemplate.create({
          data: {
            tenantId: p.tenantId,
            code: body.code,
            channel: body.channel,
            language: body.language,
            purpose: system?.purpose ?? body.purpose ?? "TRANSACTIONAL",
            name: body.name,
            currentVersion: 1,
            createdBy: p.userId,
          },
        });
        const v = await tx.notificationTemplateVersion.create({
          data: {
            tenantId: p.tenantId,
            templateId: t.id,
            version: 1,
            subject: body.subject || null,
            body: body.body,
            providerTemplateRef: body.providerTemplateRef || null,
            createdBy: p.userId,
          },
        });
        return toTemplate(t, v);
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictException({
          error: "template_exists",
          code: body.code,
          channel: body.channel,
          language: body.language,
        });
      throw e;
    }
    await this.record(p, "notification.template.create", res.id);
    return res;
  }

  /** Metadata only (name, active). Text changes publish a new version. */
  async update(p: Principal, id: string, body: UpdateNotificationTemplateRequest) {
    const res = await this.tx(p, async (tx) => {
      if (!(await tx.notificationTemplate.findUnique({ where: { id }, select: { id: true } })))
        throw templateNotFound();
      const data: Prisma.NotificationTemplateUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.active !== undefined) data.active = body.active;
      if (Object.keys(data).length > 0)
        await tx.notificationTemplate.update({ where: { id }, data });
      const t = await tx.notificationTemplate.findUniqueOrThrow({
        where: { id },
        include: withLatest,
      });
      return toTemplate(t, t.versions[0]);
    });
    await this.record(p, "notification.template.update", id);
    return res;
  }

  /** Publishes version N+1 (append-only). The template row is locked so version numbers stay a strict sequence. */
  async publish(p: Principal, id: string, body: PublishNotificationTemplateVersionRequest) {
    const res = await this.tx(p, async (tx) => {
      const rows = await tx.$queryRaw<{ code: string; channel: string; currentVersion: number }[]>`
        SELECT "code", "channel"::text AS "channel", "currentVersion" FROM "NotificationTemplate"
        WHERE "id" = ${id}::uuid FOR UPDATE`;
      const cur = rows[0];
      if (!cur) throw templateNotFound();
      this.assertBody(
        cur.code,
        cur.channel as CreateNotificationTemplateRequest["channel"],
        body.body,
      );
      const version = cur.currentVersion + 1;
      const v = await tx.notificationTemplateVersion.create({
        data: {
          tenantId: p.tenantId,
          templateId: id,
          version,
          subject: body.subject || null,
          body: body.body,
          providerTemplateRef: body.providerTemplateRef || null,
          createdBy: p.userId,
        },
      });
      const t = await tx.notificationTemplate.update({
        where: { id },
        data: { currentVersion: version },
      });
      return toTemplate(t, v);
    });
    await this.record(p, "notification.template.publish", id);
    return res;
  }

  /** Renders a draft body with sample values (nothing is stored or sent). `code` (query) enables the unknown-placeholder check. */
  preview(body: PreviewNotificationTemplateRequest, code?: string) {
    const { text, missing } = renderTemplate(body.body, body.variables);
    return {
      text,
      missing,
      unknown: unknownPlaceholders(
        body.body,
        code ? placeholdersFor(code.toUpperCase()) : undefined,
      ),
    };
  }
}
