import { PrismaClient, withTenant } from "@dentalos/db";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "./auth.guard";

/** Actor recorded for portal events before a session exists (login attempts); never a person's id. */
export const PORTAL_ANONYMOUS_ACTOR = "portal:anonymous";

/**
 * Portal audit trail (ADR 0005 §3.6): portal actions are written to the SAME hash-chained `AuditEvent` table as staff
 * actions, with `source = "portal"` and `actorId = "patient:<patientId>"` (or `portal:anonymous` before login), so one
 * query shows everything that happened to a patient's record. Ids only — never names, phone numbers, codes or content.
 */
@Injectable()
export class PortalAuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  record(
    who: { tenantId: string; actorId: string },
    e: {
      action: string;
      resource: string;
      resourceId?: string;
      branchId?: string;
      outcome: "success" | "denied" | "error";
    },
  ) {
    return withTenant(this.prisma, who.tenantId, (tx) =>
      tx.auditEvent.create({
        data: {
          tenantId: who.tenantId,
          actorId: who.actorId,
          source: "portal",
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
