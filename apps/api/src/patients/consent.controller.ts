import {
  type RecordConsentRequest,
  type SetCommunicationPreferencesRequest,
  recordConsentRequest,
  setCommunicationPreferencesRequest,
  withdrawConsentRequest,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { ConsentService } from "./consent.service";

const Id = () => Param("id", new ParseUUIDPipe());

/** Consent records (consent:manage, branch-scoped) and communication preferences. */
@Controller("patients/:id")
export class ConsentController {
  constructor(private readonly consents: ConsentService) {}

  @Can("consent:manage")
  @Get("consents")
  list(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.list(p, id);
  }

  @Can("consent:manage")
  @Post("consents")
  record(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(recordConsentRequest)) body: RecordConsentRequest,
  ) {
    return this.consents.record(p, id, body);
  }

  @Can("consent:manage")
  @Post("consents/:consentId/withdraw")
  @HttpCode(200)
  withdraw(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Param("consentId", new ParseUUIDPipe()) consentId: string,
    @Body(new ZodPipe(withdrawConsentRequest)) body: { reason?: string },
  ) {
    return this.consents.withdraw(p, id, consentId, body.reason);
  }

  @Can("patient:read")
  @Get("communication-preferences")
  preferences(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.preferences(p, id);
  }

  @Can("patient:write")
  @Put("communication-preferences")
  setPreferences(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(setCommunicationPreferencesRequest)) body: SetCommunicationPreferencesRequest,
  ) {
    return this.consents.setPreferences(p, id, body);
  }
}
