import {
  type AppointmentTransitionRequest,
  type BookAppointmentRequest,
  type CancelAppointmentRequest,
  type CheckInQueueQuery,
  type CreateWalkInRequest,
  type ListAppointmentsQuery,
  type RescheduleAppointmentRequest,
  type UpdateAppointmentRequest,
  appointmentTransitionRequest,
  bookAppointmentRequest,
  cancelAppointmentRequest,
  checkInQueueQuery,
  createWalkInRequest,
  listAppointmentsQuery,
  rescheduleAppointmentRequest,
  updateAppointmentRequest,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { AppointmentsService } from "./appointments.service";
import { UUID } from "./scheduling-common";

/**
 * Route capability via @Can; the service enforces the branch and the ADR 0003 §1.2 permission of the
 * target status (APPOINTMENT_TRANSITION_PERMISSIONS) against the appointment's branch.
 */
@Controller("appointments")
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Can("appointment:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listAppointmentsQuery)) q: ListAppointmentsQuery,
  ) {
    return this.appointments.list(p, q);
  }

  @Can("appointment:write")
  @Post()
  book(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(bookAppointmentRequest)) body: BookAppointmentRequest,
  ) {
    return this.appointments.book(p, body);
  }

  @Can("appointment:write")
  @Post("walk-in")
  walkIn(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createWalkInRequest)) body: CreateWalkInRequest,
  ) {
    return this.appointments.walkIn(p, body);
  }

  @Can("appointment:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.appointments.get(p, id);
  }

  @Can("appointment:read")
  @Get(":id/events")
  events(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.appointments.events(p, id);
  }

  @Can("appointment:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateAppointmentRequest)) body: UpdateAppointmentRequest,
  ) {
    return this.appointments.update(p, id, body);
  }

  /** Any transition permission suffices for the route; the target status decides (service). */
  @Can("appointment:read")
  @Post(":id/status")
  @HttpCode(200)
  transition(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(appointmentTransitionRequest)) body: AppointmentTransitionRequest,
  ) {
    return this.appointments.transition(p, id, body);
  }

  @Can("appointment:write")
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(cancelAppointmentRequest)) body: CancelAppointmentRequest,
  ) {
    return this.appointments.cancel(p, id, body);
  }

  @Can("appointment:write")
  @Post(":id/reschedule")
  reschedule(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(rescheduleAppointmentRequest)) body: RescheduleAppointmentRequest,
  ) {
    return this.appointments.reschedule(p, id, body);
  }
}

/** Check-in / waiting queue (live updates via SSE `/events`, SCHEDULING_EVENT_TYPES). */
@Controller("front-desk")
export class FrontDeskController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Can("appointment:read")
  @Get("queue")
  queue(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(checkInQueueQuery)) q: CheckInQueueQuery,
  ) {
    return this.appointments.queue(p, q);
  }
}
