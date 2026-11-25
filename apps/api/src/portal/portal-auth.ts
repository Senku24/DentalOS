import { randomUUID } from "node:crypto";
import { type PatientPortalAccount, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  PORTAL_ACCESS_TOKEN_TTL_SECONDS,
  PORTAL_OTP_RATE_LIMITS,
  PORTAL_OTP_TTL_MINUTES,
  PORTAL_REFRESH_TTL_DAYS,
  PORTAL_SELECTION_TTL_SECONDS,
  PORTAL_SESSION_ABSOLUTE_DAYS,
  type PortalLogoutRequest,
  type PortalMeResponse,
  type PortalOtpChannel,
  type PortalOtpRequest,
  type PortalOtpResponse,
  type PortalRefreshRequest,
  type PortalSelectAccountRequest,
  type PortalSessionResponse,
  type PortalStepUpRequest,
  type PortalStepUpResponse,
  type PortalStepUpVerifyRequest,
  type PortalTokens,
  type PortalVerifyOtpRequest,
  type PortalVerifyOtpResponse,
  defaultOtpChannel,
  generateRefreshToken,
  isStepUpFresh,
  maskDestination,
  parseRefreshToken,
  portalLogoutRequest,
  portalOtpRequest,
  portalRefreshRequest,
  portalSelectAccountRequest,
  portalStepUpRequest,
  portalStepUpVerifyRequest,
  portalVerifyOtpRequest,
  resolveBillingSettings,
  resolvePortalSettings,
  sha256Hex,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/auth.guard";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PORTAL_ANONYMOUS_ACTOR, PortalAuditService } from "../auth/portal-audit";
import {
  PORTAL_SECRETS,
  PORTAL_TOKEN_SERVICE,
  type PortalSecrets,
  type PortalTokenService,
} from "../auth/portal-token";
import { PortalAuth } from "../auth/portal.guard";
import { isUniqueViolation } from "../common/db-errors";
import { ZodPipe } from "../common/zod.pipe";
import {
  UUID,
  badRequest,
  clientHashes,
  conflict,
  displayName,
  isMinor,
  iso,
  isoOrNull,
  mapPortalDbError,
  notFound,
  secretsOr503,
} from "./portal-common";
import { PortalOtpService } from "./portal-otp.service";

const DAY = 86_400_000;
const LOGIN_PURPOSES = ["LOGIN", "ACTIVATE"] as const;

const channelFor = (kind: "phone" | "email", requested?: PortalOtpChannel): PortalOtpChannel => {
  if (kind === "email") return "EMAIL";
  return requested === "WHATSAPP" ? "WHATSAPP" : defaultOtpChannel(kind);
};

type AccountWithPatient = PatientPortalAccount & {
  patient: {
    firstName: string;
    lastName: string | null;
    preferredName: string | null;
    dob: Date | null;
  };
};

/**
 * Portal authentication (ADR 0005 §1): OTP request / verify / account picker, refresh with rotation and reuse detection,
 * logout, step-up, "me" and "my sessions". Public routes answer identically for known and unknown destinations.
 */
@Injectable()
export class PortalAuthService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(PORTAL_SECRETS) private readonly secrets: PortalSecrets | null,
    @Inject(PORTAL_TOKEN_SERVICE) private readonly tokens: PortalTokenService,
    private readonly audit: PortalAuditService,
    private readonly otps: PortalOtpService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Login: request a code
  // -------------------------------------------------------------------------------------------

  async requestOtp(body: PortalOtpRequest, req: Request): Promise<PortalOtpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    const dest = body.destination;
    const kind = dest.includes("@") ? "email" : "phone";
    const channel = channelFor(kind, body.channel);
    const { ipHash } = await clientHashes(req, sec.pepper);
    const neutral = (challengeId: string): PortalOtpResponse => ({
      challengeId,
      maskedDestination: maskDestination(dest),
      channel,
      expiresInSeconds: PORTAL_OTP_TTL_MINUTES * 60,
      resendAfterSeconds: PORTAL_OTP_RATE_LIMITS.resendCooldownSeconds,
    });

    const r = await withTenant(
      this.prisma,
      body.tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: body.tenantId },
          select: { name: true, settings: true },
        });
        if (!tenant) return { kind: "unknown" as const };
        if (!resolvePortalSettings(tenant.settings).enabled) return { kind: "disabled" as const };
        const rate = await this.otps.checkRate(tx, sec, dest, ipHash, now, LOGIN_PURPOSES);
        if (!rate.allowed) return { kind: "limited" as const, retry: rate.retryAfterSeconds };
        const matches = await tx.patientPortalAccount.findMany({
          where: {
            status: { in: ["INVITED", "ACTIVE"] },
            ...(kind === "phone" ? { loginPhone: dest } : { loginEmail: dest }),
          },
          select: { id: true, patientId: true, status: true },
          take: 10,
          orderBy: { id: "asc" },
        });
        // A decoy row for a destination without an account keeps the throttle (and the answer) identical.
        const issued = await this.otps.issue(
          tx,
          sec,
          {
            tenantId: body.tenantId,
            purpose:
              matches.length > 0 && matches.every((m) => m.status === "INVITED")
                ? "ACTIVATE"
                : "LOGIN",
            accountId: matches.length === 1 ? (matches[0]?.id ?? null) : null,
            patientIds: matches.map((m) => m.patientId),
            destination: dest,
            channel,
            subject:
              matches.length > 0
                ? { type: "accounts", id: matches.map((m) => m.id).join(",") }
                : undefined,
            ipHash,
            clinicName: tenant.name,
            actorId: PORTAL_ANONYMOUS_ACTOR,
            deliver: matches.length > 0,
          },
          now,
        );
        return { kind: "sent" as const, issued, matched: matches.length > 0 };
      },
      { actorId: PORTAL_ANONYMOUS_ACTOR },
    ).catch(mapPortalDbError);

    if (r.kind === "unknown") return neutral(randomUUID());
    if (r.kind === "disabled") throw new HttpException({ error: "portal_disabled" }, 403);
    if (r.kind === "limited") {
      await this.audit.record(
        { tenantId: body.tenantId, actorId: PORTAL_ANONYMOUS_ACTOR },
        { action: "portal.otp.request", resource: "account", outcome: "denied" },
      );
      throw new HttpException(
        { error: "otp_rate_limited", retryAfterSeconds: r.retry },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (r.issued.deliveryFailed)
      await this.audit.record(
        { tenantId: body.tenantId, actorId: PORTAL_ANONYMOUS_ACTOR },
        { action: "portal.otp.request", resource: "account", outcome: "error" },
      );
    else
      await this.audit.record(
        { tenantId: body.tenantId, actorId: PORTAL_ANONYMOUS_ACTOR },
        { action: "portal.otp.request", resource: "account", outcome: "success" },
      );
    this.otps.afterCommit(body.tenantId, PORTAL_ANONYMOUS_ACTOR, r.issued.outbox, now);
    return neutral(r.issued.id);
  }

  // -------------------------------------------------------------------------------------------
  // Login: verify the code
  // -------------------------------------------------------------------------------------------

  async verify(body: PortalVerifyOtpRequest, req: Request): Promise<PortalVerifyOtpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    const { ipHash, uaHash } = await clientHashes(req, sec.pepper);
    const out = await withTenant(
      this.prisma,
      body.tenantId,
      async (tx) => {
        const a = await this.otps.attempt(
          tx,
          sec,
          { challengeId: body.challengeId, code: body.code, purposes: LOGIN_PURPOSES },
          now,
        );
        if (!a.ok) return { kind: "fail" as const, fail: a };
        const ids =
          a.otp.subjectType === "accounts" && a.otp.subjectId ? a.otp.subjectId.split(",") : [];
        const accounts = ids.length
          ? await tx.patientPortalAccount.findMany({
              where: { id: { in: ids }, status: { in: ["INVITED", "ACTIVE"] } },
              include: {
                patient: {
                  select: { firstName: true, lastName: true, preferredName: true, dob: true },
                },
              },
              orderBy: { id: "asc" },
            })
          : [];
        if (accounts.length === 0)
          return {
            kind: "fail" as const,
            fail: { ok: false as const, reason: "invalid" as const },
          };
        if (accounts.length > 1) return { kind: "choose" as const, otpId: a.otp.id, accounts };
        const account = accounts[0] as AccountWithPatient;
        return {
          kind: "session" as const,
          ...(await this.openSession(tx, sec, account, now, ipHash, uaHash)),
        };
      },
      { actorId: PORTAL_ANONYMOUS_ACTOR },
    ).catch(mapPortalDbError);

    const who = { tenantId: body.tenantId, actorId: PORTAL_ANONYMOUS_ACTOR };
    if (out.kind === "fail") {
      await this.audit.record(who, {
        action: "portal.otp.verify",
        resource: "account",
        outcome: "denied",
      });
      throw PortalOtpService.failure(out.fail);
    }
    await this.audit.record(who, {
      action: "portal.otp.verify",
      resource: "account",
      outcome: "success",
    });
    if (out.kind === "choose") {
      return {
        status: "CHOOSE_PATIENT",
        selectionToken: await this.tokens.signSelection(
          {
            tenantId: body.tenantId,
            otpId: out.otpId,
            accountIds: out.accounts.map((x) => x.id),
          },
          now,
        ),
        expiresInSeconds: PORTAL_SELECTION_TTL_SECONDS,
        options: out.accounts.map((x) => ({
          accountId: x.id,
          displayName: displayShort(x.patient),
          minor: isMinor(x.patient.dob, now),
        })),
      };
    }
    return this.authenticated(body.tenantId, out, now);
  }

  /** POST /portal/auth/select — finish login after the picker; the selection token proves which accounts the code matched. */
  async select(body: PortalSelectAccountRequest, req: Request): Promise<PortalVerifyOtpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    let claims: Awaited<ReturnType<PortalTokenService["verifySelection"]>>;
    try {
      claims = await this.tokens.verifySelection(body.selectionToken);
    } catch {
      throw new UnauthorizedException({ error: "selection_invalid" });
    }
    if (!claims.accountIds.includes(body.accountId))
      throw new UnauthorizedException({ error: "selection_invalid" });
    const { ipHash, uaHash } = await clientHashes(req, sec.pepper);
    const out = await withTenant(
      this.prisma,
      claims.tenantId,
      async (tx) => {
        const account = await tx.patientPortalAccount.findFirst({
          where: { id: body.accountId, status: { in: ["INVITED", "ACTIVE"] } },
          include: {
            patient: {
              select: { firstName: true, lastName: true, preferredName: true, dob: true },
            },
          },
        });
        if (!account) return null;
        return this.openSession(tx, sec, account, now, ipHash, uaHash);
      },
      { actorId: PORTAL_ANONYMOUS_ACTOR },
    ).catch(mapPortalDbError);
    if (!out) throw new UnauthorizedException({ error: "selection_invalid" });
    return this.authenticated(claims.tenantId, out, now);
  }

  private async authenticated(
    tenantId: string,
    s: SessionOpened,
    now: Date,
  ): Promise<PortalVerifyOtpResponse> {
    const access = await this.tokens.signAccess(
      { tenantId, patientId: s.account.patientId, accountId: s.account.id, sessionId: s.sessionId },
      PORTAL_ACCESS_TOKEN_TTL_SECONDS,
      now,
    );
    await this.audit.record(
      { tenantId, actorId: `patient:${s.account.patientId}` },
      { action: "portal.login", resource: "account", resourceId: s.account.id, outcome: "success" },
    );
    return {
      status: "AUTHENTICATED",
      tokens: {
        accessToken: access.token,
        accessTokenExpiresAt: iso(access.expiresAt),
        refreshToken: s.refreshToken,
        refreshTokenExpiresAt: iso(s.expiresAt),
      },
      me: s.me,
    };
  }

  /** Activates an INVITED account, stamps the login and opens the first session of a new family. */
  private async openSession(
    tx: Tx,
    sec: PortalSecrets,
    account: AccountWithPatient,
    now: Date,
    ipHash: string | null,
    uaHash: string | null,
  ): Promise<SessionOpened> {
    if (account.status === "INVITED")
      await tx.patientPortalAccount.update({
        where: { id: account.id },
        data: { status: "ACTIVE", activatedAt: now, lastLoginAt: now },
      });
    else
      await tx.patientPortalAccount.update({
        where: { id: account.id },
        data: { lastLoginAt: now },
      });
    const refreshToken = generateRefreshToken(account.tenantId);
    const expiresAt = new Date(now.getTime() + PORTAL_REFRESH_TTL_DAYS * DAY);
    const sessionId = randomUUID();
    await tx.portalSession.create({
      data: {
        id: sessionId,
        tenantId: account.tenantId,
        accountId: account.id,
        patientId: account.patientId,
        familyId: randomUUID(),
        refreshTokenHash: await sha256Hex(refreshToken),
        userAgentHash: uaHash,
        ipHash,
        expiresAt,
      },
    });
    void sec;
    const me = await buildMe(tx, {
      tenantId: account.tenantId,
      accountId: account.id,
      patientId: account.patientId,
      sessionExpiresAt: expiresAt,
      stepUpAt: null,
    });
    return { sessionId, refreshToken, expiresAt, account, me };
  }

  // -------------------------------------------------------------------------------------------
  // Refresh (rotation + reuse detection), logout
  // -------------------------------------------------------------------------------------------

  async refresh(body: PortalRefreshRequest): Promise<PortalTokens> {
    secretsOr503(this.secrets);
    const parsed = parseRefreshToken(body.refreshToken);
    if (!parsed) throw new UnauthorizedException({ error: "invalid_refresh_token" });
    const { tenantId } = parsed;
    const now = new Date();
    const hash = await sha256Hex(body.refreshToken);
    const nextToken = generateRefreshToken(tenantId);
    const nextHash = await sha256Hex(nextToken);

    type Phase =
      | { kind: "ok"; sessionId: string; accountId: string; patientId: string; expiresAt: Date }
      | { kind: "reuse"; familyId: string; accountId: string; patientId: string }
      | { kind: "denied" };
    let phase: Phase;
    try {
      phase = await withTenant(
        this.prisma,
        tenantId,
        async (tx): Promise<Phase> => {
          const found = await tx.portalSession.findUnique({ where: { refreshTokenHash: hash } });
          if (!found) return { kind: "denied" };
          await tx.$queryRaw`SELECT "id" FROM "PortalSession" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
          const old = await tx.portalSession.findUniqueOrThrow({ where: { id: found.id } });
          if (old.revokedAt)
            return {
              kind: "reuse",
              familyId: old.familyId,
              accountId: old.accountId,
              patientId: old.patientId,
            };
          const account = await tx.patientPortalAccount.findUnique({
            where: { id: old.accountId },
          });
          const root = await tx.portalSession.findFirst({
            where: { familyId: old.familyId },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
          });
          const hardCap = new Date(
            (root?.createdAt ?? old.createdAt).getTime() + PORTAL_SESSION_ABSOLUTE_DAYS * DAY,
          );
          if (!account || account.status !== "ACTIVE" || old.expiresAt <= now || hardCap <= now)
            return { kind: "denied" };
          const settings = resolvePortalSettings(
            (await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }))
              ?.settings,
          );
          if (!settings.enabled) return { kind: "denied" };
          const expiresAt = new Date(
            Math.min(now.getTime() + PORTAL_REFRESH_TTL_DAYS * DAY, hardCap.getTime()),
          );
          const successorId = randomUUID();
          await tx.portalSession.create({
            data: {
              id: successorId,
              tenantId,
              accountId: old.accountId,
              patientId: old.patientId,
              familyId: old.familyId,
              rotatedFromId: old.id,
              refreshTokenHash: nextHash,
              userAgentHash: old.userAgentHash,
              ipHash: old.ipHash,
              stepUpAt: old.stepUpAt,
              expiresAt,
            },
          });
          await tx.portalSession.update({
            where: { id: old.id },
            data: { revokedAt: now, revokedReason: "rotated" },
          });
          return {
            kind: "ok",
            sessionId: successorId,
            accountId: old.accountId,
            patientId: old.patientId,
            expiresAt,
          };
        },
        { actorId: PORTAL_ANONYMOUS_ACTOR },
      );
    } catch (e) {
      // Two concurrent refreshes of one token: the unique (tenantId, rotatedFromId) key lets only one win.
      if (!isUniqueViolation(e)) mapPortalDbError(e);
      const lost = await withTenant(
        this.prisma,
        tenantId,
        (tx) => tx.portalSession.findUnique({ where: { refreshTokenHash: hash } }),
        { actorId: PORTAL_ANONYMOUS_ACTOR },
      );
      phase = lost
        ? {
            kind: "reuse",
            familyId: lost.familyId,
            accountId: lost.accountId,
            patientId: lost.patientId,
          }
        : { kind: "denied" };
    }

    if (phase.kind === "reuse") {
      await withTenant(
        this.prisma,
        tenantId,
        (tx) =>
          tx.portalSession.updateMany({
            where: { familyId: phase.kind === "reuse" ? phase.familyId : "", revokedAt: null },
            data: { revokedAt: now, revokedReason: "reuse_detected" },
          }),
        { actorId: PORTAL_ANONYMOUS_ACTOR },
      );
      await this.audit.record(
        { tenantId, actorId: `patient:${phase.patientId}` },
        {
          action: "portal.refresh.reuse",
          resource: "account",
          resourceId: phase.accountId,
          outcome: "denied",
        },
      );
      throw new UnauthorizedException({ error: "session_revoked" });
    }
    if (phase.kind === "denied")
      throw new UnauthorizedException({ error: "invalid_refresh_token" });
    const access = await this.tokens.signAccess(
      {
        tenantId,
        patientId: phase.patientId,
        accountId: phase.accountId,
        sessionId: phase.sessionId,
      },
      PORTAL_ACCESS_TOKEN_TTL_SECONDS,
      now,
    );
    return {
      accessToken: access.token,
      accessTokenExpiresAt: iso(access.expiresAt),
      refreshToken: nextToken,
      refreshTokenExpiresAt: iso(phase.expiresAt),
    };
  }

  async logout(me: PatientPrincipal, body: PortalLogoutRequest) {
    const now = new Date();
    await withTenant(
      this.prisma,
      me.tenantId,
      (tx) =>
        tx.portalSession.updateMany({
          where: body.allDevices
            ? { accountId: me.accountId, revokedAt: null }
            : { id: me.sessionId, revokedAt: null },
          data: { revokedAt: now, revokedReason: body.allDevices ? "logout_all" : "logout" },
        }),
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    await this.audit.record(me, {
      action: "portal.logout",
      resource: "account",
      resourceId: me.accountId,
      outcome: "success",
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------------------------

  async requestStepUp(
    me: PatientPrincipal,
    body: PortalStepUpRequest,
    req: Request,
  ): Promise<PortalOtpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    const { ipHash } = await clientHashes(req, sec.pepper);
    const r = await withTenant(
      this.prisma,
      me.tenantId,
      async (tx) => {
        const account = await tx.patientPortalAccount.findUnique({ where: { id: me.accountId } });
        if (!account) return { kind: "none" as const };
        const dest = account.loginPhone ?? account.loginEmail;
        if (!dest) return { kind: "none" as const };
        const kind =
          account.loginPhone && body.channel !== "EMAIL"
            ? "phone"
            : account.loginEmail
              ? "email"
              : "phone";
        const destination =
          kind === "email" ? (account.loginEmail as string) : (account.loginPhone as string);
        const channel = channelFor(kind, body.channel);
        const rate = await this.otps.checkRate(tx, sec, destination, ipHash, now, ["STEP_UP"]);
        if (!rate.allowed) return { kind: "limited" as const, retry: rate.retryAfterSeconds };
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: me.tenantId },
          select: { name: true },
        });
        const issued = await this.otps.issue(
          tx,
          sec,
          {
            tenantId: me.tenantId,
            purpose: "STEP_UP",
            accountId: me.accountId,
            patientIds: [account.patientId],
            destination,
            channel,
            subject: { type: body.subjectType, id: body.subjectId ?? "-" },
            ipHash,
            clinicName: tenant.name,
            actorId: me.actorId,
            deliver: true,
          },
          now,
        );
        return { kind: "sent" as const, issued, destination, channel };
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    if (r.kind === "none") throw conflict("otp_delivery_unavailable");
    if (r.kind === "limited")
      throw new HttpException(
        { error: "otp_rate_limited", retryAfterSeconds: r.retry },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    if (r.issued.optedOut) throw conflict("otp_channel_opted_out");
    if (r.issued.deliveryFailed)
      throw new HttpException(
        { error: "otp_delivery_unavailable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    this.otps.afterCommit(me.tenantId, me.actorId, r.issued.outbox, now);
    await this.audit.record(me, {
      action: "portal.stepup",
      resource: "account",
      resourceId: me.accountId,
      outcome: "success",
    });
    return {
      challengeId: r.issued.id,
      maskedDestination: maskDestination(r.destination),
      channel: r.channel,
      expiresInSeconds: PORTAL_OTP_TTL_MINUTES * 60,
      resendAfterSeconds: PORTAL_OTP_RATE_LIMITS.resendCooldownSeconds,
    };
  }

  async verifyStepUp(
    me: PatientPrincipal,
    body: PortalStepUpVerifyRequest,
  ): Promise<PortalStepUpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    const r = await withTenant(
      this.prisma,
      me.tenantId,
      async (tx) => {
        const a = await this.otps.attempt(
          tx,
          sec,
          {
            challengeId: body.challengeId,
            code: body.code,
            purposes: ["STEP_UP"],
            accountId: me.accountId,
          },
          now,
        );
        if (!a.ok) return { ok: false as const, fail: a };
        await tx.portalSession.updateMany({
          where: { id: me.sessionId, revokedAt: null },
          data: { stepUpAt: now },
        });
        const t = await tx.tenant.findUnique({
          where: { id: me.tenantId },
          select: { settings: true },
        });
        return {
          ok: true as const,
          window: resolvePortalSettings(t?.settings).stepUpWindowMinutes,
        };
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    if (!r.ok) {
      await this.audit.record(me, {
        action: "portal.stepup",
        resource: "account",
        resourceId: me.accountId,
        outcome: "denied",
      });
      throw PortalOtpService.failure(r.fail);
    }
    await this.audit.record(me, {
      action: "portal.stepup",
      resource: "session",
      resourceId: me.sessionId,
      outcome: "success",
    });
    return { stepUpUntil: iso(new Date(now.getTime() + r.window * 60_000)) };
  }

  // -------------------------------------------------------------------------------------------
  // me, sessions
  // -------------------------------------------------------------------------------------------

  me(me: PatientPrincipal): Promise<PortalMeResponse> {
    return withTenant(this.prisma, me.tenantId, (tx) => buildMe(tx, me), { actorId: me.actorId });
  }

  async sessions(me: PatientPrincipal): Promise<{ items: PortalSessionResponse[] }> {
    const now = new Date();
    const rows = await withTenant(this.prisma, me.tenantId, (tx) =>
      tx.portalSession.findMany({
        where: { accountId: me.accountId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: [{ lastUsedAt: "desc" }, { id: "asc" }],
        take: 50,
      }),
    );
    return {
      items: rows.map((s) => ({
        id: s.id,
        // The session row keeps hashes only: there is no device label column (flagged in the P1 report).
        deviceLabel: null,
        createdAt: iso(s.createdAt),
        lastUsedAt: iso(s.lastUsedAt),
        current: s.id === me.sessionId,
      })),
    };
  }

  async revokeSession(me: PatientPrincipal, id: string) {
    const now = new Date();
    const n = await withTenant(
      this.prisma,
      me.tenantId,
      async (tx) => {
        const s = await tx.portalSession.findFirst({
          where: { id, accountId: me.accountId, revokedAt: null },
        });
        if (!s) return 0;
        const r = await tx.portalSession.updateMany({
          where: { familyId: s.familyId, accountId: me.accountId, revokedAt: null },
          data: { revokedAt: now, revokedReason: "revoked_by_user" },
        });
        return r.count;
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    if (n === 0) throw notFound("session_not_found");
    await this.audit.record(me, {
      action: "portal.logout",
      resource: "session",
      resourceId: id,
      outcome: "success",
    });
    return { ok: true };
  }
}

interface SessionOpened {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
  account: AccountWithPatient;
  me: PortalMeResponse;
}

/** "Asha K." — first name + last initial (the picker never shows more). */
const displayShort = (p: { firstName: string; lastName: string | null }) =>
  [p.firstName, p.lastName ? `${p.lastName.slice(0, 1)}.` : null].filter(Boolean).join(" ");

/** GET /portal/me. `patientId` is the patient shown (the merge survivor when there is one). */
export async function buildMe(
  tx: Tx,
  s: {
    tenantId: string;
    accountId: string;
    patientId: string;
    sessionExpiresAt: Date;
    stepUpAt: Date | null;
  },
): Promise<PortalMeResponse> {
  const [tenant, account, patient] = await Promise.all([
    tx.tenant.findUniqueOrThrow({
      where: { id: s.tenantId },
      select: { id: true, name: true, settings: true },
    }),
    tx.patientPortalAccount.findUniqueOrThrow({ where: { id: s.accountId } }),
    tx.patient.findUniqueOrThrow({
      where: { id: s.patientId },
      select: { firstName: true, lastName: true, preferredName: true, dob: true },
    }),
  ]);
  const settings = resolvePortalSettings(tenant.settings);
  const now = new Date();
  const fresh = isStepUpFresh(s.stepUpAt, now, settings.stepUpWindowMinutes);
  return {
    account: {
      id: account.id,
      status: account.status,
      loginPhoneMasked: account.loginPhone ? maskDestination(account.loginPhone) : null,
      loginEmailMasked: account.loginEmail ? maskDestination(account.loginEmail) : null,
    },
    patient: {
      firstName: patient.firstName,
      preferredName: patient.preferredName,
      displayName: displayName(patient),
      minor: isMinor(patient.dob, now),
    },
    clinic: { id: tenant.id, name: tenant.name },
    settings: {
      bookingEnabled: settings.enabled,
      minNoticeHours: settings.minNoticeHours,
      maxReschedules: settings.maxReschedules,
      allowPatientCancel: settings.allowPatientCancel,
      onlinePaymentsEnabled: resolveBillingSettings(tenant.settings).gatewayProvider !== "MANUAL",
    },
    session: {
      expiresAt: iso(s.sessionExpiresAt),
      stepUpUntil:
        fresh && s.stepUpAt
          ? isoOrNull(new Date(s.stepUpAt.getTime() + settings.stepUpWindowMinutes * 60_000))
          : null,
    },
  };
}

@Controller("portal")
export class PortalAuthController {
  constructor(private readonly svc: PortalAuthService) {}

  @Public()
  @Post("auth/otp")
  @HttpCode(200)
  async requestOtp(
    @Body(new ZodPipe(portalOtpRequest)) body: PortalOtpRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withRetryAfter(res, () => this.svc.requestOtp(body, req));
  }

  @Public()
  @Post("auth/verify")
  @HttpCode(200)
  verify(
    @Body(new ZodPipe(portalVerifyOtpRequest)) body: PortalVerifyOtpRequest,
    @Req() req: Request,
  ) {
    return this.svc.verify(body, req);
  }

  @Public()
  @Post("auth/select")
  @HttpCode(200)
  select(
    @Body(new ZodPipe(portalSelectAccountRequest)) body: PortalSelectAccountRequest,
    @Req() req: Request,
  ) {
    return this.svc.select(body, req);
  }

  @Public()
  @Post("auth/refresh")
  @HttpCode(200)
  refresh(@Body(new ZodPipe(portalRefreshRequest)) body: PortalRefreshRequest) {
    return this.svc.refresh(body);
  }

  @PortalAuth()
  @Post("auth/logout")
  @HttpCode(200)
  logout(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalLogoutRequest)) body: PortalLogoutRequest,
  ) {
    return this.svc.logout(me, body);
  }

  @PortalAuth()
  @Post("auth/step-up")
  @HttpCode(200)
  async stepUp(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalStepUpRequest)) body: PortalStepUpRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withRetryAfter(res, () => this.svc.requestStepUp(me, body, req));
  }

  @PortalAuth()
  @Post("auth/step-up/verify")
  @HttpCode(200)
  stepUpVerify(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalStepUpVerifyRequest)) body: PortalStepUpVerifyRequest,
  ) {
    return this.svc.verifyStepUp(me, body);
  }

  @PortalAuth()
  @Get("me")
  me(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.me(me);
  }

  @PortalAuth()
  @Get("sessions")
  sessions(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.sessions(me);
  }

  @PortalAuth()
  @Delete("sessions/:id")
  revoke(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.revokeSession(me, id);
  }

  /** 429 answers carry `Retry-After` (seconds). */
  private async withRetryAfter<T>(res: Response, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 429) {
        const body = e.getResponse() as { retryAfterSeconds?: number };
        if (body.retryAfterSeconds) res.setHeader("Retry-After", String(body.retryAfterSeconds));
      }
      throw e;
    }
  }
}

void badRequest;
