import { PrismaClient, withTenant } from "@dentalos/db";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Permission, type Principal, can } from "./roles";
import { TOKEN_VERIFIER, type TokenVerifier, type VerifiedClaims } from "./token-verifier";

export const Public = () => SetMetadata("public", true);
/**
 * Signed-in (valid token + MFA) but NOT necessarily a member of any tenant: membership resolution is
 * skipped, so no principal/X-Tenant-Id is required. Read the verified identity with `@CurrentClaims()`.
 * For pre-membership flows only (accepting an invitation). `@Can` is ignored; `@StepUp` still applies.
 */
export const Authenticated = () => SetMetadata("authenticated", true);
/** Requires an interactive sign-in no older than `maxAgeSeconds` (step-up for risky actions, PRD 7.3). */
export const StepUp = (maxAgeSeconds: number) => SetMetadata("stepUp", maxAgeSeconds);

/** Declares the permission a route requires (capability check; services still enforce branch/resource scope). */
export const Can = (permission: Permission) => SetMetadata("permission", permission);
export const PRISMA = Symbol("PRISMA");

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>("public", [ctx.getHandler(), ctx.getClass()]))
      return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException();
    let claims: VerifiedClaims;
    try {
      claims = await this.verifier.verify(header.slice(7));
    } catch {
      throw new UnauthorizedException();
    }
    // Staff must have MFA (PRD 7.3). Tenant selection is a hint only; membership is verified server-side.
    if (!claims.mfa) throw new ForbiddenException("MFA required");
    req.claims = claims;
    if (this.reflector.getAllAndOverride<boolean>("authenticated", [ctx.getHandler(), ctx.getClass()])) {
      this.checkStepUp(ctx, claims);
      return true;
    }
    const tenantId = req.headers["x-tenant-id"];
    if (typeof tenantId !== "string") throw new UnauthorizedException();
    const m = await withTenant(this.prisma, tenantId, (tx) =>
      tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: claims.sub } } }),
    ).catch(() => null);
    if (!m) throw new ForbiddenException();
    const principal: Principal = {
      userId: m.userId,
      tenantId: m.tenantId,
      roles: m.roles,
      orgWide: m.orgWide,
      branchScope: m.branchScope,
    };
    req.principal = principal;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>("permission", [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (permission && !can(principal, permission)) throw new ForbiddenException();
    this.checkStepUp(ctx, claims);
    return true;
  }

  private checkStepUp(ctx: ExecutionContext, claims: VerifiedClaims): void {
    const stepUp = this.reflector.getAllAndOverride<number | undefined>("stepUp", [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (stepUp !== undefined && Math.floor(Date.now() / 1000) - claims.authTime > stepUp) {
      // 401 + machine-readable code: the client must re-authenticate (Cognito cannot step up in-session).
      throw new UnauthorizedException({ error: "reauth_required", maxAgeSeconds: stepUp });
    }
  }
}
