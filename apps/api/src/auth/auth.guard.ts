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
import { type Principal, type Role } from "./roles";
import { TOKEN_VERIFIER, type TokenVerifier } from "./token-verifier";

export const Public = () => SetMetadata("public", true);
export const Roles = (...roles: Role[]) => SetMetadata("roles", roles);
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
    let claims: Awaited<ReturnType<TokenVerifier["verify"]>>;
    try {
      claims = await this.verifier.verify(header.slice(7));
    } catch {
      throw new UnauthorizedException();
    }
    // Staff must have MFA (PRD 7.3). Tenant selection is a hint only; membership is verified server-side.
    if (!claims.mfa) throw new ForbiddenException("MFA required");
    const tenantId = req.headers["x-tenant-id"];
    if (typeof tenantId !== "string") throw new UnauthorizedException();
    const m = await withTenant(this.prisma, tenantId, (tx) =>
      tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId: claims.sub } } }),
    ).catch(() => null);
    if (!m) throw new ForbiddenException();
    const principal: Principal = {
      userId: m.userId,
      tenantId: m.tenantId,
      role: m.role,
      branchScope: m.branchScope,
    };
    req.principal = principal;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>("roles", [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (roles && !roles.includes(principal.role)) throw new ForbiddenException();
    return true;
  }
}
