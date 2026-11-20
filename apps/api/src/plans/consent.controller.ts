import {
  type CreateConsentTemplateRequest,
  type ListConsentTemplatesQuery,
  type PublishConsentTemplateVersionRequest,
  type SignConsentRequest,
  type UpdateConsentTemplateRequest,
  createConsentTemplateRequest,
  listConsentTemplatesQuery,
  publishConsentTemplateVersionRequest,
  signConsentRequest,
  updateConsentTemplateRequest,
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
import { PlanConsentService } from "./consent.service";

const Id = () => Param("id", new ParseUUIDPipe());

/**
 * Consent templates: read with consent:manage (whoever captures consent needs the text); create,
 * edit, (de)activate and publish versions with consent:template (org scope, OWNER).
 */
@Controller("consent-templates")
export class ConsentTemplatesController {
  constructor(private readonly consents: PlanConsentService) {}

  @Can("consent:manage")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listConsentTemplatesQuery)) q: ListConsentTemplatesQuery,
  ) {
    return this.consents.listTemplates(p, q);
  }

  @Can("consent:template")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createConsentTemplateRequest)) body: CreateConsentTemplateRequest,
  ) {
    return this.consents.createTemplate(p, body);
  }

  @Can("consent:manage")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.getTemplate(p, id);
  }

  @Can("consent:template")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateConsentTemplateRequest)) body: UpdateConsentTemplateRequest,
  ) {
    return this.consents.updateTemplate(p, id, body);
  }

  @Can("consent:template")
  @Post(":id/activate")
  @HttpCode(200)
  activate(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.setActive(p, id, true);
  }

  @Can("consent:template")
  @Post(":id/deactivate")
  @HttpCode(200)
  deactivate(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.setActive(p, id, false);
  }

  @Can("consent:manage")
  @Get(":id/versions")
  versions(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.listVersions(p, id);
  }

  @Can("consent:template")
  @Post(":id/versions")
  publish(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(publishConsentTemplateVersionRequest))
    body: PublishConsentTemplateVersionRequest,
  ) {
    return this.consents.publishVersion(p, id, body);
  }
}

/** Signing a template-backed consent (consent:manage on the branch; plan consent also on the plan's). */
@Controller("patients/:id/consents")
export class SignConsentController {
  constructor(private readonly consents: PlanConsentService) {}

  @Can("consent:manage")
  @Post("sign")
  sign(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(signConsentRequest)) body: SignConsentRequest,
  ) {
    return this.consents.sign(p, id, body);
  }
}
