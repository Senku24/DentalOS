import {
  type CreateNotificationTemplateRequest,
  type ListNotificationTemplatesQuery,
  type PreviewNotificationTemplateRequest,
  type PublishNotificationTemplateVersionRequest,
  type UpdateNotificationTemplateRequest,
  createNotificationTemplateRequest,
  listNotificationTemplatesQuery,
  previewNotificationTemplateRequest,
  publishNotificationTemplateVersionRequest,
  updateNotificationTemplateRequest,
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
  Query,
} from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { TemplatesService } from "./templates.service";

const Id = () => Param("id", new ParseUUIDPipe());

/**
 * Notification templates. Reading: comms:read (anyone who sends or reviews messages); authoring, versions, preview:
 * comms:templates (org scope, OWNER).
 */
@Controller("notification-templates")
export class NotificationTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Can("comms:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listNotificationTemplatesQuery)) q: ListNotificationTemplatesQuery,
  ) {
    return this.templates.list(p, q);
  }

  @Can("comms:templates")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createNotificationTemplateRequest)) body: CreateNotificationTemplateRequest,
  ) {
    return this.templates.create(p, body);
  }

  @Can("comms:templates")
  @Post("preview")
  @HttpCode(200)
  preview(
    @Body(new ZodPipe(previewNotificationTemplateRequest)) body: PreviewNotificationTemplateRequest,
    @Query("code") code?: string,
  ) {
    return this.templates.preview(body, code);
  }

  @Can("comms:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.templates.get(p, id);
  }

  @Can("comms:templates")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateNotificationTemplateRequest)) body: UpdateNotificationTemplateRequest,
  ) {
    return this.templates.update(p, id, body);
  }

  @Can("comms:read")
  @Get(":id/versions")
  versions(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.templates.versions(p, id);
  }

  @Can("comms:templates")
  @Post(":id/versions")
  publish(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(publishNotificationTemplateVersionRequest))
    body: PublishNotificationTemplateVersionRequest,
  ) {
    return this.templates.publish(p, id, body);
  }
}
