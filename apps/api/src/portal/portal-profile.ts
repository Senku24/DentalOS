import { PrismaClient, withTenant } from "@dentalos/db";
import type { Prisma } from "@dentalos/db";
import {
  PORTAL_OTP_RATE_LIMITS,
  PORTAL_OTP_TTL_MINUTES,
  type PortalContactChangeRequest,
  type PortalContactVerifyRequest,
  type PortalOtpResponse,
  type PortalProfileResponse,
  type UpdatePortalProfileRequest,
  hashDestination,
  maskDestination,
  normalizeEmail,
  normalizePhoneIN,
  portalContactChangeRequest,
  portalContactVerifyRequest,
  updatePortalProfileRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PortalAuditService } from "../auth/portal-audit";
import { PORTAL_SECRETS, type PortalSecrets } from "../auth/portal-token";
import { PortalAuth, PortalStepUp } from "../auth/portal.guard";
import { ZodPipe } from "../common/zod.pipe";
import {
  clientHashes,
  conflict,
  dateOnlyOrNull,
  isMinor,
  mapPortalDbError,
  notFound,
  secretsOr503,
} from "./portal-common";
import { PortalOtpService } from "./portal-otp.service";

/**
 * Profile (ADR 0005 §3.1–3.2): an allow-list read, an allow-list write (strict DTO: any other key is a 400) and the
 * OTP-verified change of the login phone / e-mail. Reads and writes address the principal's CURRENT patient record.
 */
