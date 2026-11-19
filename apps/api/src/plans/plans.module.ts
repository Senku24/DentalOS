import { Module } from "@nestjs/common";
import { ConsentTemplatesController, SignConsentController } from "./consent.controller";
import { PlanConsentService } from "./consent.service";
import {
  PlanItemSessionsController,
  PlanItemsController,
  PlansController,
} from "./plans.controller";
import { PlansService } from "./plans.service";
import { SessionsService } from "./sessions.service";

/**
 * M2 Treatment plans & consent (PRD 4.5): plans, items with frozen estimates (catalog pricing.ts),
 * per-item decisions, sessions, version snapshots + diff, present/approve, consent templates and
 * versions, signed consent tied to a plan version. Rules: docs/adr/0003-clinical-domain-rules.md
 * §3–4 (proposed); session status table in ./session-status.ts.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 */
@Module({
  controllers: [
    PlansController,
    PlanItemsController,
    PlanItemSessionsController,
    ConsentTemplatesController,
    SignConsentController,
  ],
  providers: [PlansService, SessionsService, PlanConsentService],
})
export class PlansModule {}
