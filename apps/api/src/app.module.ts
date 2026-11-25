import { PrismaClient } from "@dentalos/db";
import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AiModule } from "./ai/ai.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { AuditService } from "./audit/audit.service";
import { AuthGuard, PRISMA } from "./auth/auth.guard";
import { PortalAuditService } from "./auth/portal-audit";
import {
  PORTAL_SECRETS,
  PORTAL_TOKEN_SERVICE,
  PortalTokenService,
  createPortalSecretsOrNull,
} from "./auth/portal-token";
import { PortalGuard } from "./auth/portal.guard";
import { TOKEN_VERIFIER, createTokenVerifier } from "./auth/token-verifier";
import { BillingModule } from "./billing/billing.module";
import { CatalogModule } from "./catalog/catalog.module";
import { ClinicalModule } from "./clinical/clinical.module";
import { CommissionsModule } from "./commissions/commissions.module";
import { JobQueueService } from "./common/job-queue.service";
import { DocumentsModule } from "./documents/documents.module";
import { HealthController } from "./health/health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { MeController } from "./me.controller";
import { NotificationsModule } from "./notifications/notifications.module";
import { logger } from "./observability/logger";
import { TracedExceptionFilter, TracingShutdown } from "./observability/tracing";
import { OrgModule } from "./org/org.module";
import { PatientsModule } from "./patients/patients.module";
import { PlansModule } from "./plans/plans.module";
import { PortalAdminModule } from "./portal-admin/portal-admin.module";
import { PortalModule } from "./portal/portal.module";
import { EventBus } from "./realtime/event-bus";
import { EventsController } from "./realtime/events.controller";
import { SchedulingModule } from "./scheduling/scheduling.module";
import { StorageService } from "./storage/storage.service";

@Global()
@Module({
  // Feature modules: each is self-contained; workers add controllers/providers inside them only.
  imports: [
    // M1
    OrgModule,
    CatalogModule,
    PatientsModule,
    DocumentsModule,
    // M2
    SchedulingModule,
    ClinicalModule,
    PlansModule,
    // M3
    BillingModule,
    CommissionsModule,
    InventoryModule,
    NotificationsModule,
    // M4
    PortalModule,
    PortalAdminModule,
    AnalyticsModule,
    AiModule,
  ],
  controllers: [HealthController, MeController, EventsController],
  providers: [
    {
      provide: PRISMA,
      useFactory: () =>
        new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }),
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: () => createTokenVerifier(),
    },
    // Portal secrets: null when unset (portal routes then fail closed; the staff API still boots).
    {
      provide: PORTAL_SECRETS,
      useFactory: () =>
        createPortalSecretsOrNull(process.env, (m) =>
          logger.warn({ reason: m }, "patient portal disabled: secrets not configured"),
        ),
    },
    {
      provide: PORTAL_TOKEN_SERVICE,
      inject: [PORTAL_SECRETS],
      useFactory: (secrets: ConstructorParameters<typeof PortalTokenService>[0]) =>
        new PortalTokenService(secrets),
    },
    // Two global guards, mutually exclusive: AuthGuard skips @PortalAuth() routes, PortalGuard acts only on them.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PortalGuard },
    { provide: APP_FILTER, useClass: TracedExceptionFilter },
    AuditService,
    PortalAuditService,
    EventBus,
    JobQueueService,
    StorageService,
    TracingShutdown,
  ],
  exports: [
    PRISMA,
    AuditService,
    PortalAuditService,
    PORTAL_SECRETS,
    PORTAL_TOKEN_SERVICE,
    EventBus,
    JobQueueService,
    StorageService,
  ],
})
export class AppModule {}
