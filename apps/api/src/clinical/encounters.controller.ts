import {
  type AttachEncounterDocumentRequest,
  type CreateAmendmentRequest,
  type CreateDiagnosisRequest,
  type CreateNoteRequest,
  type CreateProcedureRequest,
  type ListEncountersQuery,
  type OpenEncounterRequest,
  type UpdateDiagnosisRequest,
  type UpdateEncounterRequest,
  type UpdateNoteRequest,
  type UpdateProcedureRequest,
  attachEncounterDocumentRequest,
  createAmendmentRequest,
  createDiagnosisRequest,
  createNoteRequest,
  createProcedureRequest,
  listEncountersQuery,
  openEncounterRequest,
  signEncounterRequest,
  updateDiagnosisRequest,
  updateEncounterRequest,
  updateNoteRequest,
  updateProcedureRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Delete,
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
import { EncountersService } from "./encounters.service";

const Id = (name = "id") => Param(name, new ParseUUIDPipe());

/**
 * Encounters and their content (PRD 3.4, 4.4; ADR 0003 §2). `@Can` proves the capability; the
 * service re-checks it against the encounter's branch.
 */
@Controller("encounters")
export class EncountersController {
  constructor(private readonly svc: EncountersService) {}

  @Can("clinical:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listEncountersQuery)) q: ListEncountersQuery,
  ) {
    return this.svc.list(p, q);
  }

  @Can("clinical:write")
  @Post()
  open(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(openEncounterRequest)) body: OpenEncounterRequest,
  ) {
    return this.svc.open(p, body);
  }

  @Can("clinical:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.svc.get(p, id);
  }

  @Can("clinical:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateEncounterRequest)) body: UpdateEncounterRequest,
  ) {
    return this.svc.update(p, id, body);
  }

  @Can("clinical:sign")
  @Post(":id/sign")
  @HttpCode(200)
  sign(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(signEncounterRequest)) _body: unknown,
  ) {
    return this.svc.sign(p, id);
  }

  // Notes & amendments ----------------------------------------------------------------------

  @Can("clinical:write")
  @Post(":id/notes")
  addNote(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(createNoteRequest)) body: CreateNoteRequest,
  ) {
    return this.svc.addNote(p, id, body);
  }

  @Can("clinical:write")
  @Patch(":id/notes/:noteId")
  updateNote(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("noteId") noteId: string,
    @Body(new ZodPipe(updateNoteRequest)) body: UpdateNoteRequest,
  ) {
    return this.svc.updateNote(p, id, noteId, body);
  }

  @Can("clinical:write")
  @Delete(":id/notes/:noteId")
  @HttpCode(204)
  deleteNote(@CurrentPrincipal() p: Principal, @Id() id: string, @Id("noteId") noteId: string) {
    return this.svc.deleteNote(p, id, noteId);
  }

  @Can("clinical:read")
  @Get(":id/amendments")
  listAmendments(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.svc.listAmendments(p, id);
  }

  @Can("clinical:amend")
  @Post(":id/amendments")
  addAmendment(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(createAmendmentRequest)) body: CreateAmendmentRequest,
  ) {
    return this.svc.addAmendment(p, id, body);
  }

  // Diagnoses --------------------------------------------------------------------------------

  @Can("clinical:write")
  @Post(":id/diagnoses")
  addDiagnosis(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(createDiagnosisRequest)) body: CreateDiagnosisRequest,
  ) {
    return this.svc.addDiagnosis(p, id, body);
  }

  @Can("clinical:write")
  @Patch(":id/diagnoses/:diagnosisId")
  updateDiagnosis(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("diagnosisId") diagnosisId: string,
    @Body(new ZodPipe(updateDiagnosisRequest)) body: UpdateDiagnosisRequest,
  ) {
    return this.svc.updateDiagnosis(p, id, diagnosisId, body);
  }

  @Can("clinical:write")
  @Delete(":id/diagnoses/:diagnosisId")
  @HttpCode(204)
  deleteDiagnosis(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("diagnosisId") diagnosisId: string,
  ) {
    return this.svc.deleteDiagnosis(p, id, diagnosisId);
  }

  // Procedures -------------------------------------------------------------------------------

  @Can("clinical:write")
  @Post(":id/procedures")
  addProcedure(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(createProcedureRequest)) body: CreateProcedureRequest,
  ) {
    return this.svc.addProcedure(p, id, body);
  }

  @Can("clinical:write")
  @Patch(":id/procedures/:procedureId")
  updateProcedure(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("procedureId") procedureId: string,
    @Body(new ZodPipe(updateProcedureRequest)) body: UpdateProcedureRequest,
  ) {
    return this.svc.updateProcedure(p, id, procedureId, body);
  }

  @Can("clinical:write")
  @Delete(":id/procedures/:procedureId")
  @HttpCode(204)
  deleteProcedure(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("procedureId") procedureId: string,
  ) {
    return this.svc.deleteProcedure(p, id, procedureId);
  }

  // Documents --------------------------------------------------------------------------------

  @Can("clinical:read")
  @Get(":id/documents")
  listDocuments(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.svc.listDocuments(p, id);
  }

  @Can("clinical:write")
  @Post(":id/documents")
  @HttpCode(200)
  attachDocument(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(attachEncounterDocumentRequest)) body: AttachEncounterDocumentRequest,
  ) {
    return this.svc.attachDocument(p, id, body.documentId);
  }

  @Can("clinical:write")
  @Delete(":id/documents/:documentId")
  @HttpCode(204)
  detachDocument(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Id("documentId") documentId: string,
  ) {
    return this.svc.detachDocument(p, id, documentId);
  }
}
