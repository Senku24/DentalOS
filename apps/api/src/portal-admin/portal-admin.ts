import { randomUUID } from "node:crypto";
import { PrismaClient, type Tx, withTenant } from "@dentalos/db";
import type { PatientPortalAccount, Prisma } from "@dentalos/db";
import {
  type InvitePortalAccountRequest,
  type ListPortalAccountsQuery,
  PORTAL_DEFAULT_TEMPLATE_BODIES,
  type PortalAccountResponse,
  type PortalOtpChannel,
  type PortalSettingsResponse,
  type ReactivatePortalAccountRequest,
  type SetDocumentPortalVisibleRequest,
  type SetPortalBookableServicesRequest,
  type SuspendPortalAccountRequest,
  type UpdatePortalSettingsRequest,
  defaultOtpChannel,
  invitePortalAccountRequest,
  listPortalAccountsQuery,
  maskDestination,
  normalizeEmail,
  normalizePhoneIN,
  portalSettings,
  reactivatePortalAccountRequest,
  resolveBillingSettings,
  resolvePortalSettings,
  setDocumentPortalVisibleRequest,
  setPortalBookableServicesRequest,
  suspendPortalAccountRequest,
  tenantSettings,
  updatePortalSettingsRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { M4_GUARD_HTTP, isUniqueViolation, m4GuardError } from "../common/db-errors";
import { CurrentPrincipal, assertCan, withBranchScope } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { NotificationEnqueueService } from "../notifications/enqueue.service";

const UUID = new ZodPipe(z.uuid());
const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

const reinviteRequest = invitePortalAccountRequest.omit({ patientId: true });
type ReinviteRequest = z.infer<typeof reinviteRequest>;

const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(ts ?? "");
  if (rest.length > 0 || !z.uuid().safeParse(id).success || Number.isNaN(at.getTime()))
    throw new BadRequestException({ error: "invalid_cursor" });
  return { at, id: id as string };
}

/** DB trigger codes of migration 0009 and the one-account-per-patient key -> stable API errors. */
function mapAdminDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const code = m4GuardError(e);
  if (code) throw new HttpException({ error: code }, M4_GUARD_HTTP[code] ?? 409);
  if (isUniqueViolation(e)) throw new ConflictException({ error: "portal_account_exists" });
  throw e;
}

const TEMPLATE_NAMES = {
  PORTAL_OTP: "Patient portal sign-in code",
  PORTAL_INVITE: "Patient portal invitation",
} as const;
const EMAIL_SUBJECTS = {
  PORTAL_OTP: "Your patient portal code",
  PORTAL_INVITE: "Your patient portal invitation",
} as const;

/** Idempotent: seeds the system templates (all channels, English) the portal needs; existing versions are left alone. */
async function ensurePortalTemplates(tx: Tx, tenantId: string, userId: string) {
  for (const code of ["PORTAL_OTP", "PORTAL_INVITE"] as const)
    for (const channel of ["SMS", "WHATSAPP", "EMAIL"] as const) {
      let t = await tx.notificationTemplate.findFirst({ where: { code, channel, language: "en" } });
      if (!t)
        t = await tx.notificationTemplate.create({
          data: {
            tenantId,
            code,
            channel,
            language: "en",
            purpose: "TRANSACTIONAL",
            name: TEMPLATE_NAMES[code],
            currentVersion: 0,
            createdBy: userId,
          },
        });
      if (t.currentVersion > 0) continue;
      await tx.notificationTemplateVersion.create({
        data: {
          tenantId,
          templateId: t.id,
          version: 1,
          subject: channel === "EMAIL" ? EMAIL_SUBJECTS[code] : null,
          body: PORTAL_DEFAULT_TEMPLATE_BODIES[code][channel],
          createdBy: userId,
        },
      });
      await tx.notificationTemplate.update({ where: { id: t.id }, data: { currentVersion: 1 } });
    }
}

const portalLink = (tenantId: string) =>
  `${(process.env.PORTAL_PUBLIC_URL ?? "http://localhost:3002").replace(/\/+$/, "")}/t/${tenantId}/login`;

type AccountRow = PatientPortalAccount & {
  patient: { firstName: string; lastName: string | null; preferredName: string | null };
};

