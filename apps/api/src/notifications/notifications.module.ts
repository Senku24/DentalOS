import { Module } from "@nestjs/common";
import { DeliveryService } from "./delivery.service";
import { NotificationEnqueueService } from "./enqueue.service";
import {
  NotificationWebhooksController,
  NotificationsController,
} from "./notifications.controller";
import { OutboxService } from "./outbox.service";
import { NotificationSettingsService } from "./settings.service";
import { NotificationTemplatesController } from "./templates.controller";
import { TemplatesService } from "./templates.service";

/**
 * M3 Notifications (PRD 4.7): versioned templates, outbox + enqueue service, consent-aware sending, provider
 * interface (console sender, in the worker), delivery-receipt webhook, settings and recall intervals; the sending itself
 * runs in background jobs (apps/worker/src/handlers/notifications, owned by the same worker).
 * PRISMA, AuditService, EventBus, JobQueueService and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §9, §10; DTOs, consent resolution and queue names in
 * @dentalos/validation `notifications.ts`. Other modules enqueue jobs by name and never import from here.
 * See docs/M3-business-ops.md.
 */
@Module({
  controllers: [
    NotificationTemplatesController,
    NotificationsController,
    NotificationWebhooksController,
  ],
  providers: [
    TemplatesService,
    OutboxService,
    NotificationEnqueueService,
    NotificationSettingsService,
    DeliveryService,
  ],
})
export class NotificationsModule {}
