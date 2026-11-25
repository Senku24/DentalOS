import { randomUUID } from "node:crypto";
import type { NotificationOutbox, PortalOtp, Tx } from "@dentalos/db";
import {
  PORTAL_OTP_RATE_LIMITS,
  PORTAL_OTP_TTL_MINUTES,
  PORTAL_QUEUES,
  type PortalOtpChannel,
  type PortalOtpPurpose,
  constantTimeEqual,
  evaluateOtpAttempt,
  evaluateOtpRateLimit,
  generateOtpCode,
  hashDestination,
  hashOtpCode,
} from "@dentalos/validation";
import { BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import type { PortalSecrets } from "../auth/portal-token";
import { JobQueueService } from "../common/job-queue.service";
import { NotificationEnqueueService } from "../notifications/enqueue.service";
import { fireAndLog } from "./portal-common";

export interface IssueOtpInput {
  tenantId: string;
  purpose: PortalOtpPurpose;
  accountId: string | null;
  /**
   * Every patient the message concerns (one, or several when a destination is shared). Used ONLY for the channel opt-out
   * check; the outbox row itself carries no patient so the "implicit consent" knob cannot silently swallow a sign-in code.
   */
  patientIds: string[];
  /** Normalised destination ("+919876543210" | "a@b.com"). */
  destination: string;
  channel: PortalOtpChannel;
  subject?: { type: string; id: string };
  ipHash: string | null;
  clinicName: string;
  actorId: string;
  /** false = a decoy row for a destination without an account: same rate-limit bookkeeping, nothing is sent. */
  deliver: boolean;
}

export type OtpAttemptOutcome =
  | { ok: true; otp: PortalOtp }
  | { ok: false; reason: "invalid"; attemptsLeft?: number }
  | { ok: false; reason: "expired" | "locked" };

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * One-time codes (ADR 0005 §1.2): creation (hash-only row + outbox message through the notifications enqueue service,
 * purpose TRANSACTIONAL, template PORTAL_OTP), throttling from the `PortalOtp` rows, and the follow-up jobs (send +
 * scrub). Used by login, step-up and contact verification.
 */
@Injectable()
export class PortalOtpService {
  constructor(
    private readonly outbox: NotificationEnqueueService,
    private readonly jobs: JobQueueService,
  ) {}

  /** Throttle (per destination 3 / 15 min and 10 / 24 h, per IP 20 / h, 60 s cooldown) counted from existing rows. */
  async checkRate(
    tx: Tx,
    sec: PortalSecrets,
    destination: string,
    ipHash: string | null,
    now: Date,
    /** Count only the codes of these purposes per destination (login and step-up throttle independently). */
    purposes?: readonly PortalOtpPurpose[],
  ): Promise<RateDecision> {
    const destinationHash = await hashDestination(destination, sec.pepper);
    const [dest, ip] = await Promise.all([
      tx.portalOtp.findMany({
        where: {
          destinationHash,
          ...(purposes ? { purpose: { in: [...purposes] } } : {}),
          createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
        },
        select: { createdAt: true },
      }),
      ipHash
        ? tx.portalOtp.findMany({
            where: { ipHash, createdAt: { gt: new Date(now.getTime() - 3600_000) } },
            select: { createdAt: true },
          })
        : Promise.resolve([]),
    ]);
    const r = evaluateOtpRateLimit({
      now,
      destinationRequests: dest.map((x) => x.createdAt),
      ipRequests: ip.map((x) => x.createdAt),
      limits: PORTAL_OTP_RATE_LIMITS,
    });
    return r.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: r.retryAfterSeconds };
  }

  /** Inserts the OTP row (+ the outbox message when `deliver`). Returns the challenge id and the outbox row. */
  async issue(
    tx: Tx,
    sec: PortalSecrets,
    i: IssueOtpInput,
    now: Date,
  ): Promise<{
    id: string;
    outbox: NotificationOutbox | null;
    deliveryFailed: boolean;
    optedOut: boolean;
  }> {
    const id = randomUUID();
    const code = generateOtpCode();
    await tx.portalOtp.create({
      data: {
        id,
        tenantId: i.tenantId,
        accountId: i.accountId,
        purpose: i.purpose,
        channel: i.channel,
        destinationHash: await hashDestination(i.destination, sec.pepper),
        codeHash: await hashOtpCode(code, id, sec.pepper),
        subjectType: i.subject?.type ?? null,
        subjectId: i.subject?.id ?? null,
        expiresAt: new Date(now.getTime() + PORTAL_OTP_TTL_MINUTES * 60_000),
        ipHash: i.ipHash,
      },
    });
    if (!i.deliver) return { id, outbox: null, deliveryFailed: false, optedOut: false };
    // A sign-in code is a security message: it needs no marketing / reminder consent and is not held back for want of a
    // preference row, but a patient's explicit opt-out of the channel (TRANSACTIONAL, optIn=false) is respected.
    if (i.patientIds.length > 0) {
      const out = await tx.communicationPreference.count({
        where: {
          patientId: { in: i.patientIds },
          channel: i.channel,
          purpose: "TRANSACTIONAL",
          optIn: false,
        },
      });
      if (out >= i.patientIds.length)
        return { id, outbox: null, deliveryFailed: false, optedOut: true };
    }
    const settings = await this.outbox.settings(tx, i.tenantId);
    const r = await this.outbox.enqueue(
      tx,
      i.tenantId,
      settings,
      {
        actorId: i.actorId,
        patientId: null,
        channel: i.channel,
        templateCode: "PORTAL_OTP",
        toAddress: i.destination,
        variables: {
          clinicName: i.clinicName,
          code,
          validityMinutes: PORTAL_OTP_TTL_MINUTES,
        },
        idempotencyKey: `portal-otp:${id}`,
        source: "portal.otp",
        refType: "portal_otp",
        refId: id,
      },
      now,
    );
    if (!r.ok) return { id, outbox: null, deliveryFailed: true, optedOut: false };
    return { id, outbox: r.row, deliveryFailed: false, optedOut: false };
  }

  /**
   * One verification try inside a transaction (the caller must RETURN the result and throw after commit, so the
   * attempt counter of a wrong code is kept). Locks the row, applies `evaluateOtpAttempt`, counts a mismatch and, on
   * success, consumes the code (single use; the DB trigger is the final authority under races).
   */
  async attempt(
    tx: Tx,
    sec: PortalSecrets,
    o: {
      challengeId: string;
      code: string;
      purposes: readonly PortalOtpPurpose[];
      accountId?: string;
    },
    now: Date,
  ): Promise<OtpAttemptOutcome> {
    await tx.$queryRaw`SELECT "id" FROM "PortalOtp" WHERE "id" = ${o.challengeId}::uuid FOR UPDATE`;
    const otp = await tx.portalOtp.findUnique({ where: { id: o.challengeId } });
    if (
      !otp ||
      !o.purposes.includes(otp.purpose) ||
      (o.accountId !== undefined && otp.accountId !== o.accountId)
    )
      return { ok: false, reason: "invalid" };
    const hash = await hashOtpCode(o.code, otp.id, sec.pepper);
    const r = evaluateOtpAttempt({
      now,
      expiresAt: otp.expiresAt,
      consumedAt: otp.consumedAt,
      attempts: otp.attempts,
      maxAttempts: otp.maxAttempts,
      codeMatches: constantTimeEqual(hash, otp.codeHash),
    });
    if (!r.ok) {
      if (r.reason === "mismatch")
        await tx.portalOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return r.reason === "expired"
        ? { ok: false, reason: "expired" }
        : r.reason === "locked"
          ? { ok: false, reason: "locked" }
          : { ok: false, reason: "invalid", attemptsLeft: r.attemptsLeft };
    }
    const c = await tx.portalOtp.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: otp.maxAttempts } },
      data: { consumedAt: now, attempts: { increment: 1 } },
    });
    if (c.count !== 1) return { ok: false, reason: "invalid" };
    return { ok: true, otp };
  }

  /** The API error of a failed `attempt` (throw it AFTER the transaction). */
  static failure(r: Extract<OtpAttemptOutcome, { ok: false }>): HttpException {
    if (r.reason === "expired") return new BadRequestException({ error: "otp_expired" });
    if (r.reason === "locked")
      return new HttpException({ error: "otp_locked" }, HttpStatus.TOO_MANY_REQUESTS);
    const left = "attemptsLeft" in r ? r.attemptsLeft : undefined;
    return new BadRequestException({
      error: "otp_invalid",
      ...(left !== undefined ? { attemptsLeft: left } : {}),
    });
  }

  /** After the transaction committed: send job + the job that blanks the code from the outbox row. */
  afterCommit(tenantId: string, actorId: string, row: NotificationOutbox | null, now: Date): void {
    if (!row) return;
    fireAndLog("otp send", this.outbox.dispatch(tenantId, actorId, row));
    fireAndLog(
      "otp scrub",
      this.jobs.enqueue(
        PORTAL_QUEUES.SCRUB_OTP_MESSAGE,
        {
          tenantId,
          actorId,
          source: "portal.otp",
          idempotencyKey: `scrub-otp:${row.id}`,
          data: { outboxId: row.id },
        },
        { startAfter: new Date(now.getTime() + 90_000) },
      ),
    );
  }
}
