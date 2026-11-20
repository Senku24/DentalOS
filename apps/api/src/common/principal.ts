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
 * Returns `{}` for orgWide principals; `{ branchId: { in: [] } }` (no rows) for an empty scope.
 *
 * PITFALL — never spread it into a `where` that already has the same key: the spread silently
 * OVERWRITES that key and widens the query to the whole scope.
 *   BAD:  { id, ...branchWhere(p, "id") }          // `id` filter lost -> any in-scope branch
 *   BAD:  { branchId: q.branchId, ...branchWhere(p) }
 *   GOOD: { id, AND: [branchWhere(p, "id")] }      // or withBranchScope(p, { id }, "id")
 * Spreading is only safe when the where has no `field` key at all; prefer `AND: [...]` / the helper.
 */
export function branchWhere(p: Principal, field = "branchId"): Record<string, { in: string[] }> {
  const ids = branchFilter(p);
  return ids === undefined ? {} : { [field]: { in: ids } };
}

/**
 * Safe merge of a `where` with the caller's branch scope (always ANDed, never overwrites keys;
 * an existing `AND` is preserved).
 *   tx.branch.findFirst({ where: withBranchScope(p, { tenantId, id }, "id") })
 */
export function withBranchScope<W extends object>(
  p: Principal,
  where: W,
  field = "branchId",
): W & { AND: W[] } {
  const scope = branchWhere(p, field) as W;
  const and = (where as { AND?: W | W[] }).AND;
  const prior = and === undefined ? [] : Array.isArray(and) ? and : [and];
  return { ...where, AND: [...prior, scope] };
}
