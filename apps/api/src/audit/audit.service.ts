import { PrismaClient, withTenant } from "@dentalos/db";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Append-only. Never put clinical/PII content in `resourceId`; ids only. */
  record(
    p: Principal,
    e: {
      action: string;
      resource: string;
      resourceId?: string;
      branchId?: string;
      outcome: "success" | "denied" | "error";
      source?: string;
    },
  ) {
    return withTenant(this.prisma, p.tenantId, (tx) =>
      tx.auditEvent.create({
        data: {
          tenantId: p.tenantId,
          actorId: p.userId,
          source: e.source ?? "api",
          branchId: e.branchId,
          action: e.action,
          resource: e.resource,
          resourceId: e.resourceId,
          outcome: e.outcome,
        },
      }),
    );
  }
}
