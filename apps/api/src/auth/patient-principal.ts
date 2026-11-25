import { type ExecutionContext, ForbiddenException, createParamDecorator } from "@nestjs/common";

/**
 * Authenticated, server-built identity of a patient-portal request (ADR 0005 §1). Resolved by `PortalGuard` from the
 * verified portal session — NEVER from client input. Every portal read/write must be scoped by these ids.
 * It is not a staff `Principal` and carries no staff permission.
 */
export interface PatientPrincipal {
  tenantId: string;
  /** The patient's CURRENT record (the merge survivor): owner of new writes. */
  patientId: string;
  /** Survivor + every record merged into it (transitively): use for READS of append-only history (ADR 0003 merge rule). */
  patientIds: string[];
  /** The patient the account was created for; differs from `patientId` after a merge. */
  accountPatientId: string;
  accountId: string;
  sessionId: string;
  /** What logs and audit rows record as the actor: `patient:<patientId>`. Never a staff user id. */
  actorId: `patient:${string}`;
  /** Last successful step-up OTP of this session (null = none). Compare with `isStepUpFresh`. */
  stepUpAt: Date | null;
  sessionExpiresAt: Date;
}

/**
 * The portal principal set by `PortalGuard` on `@PortalAuth()` routes.
 *   @PortalAuth() @Get("appointments") list(@CurrentPatient() me: PatientPrincipal) {}
 */
export const CurrentPatient = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): PatientPrincipal => {
    const p = ctx.switchToHttp().getRequest().patient as PatientPrincipal | undefined;
    if (!p) throw new ForbiddenException(); // only reachable on a route that forgot @PortalAuth()
    return p;
  },
);
