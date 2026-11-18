import { PrismaClient } from "@dentalos/db";
import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditService } from "./audit/audit.service";
import { AuthGuard, PRISMA } from "./auth/auth.guard";
import { DevTokenVerifier, TOKEN_VERIFIER } from "./auth/token-verifier";
import { HealthController } from "./health/health.controller";
import { MeController } from "./me.controller";

@Global()
@Module({
  controllers: [HealthController, MeController],
  providers: [
    {
      provide: PRISMA,
      useFactory: () =>
        new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } }),
    },
    {
      provide: TOKEN_VERIFIER,
      useFactory: () => {
        const s = process.env.DEV_JWT_SECRET;
        if (!s) throw new Error("DEV_JWT_SECRET required until IdP verifier is configured");
        return new DevTokenVerifier(new TextEncoder().encode(s));
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    AuditService,
  ],
  exports: [PRISMA, AuditService],
})
export class AppModule {}
