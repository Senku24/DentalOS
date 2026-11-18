import {
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { type Permission, type Principal, type Resource, branchFilter, can } from "../auth/roles";
import type { VerifiedClaims } from "../auth/token-verifier";

/**
 * The server-built principal set by AuthGuard (never from client input).
 *   @Get() list(@CurrentPrincipal() p: Principal) {}
 */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    const p = ctx.switchToHttp().getRequest().principal as Principal | undefined;
    if (!p) throw new ForbiddenException(); // only reachable on a @Public() route by mistake
    return p;
  },
);

/**
 * The verified token claims set by AuthGuard (any authenticated route, incl. `@Authenticated()` ones
 * that have no principal). `email` is present only when the IdP verified it.
 *   @Authenticated() @Post("accept") accept(@CurrentClaims() c: VerifiedClaims) {}
 */
export const CurrentClaims = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): VerifiedClaims => {
    const c = ctx.switchToHttp().getRequest().claims as VerifiedClaims | undefined;
    if (!c) throw new UnauthorizedException(); // only reachable on a @Public() route by mistake
    return c;
  },
);

/**
 * Resource-level check after `@Can(perm)` proved capability. Use for branch-scoped permissions once the
 * target branch is known (e.g. `assertCan(p, "document:write", { branchId: doc.branchId })`).
 * Respond 404 instead (by catching) when existence itself must not leak.
 */
export function assertCan(p: Principal, perm: Permission, resource: Resource = {}): void {
  if (!can(p, perm, resource)) throw new ForbiddenException();
}

/**
 * Prisma `where` fragment restricting a branch-owned table to the caller's scope.
 *   tx.patientDocument.findMany({ where: { patientId, ...branchWhere(p) } })
 * Returns `{}` for orgWide principals; `{ branchId: { in: [] } }` (no rows) for an empty scope.
 */
export function branchWhere(p: Principal, field = "branchId"): Record<string, { in: string[] }> {
  const ids = branchFilter(p);
  return ids === undefined ? {} : { [field]: { in: ids } };
}
