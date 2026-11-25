import { PrismaClient, withTenant } from "@dentalos/db";
import {
  PORTAL_STEP_UP_WINDOW_MINUTES,
  isStepUpFresh,
  resolvePortalSettings,
} from "@dentalos/validation";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PRISMA } from "./auth.guard";
import type { PatientPrincipal } from "./patient-principal";
import { PORTAL_KEY, PORTAL_STEP_UP_KEY } from "./portal-metadata";
import {
  PORTAL_TOKEN_SERVICE,
  type PortalAccessClaims,
  type PortalTokenService,
} from "./portal-token";
import type { Principal } from "./roles";

export { PORTAL_KEY, PORTAL_STEP_UP_KEY, PortalAuth, PortalStepUp } from "./portal-metadata";

const MAX_MERGE_DEPTH = 20;
const LAST_USED_REFRESH_MS = 60_000;

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PORTAL_TOKEN_SERVICE) private readonly tokens: PortalTokenService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (!this.reflector.getAllAndOverride<boolean>(PORTAL_KEY, targets)) return true; // not a portal route
    const needStepUp =
      this.reflector.getAllAndOverride<boolean>(PORTAL_STEP_UP_KEY, targets) === true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException();
    let claims: PortalAccessClaims;
    try {
      claims = await this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw new UnauthorizedException(); // wrong key / audience / expired: includes every staff token
    }
    const now = new Date();
    const state = await withTenant(this.prisma, claims.tenantId, async (tx) => {
      const s = await tx.portalSession.findUnique({
        where: { tenantId_id: { tenantId: claims.tenantId, id: claims.sessionId } },
        include: { account: { select: { id: true, patientId: true, status: true } } },
      });
      if (!s || s.accountId !== claims.accountId || s.patientId !== claims.patientId) return null;
      const tenant = await tx.tenant.findUnique({
        where: { id: claims.tenantId },
        select: { settings: true },
      });
      // Merge survivor and lineage (records stay on the merged ids; reads go through the lineage).
      let survivor = s.patientId;
      for (let i = 0; i < MAX_MERGE_DEPTH; i++) {
        const p = await tx.patient.findUnique({
          where: { id: survivor },
          select: { mergedIntoId: true },
        });
        if (!p?.mergedIntoId) break;
        survivor = p.mergedIntoId;
      }
      const lineage = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE lineage(id, depth) AS (
          SELECT ${survivor}::uuid, 0
          UNION ALL
          SELECT p.id, l.depth + 1 FROM "Patient" p JOIN lineage l ON p."mergedIntoId" = l.id WHERE l.depth < ${MAX_MERGE_DEPTH}
        ) SELECT id::text AS id FROM lineage`;
      if (now.getTime() - s.lastUsedAt.getTime() > LAST_USED_REFRESH_MS && !s.revokedAt) {
        await tx.portalSession.update({
          where: { tenantId_id: { tenantId: claims.tenantId, id: s.id } },
          data: { lastUsedAt: now },
        });
      }
      return {
        s,
        survivor,
        ids: lineage.map((r) => r.id),
        settings: resolvePortalSettings(tenant?.settings),
      };
    }).catch(() => null);
    if (!state) throw new UnauthorizedException();
    const { s, survivor, ids, settings } = state;
    if (s.revokedAt || s.expiresAt <= now)
      throw new UnauthorizedException({ error: "session_revoked" });
    if (s.account.status !== "ACTIVE")
      throw new ForbiddenException({ error: "portal_account_inactive" });
    if (!settings.enabled) throw new ForbiddenException({ error: "portal_disabled" });
    if (
      needStepUp &&
      !isStepUpFresh(s.stepUpAt, now, settings.stepUpWindowMinutes ?? PORTAL_STEP_UP_WINDOW_MINUTES)
    )
      throw new ForbiddenException({ error: "step_up_required" });

    const patient: PatientPrincipal = {
      tenantId: claims.tenantId,
      patientId: survivor,
      patientIds: ids,
      accountPatientId: s.patientId,
      accountId: s.accountId,
      sessionId: s.id,
      actorId: `patient:${survivor}`,
      stepUpAt: s.stepUpAt,
      sessionExpiresAt: s.expiresAt,
    };
    req.patient = patient;
    // Same context shape the access log / tracing / AuditService read (`req.principal.tenantId` / `.userId`). No roles,
    // not orgWide, no branch scope: `can()` is false for every staff permission, so a portal session can never act as staff.
    const asPrincipal: Principal = {
      userId: patient.actorId,
      tenantId: patient.tenantId,
      roles: [],
      orgWide: false,
      branchScope: [],
    };
    req.principal = asPrincipal;
    return true;
  }
}
