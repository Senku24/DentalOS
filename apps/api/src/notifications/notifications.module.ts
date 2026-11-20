import { Module } from "@nestjs/common";

/**
 * M3 Notifications (PRD 4.7): versioned templates, outbox + enqueue service, consent-aware sending, provider
 * interface (console sender), delivery-receipt webhook, settings and recall intervals; the sending itself runs in
 * background jobs (apps/worker/src/handlers, owned by the same worker).
 * Owned by Wave 1 worker N1 — add controllers/providers here only (apps/api/src/notifications/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §9, §10; DTOs, consent resolution and queue names in
 * @dentalos/validation `notifications.ts`. Other modules enqueue jobs by name and never import from here.
 * See docs/M3-business-ops.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class NotificationsModule {}