@Injectable()
export class PortalProfileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(PORTAL_SECRETS) private readonly secrets: PortalSecrets | null,
    private readonly audit: PortalAuditService,
    private readonly otps: PortalOtpService,
  ) {}

  async get(me: PatientPrincipal): Promise<PortalProfileResponse> {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const p = await tx.patient.findUnique({ where: { id: me.patientId } });
      if (!p) throw notFound("patient_not_found");
      const prefs = await tx.communicationPreference.findMany({
        where: {
          patientId: me.patientId,
          purpose: { in: ["REMINDER", "MARKETING"] },
          channel: { in: ["SMS", "WHATSAPP", "EMAIL"] },
        },
        orderBy: [{ channel: "asc" }, { purpose: "asc" }],
      });
      return {
        mrn: p.mrn,
        firstName: p.firstName,
        middleName: p.middleName,
        lastName: p.lastName,
        preferredName: p.preferredName,
        dob: dateOnlyOrNull(p.dob),
        sex: p.sex,
        phone: p.phone,
        altPhone: p.altPhone,
        email: p.email,
        addressLine1: p.addressLine1,
        addressLine2: p.addressLine2,
        city: p.city,
        state: p.state,
        postalCode: p.postalCode,
        country: p.country,
        minor: isMinor(p.dob),
        communicationPreferences: prefs.map((x) => ({
          channel: x.channel as "SMS" | "WHATSAPP" | "EMAIL",
          purpose: x.purpose as "REMINDER" | "MARKETING",
          optIn: x.optIn,
        })),
      };
    });
  }

  async update(me: PatientPrincipal, body: UpdatePortalProfileRequest) {
    await withTenant(
      this.prisma,
      me.tenantId,
      async (tx) => {
        const cur = await tx.patient.findUnique({ where: { id: me.patientId } });
        if (!cur) throw notFound("patient_not_found");
        const data: Prisma.PatientUncheckedUpdateInput = {};
        const text = (v: string | undefined) => (v === undefined ? undefined : v || null);
        if (body.preferredName !== undefined) data.preferredName = text(body.preferredName);
        if (body.altPhone !== undefined) data.altPhone = body.altPhone;
        if (body.addressLine1 !== undefined) data.addressLine1 = text(body.addressLine1);
        if (body.addressLine2 !== undefined) data.addressLine2 = text(body.addressLine2);
        if (body.city !== undefined) data.city = text(body.city);
        if (body.state !== undefined) data.state = text(body.state);
        if (body.postalCode !== undefined) data.postalCode = body.postalCode;
        if (Object.keys(data).length > 0)
          await tx.patient.update({ where: { id: me.patientId }, data });
        for (const pref of body.communicationPreferences ?? [])
          await tx.communicationPreference.upsert({
            where: {
              tenantId_patientId_channel_purpose: {
                tenantId: me.tenantId,
                patientId: me.patientId,
                channel: pref.channel,
                purpose: pref.purpose,
              },
            },
            update: { optIn: pref.optIn, updatedBy: me.actorId },
            create: {
              tenantId: me.tenantId,
              patientId: me.patientId,
              channel: pref.channel,
              purpose: pref.purpose,
              optIn: pref.optIn,
              updatedBy: me.actorId,
            },
          });
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    await this.audit.record(me, {
      action: "portal.profile.update",
      resource: "patient",
      resourceId: me.patientId,
      outcome: "success",
    });
    return this.get(me);
  }

  /** OTP to the NEW destination (a fresh step-up on the session is already required by the route). */
  async requestContactChange(
    me: PatientPrincipal,
    body: PortalContactChangeRequest,
    req: Request,
  ): Promise<PortalOtpResponse> {
    const sec = secretsOr503(this.secrets);
    const now = new Date();
    const { ipHash } = await clientHashes(req, sec.pepper);
    const destination = body.kind === "phone" ? body.value : (normalizeEmail(body.value) as string);
    const r = await withTenant(
      this.prisma,
      me.tenantId,
      async (tx) => {
        const account = await tx.patientPortalAccount.findUnique({ where: { id: me.accountId } });
        if (!account) throw notFound("account_not_found");
        const current = body.kind === "phone" ? account.loginPhone : account.loginEmail;
        if (current === destination) throw conflict("contact_unchanged");
        const rate = await this.otps.checkRate(tx, sec, destination, ipHash, now, [
          "CONTACT_VERIFY",
        ]);
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
            purpose: "CONTACT_VERIFY",
            accountId: me.accountId,
            patientIds: [me.patientId],
            destination,
            channel: body.kind === "email" ? "EMAIL" : "SMS",
            subject: { type: body.kind, id: await hashDestination(destination, sec.pepper) },
            ipHash,
            clinicName: tenant.name,
            actorId: me.actorId,
            deliver: true,
          },
          now,
        );
        return { kind: "sent" as const, issued };
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
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
    return {
      challengeId: r.issued.id,
      maskedDestination: maskDestination(destination),
      channel: body.kind === "email" ? "EMAIL" : "SMS",
      expiresInSeconds: PORTAL_OTP_TTL_MINUTES * 60,
      resendAfterSeconds: PORTAL_OTP_RATE_LIMITS.resendCooldownSeconds,
    };
  }

  /** The code proves control of the new destination: the patient contact and the login destination change together. */
  async verifyContactChange(me: PatientPrincipal, body: PortalContactVerifyRequest) {
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
            purposes: ["CONTACT_VERIFY"],
            accountId: me.accountId,
          },
          now,
        );
        if (!a.ok) return { ok: false as const, fail: a };
        // The new destination is not stored in the OTP row (hash only): it is the address the code was sent to.
        const msg = await tx.notificationOutbox.findFirst({
          where: { refType: "portal_otp", refId: a.otp.id },
          select: { toAddress: true },
        });
        const kind = a.otp.subjectType;
        const dest = msg?.toAddress ?? null;
        if (
          !dest ||
          (kind !== "phone" && kind !== "email") ||
          (await hashDestination(dest, sec.pepper)) !== a.otp.subjectId
        )
          throw conflict("contact_change_unavailable");
        if (kind === "phone") {
          await tx.patient.update({
            where: { id: me.patientId },
            data: { phone: dest, phoneNormalized: normalizePhoneIN(dest) },
          });
          await tx.patientPortalAccount.update({
            where: { id: me.accountId },
            data: { loginPhone: dest },
          });
        } else {
          await tx.patient.update({
            where: { id: me.patientId },
            data: { email: dest, emailNormalized: normalizeEmail(dest) },
          });
          await tx.patientPortalAccount.update({
            where: { id: me.accountId },
            data: { loginEmail: dest },
          });
        }
        return { ok: true as const, kind };
      },
      { actorId: me.actorId },
    ).catch(mapPortalDbError);
    if (!r.ok) {
      await this.audit.record(me, {
        action: "portal.contact.change",
        resource: "account",
        resourceId: me.accountId,
        outcome: "denied",
      });
      throw PortalOtpService.failure(r.fail);
    }
    await this.audit.record(me, {
      action: "portal.contact.change",
      resource: "account",
      resourceId: me.accountId,
      outcome: "success",
    });
    return { ok: true, changed: r.kind };
  }
}

@Controller("portal/profile")
export class PortalProfileController {
  constructor(private readonly svc: PortalProfileService) {}

  @PortalAuth()
  @Get()
  get(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.get(me);
  }

  @PortalAuth()
  @Patch()
  update(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(updatePortalProfileRequest)) body: UpdatePortalProfileRequest,
  ) {
    return this.svc.update(me, body);
  }

  @PortalAuth()
  @PortalStepUp()
  @Post("contact")
  @HttpCode(200)
  async requestContact(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalContactChangeRequest)) body: PortalContactChangeRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      return await this.svc.requestContactChange(me, body, req);
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 429) {
        const b = e.getResponse() as { retryAfterSeconds?: number };
        if (b.retryAfterSeconds) res.setHeader("Retry-After", String(b.retryAfterSeconds));
      }
      throw e;
    }
  }

  @PortalAuth()
  @PortalStepUp()
  @Post("contact/verify")
  @HttpCode(200)
  verifyContact(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalContactVerifyRequest)) body: PortalContactVerifyRequest,
  ) {
    return this.svc.verifyContactChange(me, body);
  }
}