function toAccount(a: AccountRow, activeSessions: number): PortalAccountResponse {
  return {
    id: a.id,
    patientId: a.patientId,
    patientName: [a.patient.preferredName || a.patient.firstName, a.patient.lastName]
      .filter(Boolean)
      .join(" "),
    status: a.status,
    loginPhoneMasked: a.loginPhone ? maskDestination(a.loginPhone) : null,
    loginEmailMasked: a.loginEmail ? maskDestination(a.loginEmail) : null,
    invitedBy: a.invitedBy,
    invitedAt: iso(a.invitedAt),
    activatedAt: isoOrNull(a.activatedAt),
    suspendedAt: isoOrNull(a.suspendedAt),
    suspendReason: a.suspendReason,
    lastLoginAt: isoOrNull(a.lastLoginAt),
    activeSessions,
  };
}

/**
 * Staff-side portal administration (ADR 0005 §1.5, §3.7): invite / list / suspend / reactivate / re-invite accounts,
 * flag documents portal-visible, portal settings (the master switch included) and bookable services. Source `api`.
 */
@Injectable()
export class PortalAdminService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly outbox: NotificationEnqueueService,
  ) {}

  private record(p: Principal, action: string, resource: string, id?: string, branchId?: string) {
    return this.audit.record(p, { action, resource, resourceId: id, branchId, outcome: "success" });
  }

  // -------------------------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------------------------

  private async withSessions(tx: Tx, rows: AccountRow[]): Promise<PortalAccountResponse[]> {
    if (rows.length === 0) return [];
    const counts = await tx.portalSession.groupBy({
      by: ["accountId"],
      where: {
        accountId: { in: rows.map((r) => r.id) },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      _count: { _all: true },
    });
    const n = new Map(counts.map((c) => [c.accountId, c._count._all]));
    return rows.map((r) => toAccount(r, n.get(r.id) ?? 0));
  }

  private accountInclude = {
    patient: { select: { firstName: true, lastName: true, preferredName: true } },
  } as const;

  async list(p: Principal, q: ListPortalAccountsQuery) {
    assertCan(p, "portal:manage");
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const c = decodeCursor(q.cursor);
      const and: Prisma.PatientPortalAccountWhereInput[] = [];
      if (q.status) and.push({ status: q.status });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.q) {
        const s = q.q.toLowerCase();
        and.push({
          OR: [
            { patient: { nameNormalized: { contains: s } } },
            { loginEmail: { contains: s } },
            { loginPhone: { contains: s.replace(/[^\d+]/g, "") || "~" } },
          ],
        });
      }
      if (c)
        and.push({
          OR: [{ invitedAt: { lt: c.at } }, { invitedAt: c.at, id: { lt: c.id } }],
        });
      const rows = await tx.patientPortalAccount.findMany({
        where: { AND: and },
        include: this.accountInclude,
        orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: await this.withSessions(tx, items),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.invitedAt, last.id) : null,
      };
    });
  }

  async get(p: Principal, id: string) {
    assertCan(p, "portal:manage");
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const a = await tx.patientPortalAccount.findUnique({
        where: { id },
        include: this.accountInclude,
      });
      if (!a) throw new NotFoundException({ error: "portal_account_not_found" });
      return (await this.withSessions(tx, [a]))[0] as PortalAccountResponse;
    });
  }

  /** Destination + channel for the invite message. */
  private inviteTarget(
    a: Pick<PatientPortalAccount, "loginPhone" | "loginEmail">,
    channel?: PortalOtpChannel,
  ): { channel: PortalOtpChannel; to: string } | null {
    if (channel === "EMAIL" && a.loginEmail) return { channel, to: a.loginEmail };
    if ((channel === "SMS" || channel === "WHATSAPP") && a.loginPhone)
      return { channel, to: a.loginPhone };
    if (a.loginPhone) return { channel: defaultOtpChannel("phone"), to: a.loginPhone };
    if (a.loginEmail) return { channel: defaultOtpChannel("email"), to: a.loginEmail };
    return null;
  }

  private async queueInvite(
    tx: Tx,
    p: Principal,
    a: Pick<PatientPortalAccount, "id" | "patientId" | "loginPhone" | "loginEmail">,
    patientName: string,
    channel?: PortalOtpChannel,
  ) {
    await ensurePortalTemplates(tx, p.tenantId, p.userId);
    const target = this.inviteTarget(a, channel);
    if (!target) throw new BadRequestException({ error: "login_destination_required" });
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: p.tenantId },
      select: { name: true },
    });
    // The invitation is a staff-initiated transactional message: it goes out without a preference row (the clinic chose
    // to invite this patient), but the patient's explicit opt-out of the channel is respected.
    const optedOut = await tx.communicationPreference.count({
      where: {
        patientId: a.patientId,
        channel: target.channel,
        purpose: "TRANSACTIONAL",
        optIn: false,
      },
    });
    if (optedOut > 0) throw new ConflictException({ error: "channel_opted_out" });
    const settings = await this.outbox.settings(tx, p.tenantId);
    const r = await this.outbox.enqueue(tx, p.tenantId, settings, {
      actorId: p.userId,
      patientId: null,
      channel: target.channel,
      templateCode: "PORTAL_INVITE",
      toAddress: target.to,
      variables: {
        patientName,
        clinicName: tenant.name,
        portalLink: portalLink(p.tenantId),
      },
      idempotencyKey: `portal-invite:${a.id}:${randomUUID()}`,
      source: "portal.invite",
      refType: "portal_account",
      refId: a.id,
    });
    return r.ok ? r.row : null;
  }

  async invite(p: Principal, body: InvitePortalAccountRequest): Promise<PortalAccountResponse> {
    assertCan(p, "portal:manage");
    const res = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: p.tenantId },
          select: { settings: true },
        });
        if (!resolvePortalSettings(tenant.settings).enabled)
          throw new ConflictException({ error: "portal_disabled" });
        const patient = await tx.patient.findUnique({ where: { id: body.patientId } });
        if (!patient) throw new NotFoundException({ error: "patient_not_found" });
        if (patient.mergedIntoId) throw new ConflictException({ error: "portal_patient_merged" });
        if (!patient.identityVerifiedAt)
          throw new BadRequestException({ error: "portal_identity_unverified" });
        const loginPhone = body.loginPhone ?? normalizePhoneIN(patient.phone);
        const loginEmail = body.loginEmail ?? normalizeEmail(patient.email);
        if (!loginPhone && !loginEmail)
          throw new BadRequestException({ error: "login_destination_required" });
        if (await tx.patientPortalAccount.findFirst({ where: { patientId: patient.id } }))
          throw new ConflictException({ error: "portal_account_exists" });
        const account = await tx.patientPortalAccount.create({
          data: {
            tenantId: p.tenantId,
            patientId: patient.id,
            status: "INVITED",
            loginPhone,
            loginEmail,
            invitedBy: p.userId,
          },
          include: this.accountInclude,
        });
        const row = await this.queueInvite(
          tx,
          p,
          account,
          patient.preferredName || patient.firstName,
          body.channel,
        );
        return { account, row };
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.account.invite", "portal_account", res.account.id);
    if (res.row) await this.outbox.dispatch(p.tenantId, p.userId, res.row).catch(() => null);
    return toAccount(res.account, 0);
  }

  async reinvite(p: Principal, id: string, body: ReinviteRequest): Promise<PortalAccountResponse> {
    assertCan(p, "portal:manage");
    const res = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: p.tenantId },
          select: { settings: true },
        });
        if (!resolvePortalSettings(tenant.settings).enabled)
          throw new ConflictException({ error: "portal_disabled" });
        const cur = await tx.patientPortalAccount.findUnique({
          where: { id },
          include: this.accountInclude,
        });
        if (!cur) throw new NotFoundException({ error: "portal_account_not_found" });
        if (cur.status !== "INVITED")
          throw new ConflictException({ error: "portal_account_state", status: cur.status });
        let account = cur;
        if (body.loginPhone || body.loginEmail)
          account = await tx.patientPortalAccount.update({
            where: { id },
            data: {
              ...(body.loginPhone ? { loginPhone: body.loginPhone } : {}),
              ...(body.loginEmail ? { loginEmail: body.loginEmail } : {}),
            },
            include: this.accountInclude,
          });
        const row = await this.queueInvite(
          tx,
          p,
          account,
          account.patient.preferredName || account.patient.firstName,
          body.channel,
        );
        return { account, row };
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.account.invite", "portal_account", id);
    if (res.row) await this.outbox.dispatch(p.tenantId, p.userId, res.row).catch(() => null);
    return toAccount(res.account, 0);
  }

  async suspend(p: Principal, id: string, body: SuspendPortalAccountRequest) {
    assertCan(p, "portal:manage");
    const out = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.patientPortalAccount.findUnique({ where: { id } });
        if (!cur) throw new NotFoundException({ error: "portal_account_not_found" });
        if (cur.status === "SUSPENDED")
          throw new ConflictException({ error: "portal_account_state", status: cur.status });
        // The database revokes every open session of the account in the same statement (trigger).
        await tx.patientPortalAccount.update({
          where: { id },
          data: {
            status: "SUSPENDED",
            suspendedAt: new Date(),
            suspendedBy: p.userId,
            suspendReason: body.reason,
          },
        });
        const a = await tx.patientPortalAccount.findUniqueOrThrow({
          where: { id },
          include: this.accountInclude,
        });
        return (await this.withSessions(tx, [a]))[0] as PortalAccountResponse;
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.account.suspend", "portal_account", id);
    return out;
  }

  async reactivate(p: Principal, id: string, _body: ReactivatePortalAccountRequest) {
    assertCan(p, "portal:manage");
    const out = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.patientPortalAccount.findUnique({ where: { id } });
        if (!cur) throw new NotFoundException({ error: "portal_account_not_found" });
        if (cur.status !== "SUSPENDED")
          throw new ConflictException({ error: "portal_account_state", status: cur.status });
        // Back to where it was: ACTIVE when it had been activated, INVITED otherwise. Old sessions stay revoked.
        await tx.patientPortalAccount.update({
          where: { id },
          data: {
            status: cur.activatedAt ? "ACTIVE" : "INVITED",
            suspendedAt: null,
            suspendedBy: null,
            suspendReason: null,
          },
        });
        const a = await tx.patientPortalAccount.findUniqueOrThrow({
          where: { id },
          include: this.accountInclude,
        });
        return (await this.withSessions(tx, [a]))[0] as PortalAccountResponse;
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.account.reactivate", "portal_account", id);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------------------------

  async flagDocument(p: Principal, id: string, body: SetDocumentPortalVisibleRequest) {
    assertCan(p, "portal:manage");
    const doc = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const d = await tx.patientDocument.findFirst({ where: withBranchScope(p, { id }) });
        if (!d) throw new NotFoundException({ error: "document_not_found" });
        assertCan(p, "document:write", { branchId: d.branchId });
        if (body.portalVisible) {
          if (d.status !== "AVAILABLE")
            throw new ConflictException({ error: "document_not_available" });
          if (d.category === "ID_PROOF")
            throw new ConflictException({ error: "document_not_shareable" });
        }
        return tx.patientDocument.update({
          where: { id },
          data: {
            portalVisible: body.portalVisible,
            portalVisibleBy: body.portalVisible ? p.userId : null,
            portalVisibleAt: body.portalVisible ? new Date() : null,
          },
        });
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.document.flag", "document", id, doc.branchId);
    return {
      id: doc.id,
      portalVisible: doc.portalVisible,
      portalVisibleBy: doc.portalVisibleBy,
      portalVisibleAt: isoOrNull(doc.portalVisibleAt),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Settings, bookable services
  // -------------------------------------------------------------------------------------------

  private settingsResponse(raw: unknown): PortalSettingsResponse {
    const s = resolvePortalSettings(raw);
    return {
      ...s,
      onlinePaymentsEnabled: resolveBillingSettings(raw).gatewayProvider !== "MANUAL",
    };
  }

  async getSettings(p: Principal): Promise<PortalSettingsResponse> {
    assertCan(p, "portal:admin");
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({
        where: { id: p.tenantId },
        select: { settings: true },
      });
      return this.settingsResponse(t.settings);
    });
  }

  async updateSettings(
    p: Principal,
    body: UpdatePortalSettingsRequest,
  ): Promise<PortalSettingsResponse> {
    assertCan(p, "portal:admin");
    const res = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
        const curSettings = (cur.settings ?? {}) as Record<string, unknown>;
        const stored = portalSettings.safeParse(curSettings.portal ?? {});
        const defined = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
        const merged = { ...(stored.success ? stored.data : {}), ...defined };
        const valid = tenantSettings.safeParse({ ...curSettings, portal: merged });
        if (!valid.success)
          throw new BadRequestException({
            error: "invalid_settings",
            issues: valid.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
        if (body.bookableBranchIds?.length) {
          const found = await tx.branch.count({ where: { id: { in: body.bookableBranchIds } } });
          if (found !== new Set(body.bookableBranchIds).size)
            throw new NotFoundException({ error: "branch_not_found" });
        }
        const next = { ...curSettings, portal: merged };
        await tx.tenant.update({
          where: { id: p.tenantId },
          data: { settings: next as Prisma.InputJsonValue },
        });
        // Enabling the portal seeds the OTP / invite templates (idempotent).
        if (merged.enabled === true) await ensurePortalTemplates(tx, p.tenantId, p.userId);
        return next;
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.settings.update", "Tenant", p.tenantId);
    return this.settingsResponse(res);
  }

  private serviceRow(s: {
    id: string;
    code: string;
    name: string;
    durationMin: number;
    active: boolean;
    portalBookable: boolean;
  }) {
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      durationMin: s.durationMin,
      active: s.active,
      portalBookable: s.portalBookable,
    };
  }

  async listBookableServices(p: Principal) {
    assertCan(p, "portal:admin");
    return withTenant(this.prisma, p.tenantId, async (tx) => ({
      items: (await tx.service.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] })).map((s) =>
        this.serviceRow(s),
      ),
    }));
  }

  async setBookableServices(p: Principal, body: SetPortalBookableServicesRequest) {
    assertCan(p, "portal:admin");
    const ids = [...new Set(body.serviceIds)];
    const items = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const found = await tx.service.count({ where: { id: { in: ids } } });
        if (found !== ids.length) throw new NotFoundException({ error: "service_not_found" });
        await tx.service.updateMany({
          where: { id: { in: ids } },
          data: { portalBookable: body.portalBookable },
        });
        return tx.service.findMany({
          where: { id: { in: ids } },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
      },
      { actorId: p.userId },
    ).catch(mapAdminDbError);
    await this.record(p, "portal.settings.update", "Service", undefined);
    return { items: items.map((s) => this.serviceRow(s)) };
  }
}

