import {
  type CheckPreferencesQuery,
  type ListOutboxQuery,
  type ListRecallSettingsQuery,
  type SendTestNotificationRequest,
  type UpdateNotificationSettingsRequest,
  type UpsertRecallSettingRequest,
  checkPreferencesQuery,
  listOutboxQuery,
  listRecallSettingsQuery,
  recallSweepJob,
  sendTestNotificationRequest,
  updateNotificationSettingsRequest,
  upsertRecallSettingRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  type RawBodyRequest,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { Can, Public } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { DeliveryService } from "./delivery.service";
import { OutboxService } from "./outbox.service";
import { NotificationSettingsService } from "./settings.service";

const Id = () => Param("id", new ParseUUIDPipe());

/** Outbox, test send, consent preview, settings and recall intervals (see each service for the rules). */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Can("comms:read")
  @Get("outbox")
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listOutboxQuery)) q: ListOutboxQuery) {
    return this.outbox.list(p, q);
  }

  @Can("comms:read")
  @Get("outbox/:id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.outbox.get(p, id);
  }

  @Can("comms:send")
  @Post("outbox/:id/retry")
  @HttpCode(200)
  retry(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.outbox.retry(p, id);
  }

  @Can("comms:send")
  @Post("outbox/:id/cancel")
  @HttpCode(200)
  cancel(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.outbox.cancel(p, id);
  }

  /** comms:templates ONLY (OWNER): `toAddress` is arbitrary, comms:send (reception) would make this an open relay. */
  @Can("comms:templates")
  @Post("test")
  send(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(sendTestNotificationRequest)) body: SendTestNotificationRequest,
  ) {
    return this.outbox.sendTest(p, body);
  }

  @Can("comms:read")
  @Get("preferences/check")
  check(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(checkPreferencesQuery)) q: CheckPreferencesQuery,
  ) {
    return this.outbox.checkPreferences(p, q);
  }

  @Can("comms:templates")
  @Get("settings")
  getSettings(@CurrentPrincipal() p: Principal) {
    return this.settings.getSettings(p);
  }

  @Can("comms:templates")
  @Patch("settings")
  patchSettings(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(updateNotificationSettingsRequest)) body: UpdateNotificationSettingsRequest,
  ) {
    return this.settings.updateSettings(p, body);
  }

  @Can("comms:templates")
  @Get("recall-settings")
  listRecall(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listRecallSettingsQuery)) q: ListRecallSettingsQuery,
  ) {
    return this.settings.listRecall(p, q);
  }

  @Can("comms:templates")
  @Put("recall-settings")
  upsertRecall(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(upsertRecallSettingRequest)) body: UpsertRecallSettingRequest,
  ) {
    return this.settings.upsertRecall(p, body);
  }

  /** Queues a recall sweep for this tenant now (the cron runs it daily). */
  @Can("comms:templates")
  @Post("recall-sweep")
  @HttpCode(202)
  sweep(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(recallSweepJob)) body: { asOf?: string },
  ) {
    return this.settings.requestRecallSweep(p, body.asOf);
  }
}

/** Provider delivery receipts: no staff auth, authenticated by the HMAC signature over the raw body. */
@Controller("webhooks/notifications")
export class NotificationWebhooksController {
  constructor(private readonly delivery: DeliveryService) {}

  @Public()
  @Post(":provider/:tenantId")
  @HttpCode(200)
  receipt(
    @Param("provider") provider: string,
    @Param("tenantId", new ParseUUIDPipe()) tenantId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.delivery.receipt(provider, tenantId, req.headers, req.rawBody);
  }
}
