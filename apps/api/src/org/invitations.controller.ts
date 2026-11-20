import { createHash, randomBytes } from "node:crypto";
import { PrismaClient, type StaffInvitation, withTenant } from "@dentalos/db";
import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type ListInvitationsQuery,
  type ResendInvitationRequest,
  acceptInvitationRequest,
  createInvitationRequest,
  listInvitationsQuery,
  resendInvitationRequest,
} from "@dentalos/validation";
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Authenticated, Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import type { VerifiedClaims } from "../auth/token-verifier";
import { CurrentClaims, CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { UUID, mapDbError, notFound } from "./http";
import { assertTenantBranches, isRemoved } from "./staff.controller";

const DAY_MS = 86_400_000;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

/** PENDING rows past `expiresAt` are reported as EXPIRED even before a write flips them. */
const toInvitation = (i: StaffInvitation, now = new Date()) => ({
  id: i.id,
  email: i.email,
  roles: i.roles,
  orgWide: i.orgWide,
  branchScope: i.branchScope,
  status: i.status === "PENDING" && i.expiresAt <= now ? ("EXPIRED" as const) : i.status,
  expiresAt: i.expiresAt,
  invitedBy: i.invitedBy,
  createdAt: i.createdAt,
});

/**
 * Staff invitations (org-wide `staff:manage`). Only sha256(token) is stored; the raw token is returned
 * once on create/resend so the caller can deliver the link (`acceptPath`) — no e-mail sender exists yet.
 */
@Controller("invitations")
export class InvitationsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  @Can("staff:manage")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listInvitationsQuery)) q: ListInvitationsQuery,
  ) {
    const now = new Date();
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.staffInvitation.findMany({
        where: { tenantId: p.tenantId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 500,
      }),
    );
    const items = rows.map((r) => toInvitation(r, now));
    return { items: q.status ? items.filter((i) => i.status === q.status) : items };
  }

  @Can("staff:manage")
  @Post()
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createInvitationRequest)) body: CreateInvitationRequest,
  ) {
    const token = newToken();
    const inv = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const branchScope = body.orgWide
          ? []
          : await assertTenantBranches(tx, p.tenantId, body.branchScope);
        // A stale PENDING invite would block the one-pending-per-email index: retire it first.
        await tx.staffInvitation.updateMany({
          where: {
            tenantId: p.tenantId,
            email: body.email,
            status: "PENDING",
            expiresAt: { lte: new Date() },
          },
          data: { status: "EXPIRED" },
        });
        return tx.staffInvitation.create({
          data: {
            tenantId: p.tenantId,
            email: body.email,
            roles: [...new Set(body.roles)],
            orgWide: body.orgWide,
            branchScope,
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
            invitedBy: p.userId,
          },
        });
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "invitation_pending" }));
    await this.record(p, "invitation.create", inv.id);
    return { ...toInvitation(inv), token, acceptPath: acceptPath(p.tenantId, token) };
  }

  @Can("staff:manage")
  @Post(":id/revoke")
  @HttpCode(200)
  async revoke(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const inv = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.staffInvitation.updateMany({
          where: { tenantId: p.tenantId, id, status: "PENDING" },
          data: { status: "REVOKED", revokedBy: p.userId, revokedAt: new Date() },
        });
        const cur = await tx.staffInvitation.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!cur) return notFound();
        if (r.count === 0) throw new ConflictException({ error: "invitation_not_pending" });
        return cur;
      },
      { actorId: p.userId },
    );
    await this.record(p, "invitation.revoke", id);
    return toInvitation(inv);
  }

  /** Rotates the token (old links stop working) and restarts the expiry window. */
  @Can("staff:manage")
  @Post(":id/resend")
  @HttpCode(200)
  async resend(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(resendInvitationRequest)) body: ResendInvitationRequest,
  ) {
    const token = newToken();
    const inv = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.staffInvitation.updateMany({
          where: { tenantId: p.tenantId, id, status: { in: ["PENDING", "EXPIRED"] } },
          data: {
            status: "PENDING",
            tokenHash: hashToken(token),
            expiresAt: new Date(Date.now() + body.expiresInDays * DAY_MS),
          },
        });
        const cur = await tx.staffInvitation.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!cur) return notFound();
        if (r.count === 0) throw new ConflictException({ error: "invitation_not_resendable" });
        return cur;
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "invitation_pending" }));
    await this.record(p, "invitation.resend", id);
    return { ...toInvitation(inv), token, acceptPath: acceptPath(p.tenantId, token) };
  }

  /**
   * Called by a signed-in user who is NOT yet a member of the tenant: `@Authenticated()` verifies the
   * token + MFA without resolving a membership. The invitation is bound to its e-mail address: the
   * IdP-verified e-mail on the token must match (403 `email_mismatch`). Single-use (conditional
   * PENDING -> ACCEPTED).
   */
  @Authenticated()
  @Post("accept")
  @HttpCode(200)
  async accept(
    @CurrentClaims() claims: VerifiedClaims,
    @Body(new ZodPipe(acceptInvitationRequest)) body: AcceptInvitationRequest,
  ) {
    const userId = claims.sub;
    const tokenHash = hashToken(body.token);
    const now = new Date();

    const result = await withTenant(
      this.prisma,
      body.tenantId,
      async (tx) => {
        const inv = await tx.staffInvitation.findFirst({
          where: { tenantId: body.tenantId, tokenHash },
        });
        if (!inv) return { kind: "not_found" as const };
        // Checked before status so a leaked link reveals nothing to the wrong account.
        if (!claims.email || claims.email.toLowerCase() !== inv.email.toLowerCase())
          return { kind: "email_mismatch" as const };
        if (inv.status === "PENDING" && inv.expiresAt <= now) {
          await tx.staffInvitation.update({ where: { id: inv.id }, data: { status: "EXPIRED" } });
          return { kind: "gone" as const, error: "invitation_expired" };
        }
        if (inv.status !== "PENDING") {
          return { kind: "gone" as const, error: `invitation_${inv.status.toLowerCase()}` };
        }
        const existing = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: body.tenantId, userId } },
        });
        // A removed member (soft removal keeps the row) is restored by a new invitation.
        if (existing && !isRemoved(existing)) return { kind: "member" as const };
        const claimed = await tx.staffInvitation.updateMany({
          where: { id: inv.id, status: "PENDING" },
          data: { status: "ACCEPTED", acceptedBy: userId, acceptedAt: now },
        });
        if (claimed.count === 0) return { kind: "gone" as const, error: "invitation_accepted" };
        // Access comes from the invitation; the e-mail is the IdP-verified claim (matched above).
        const access = {
          roles: inv.roles,
          orgWide: inv.orgWide,
          branchScope: inv.branchScope,
          email: claims.email.toLowerCase(),
        };
        const m = existing
          ? await tx.membership.update({ where: { id: existing.id }, data: access })
          : await tx.membership.create({ data: { tenantId: body.tenantId, userId, ...access } });
        return { kind: "ok" as const, membership: m, invitationId: inv.id, restored: !!existing };
      },
      { actorId: userId },
    ).catch((e) => mapDbError(e, { conflict: "already_member" }));

    if (result.kind === "not_found") throw new NotFoundException();
    if (result.kind === "email_mismatch") throw new ForbiddenException({ error: "email_mismatch" });
    if (result.kind === "gone") throw new GoneException({ error: result.error });
    if (result.kind === "member") throw new ConflictException({ error: "already_member" });
    const m = result.membership;
    const principal: Principal = {
      userId: m.userId,
      tenantId: m.tenantId,
      roles: m.roles,
      orgWide: m.orgWide,
      branchScope: m.branchScope,
    };
    await this.audit.record(principal, {
      action: "invitation.accept",
      resource: "StaffInvitation",
      resourceId: result.invitationId,
      outcome: "success",
    });
    this.bus.publish({
      tenantId: m.tenantId,
      type: result.restored ? "membership.updated" : "membership.created",
      data: { id: m.id },
    });
    return {
      id: m.id,
      userId: m.userId,
      roles: m.roles,
      orgWide: m.orgWide,
      branchScope: m.branchScope,
      displayName: m.displayName,
      email: m.email,
      createdAt: m.createdAt,
    };
  }

  private async record(p: Principal, action: string, id: string) {
    await this.audit.record(p, {
      action,
      resource: "StaffInvitation",
      resourceId: id,
      outcome: "success",
    });
  }
}

const acceptPath = (tenantId: string, token: string) =>
  `/invite/accept?tenantId=${encodeURIComponent(tenantId)}&token=${encodeURIComponent(token)}`;