@Controller("portal-admin")
export class PortalAdminController {
  constructor(private readonly svc: PortalAdminService) {}

  @Can("portal:manage")
  @Post("accounts")
  invite(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(invitePortalAccountRequest)) body: InvitePortalAccountRequest,
  ) {
    return this.svc.invite(p, body);
  }

  @Can("portal:manage")
  @Get("accounts")
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listPortalAccountsQuery)) q: ListPortalAccountsQuery,
  ) {
    return this.svc.list(p, q);
  }

  @Can("portal:manage")
  @Get("accounts/:id")
  get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.svc.get(p, id);
  }

  @Can("portal:manage")
  @Post("accounts/:id/suspend")
  @HttpCode(200)
  suspend(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(suspendPortalAccountRequest)) body: SuspendPortalAccountRequest,
  ) {
    return this.svc.suspend(p, id, body);
  }

  @Can("portal:manage")
  @Post("accounts/:id/reactivate")
  @HttpCode(200)
  reactivate(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(reactivatePortalAccountRequest)) body: ReactivatePortalAccountRequest,
  ) {
    return this.svc.reactivate(p, id, body);
  }

  @Can("portal:manage")
  @Post("accounts/:id/reinvite")
  @HttpCode(200)
  reinvite(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(reinviteRequest)) body: ReinviteRequest,
  ) {
    return this.svc.reinvite(p, id, body);
  }

  @Can("portal:manage")
  @Patch("documents/:id")
  flagDocument(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(setDocumentPortalVisibleRequest)) body: SetDocumentPortalVisibleRequest,
  ) {
    return this.svc.flagDocument(p, id, body);
  }

  @Can("portal:admin")
  @Get("settings")
  getSettings(@CurrentPrincipal() p: Principal) {
    return this.svc.getSettings(p);
  }

  @Can("portal:admin")
  @Patch("settings")
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(updatePortalSettingsRequest)) body: UpdatePortalSettingsRequest,
  ) {
    return this.svc.updateSettings(p, body);
  }

  @Can("portal:admin")
  @Get("bookable-services")
  listServices(@CurrentPrincipal() p: Principal) {
    return this.svc.listBookableServices(p);
  }

  @Can("portal:admin")
  @Put("bookable-services")
  setServices(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(setPortalBookableServicesRequest)) body: SetPortalBookableServicesRequest,
  ) {
    return this.svc.setBookableServices(p, body);
  }
}

export type { ReinviteRequest };
