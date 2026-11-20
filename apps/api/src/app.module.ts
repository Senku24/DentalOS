import { PrismaClient } from "@dentalos/db";
import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuditService } from "./audit/audit.service";
import { AuthGuard, PRISMA } from "./auth/auth.guard";
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
import { TracedExceptionFilter, TracingShutdown } from "./observability/tracing";
import { OrgModule } from "./org/org.module";
import { PatientsModule } from "./patients/patients.module";
import { PlansModule } from "./plans/plans.module";
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
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: TracedExceptionFilter },
    AuditService,
    EventBus,
    JobQueueService,
    StorageService,
    TracingShutdown,
  ],
  exports: [PRISMA, AuditService, EventBus, JobQueueService, StorageService],
})
export class AppModule {}
