import { PrismaClient } from "@dentalos/db";
import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuditService } from "./audit/audit.service";
import { AuthGuard, PRISMA } from "./auth/auth.guard";
import { TOKEN_VERIFIER, createTokenVerifier } from "./auth/token-verifier";
import { CatalogModule } from "./catalog/catalog.module";
import { DocumentsModule } from "./documents/documents.module";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me.controller";
import { TracedExceptionFilter, TracingShutdown } from "./observability/tracing";
import { OrgModule } from "./org/org.module";
import { PatientsModule } from "./patients/patients.module";
import { EventBus } from "./realtime/event-bus";
import { EventsController } from "./realtime/events.controller";
import { StorageService } from "./storage/storage.service";

@Global()
@Module({
  // M1 feature modules: each is self-contained; workers add controllers/providers inside them only.
  imports: [OrgModule, CatalogModule, PatientsModule, DocumentsModule],
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
    StorageService,
    TracingShutdown,
  ],
  exports: [PRISMA, AuditService, EventBus, StorageService],
})
export class AppModule {}
