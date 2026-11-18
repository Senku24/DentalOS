import {
  type ConvertEnquiryRequest,
  type CreateEnquiryRequest,
  type ListEnquiriesQuery,
  type UpdateEnquiryRequest,
  convertEnquiryRequest,
  createEnquiryRequest,
  listEnquiriesQuery,
  updateEnquiryRequest,
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
import { EnquiriesService } from "./enquiries.service";

const Id = () => Param("id", new ParseUUIDPipe());

@Controller("enquiries")
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Can("patient:write")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createEnquiryRequest)) body: CreateEnquiryRequest,
  ) {
    return this.enquiries.create(p, body);
  }

  @Can("patient:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listEnquiriesQuery)) q: ListEnquiriesQuery,
  ) {
    return this.enquiries.list(p, q);
  }

  @Can("patient:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.enquiries.get(p, id);
  }

  @Can("patient:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateEnquiryRequest)) body: UpdateEnquiryRequest,
  ) {
    return this.enquiries.update(p, id, body);
  }

  /** Runs the duplicate check first (409 with matches unless acknowledged or linking an existing patient). */
  @Can("patient:write")
  @Post(":id/convert")
  @HttpCode(200)
  convert(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(convertEnquiryRequest)) body: ConvertEnquiryRequest,
  ) {
    return this.enquiries.convert(p, id, body);
  }
}
