import {
  type AppointmentDetailResponse,
  type AppointmentEventResponse,
  type AppointmentListResponse,
  type AppointmentResponse,
  type AppointmentStatus,
  type AppointmentTransitionRequest,
  type AvailabilityResponse,
  type BookAppointmentRequest,
  type ChairResponse,
  type CheckInQueueResponse,
  type CreateChairRequest,
  type CreateWalkInRequest,
  type DentistAssignmentResponse,
  type RescheduleAppointmentRequest,
  type SchedulingDentistsResponse,
  type SchedulingSettingsResponse,
  type SetWorkingHoursRequest,
  type StaffMemberResponse,
  type TreatmentPlanResponse,
  type TreatmentPlanSummary,
  type UpdateAppointmentRequest,
  type UpdateChairRequest,
  type UpdateSchedulingSettingsRequest,
  type WorkingHoursResponse,
  appointmentDetailResponse,
  appointmentListResponse,
  availabilityResponse,
  chairResponse,
  checkInQueueResponse,
  schedulingDentistsResponse,
  schedulingSettingsResponse,
  workingHoursResponse,
  z,
} from "@dentalos/validation";
import { type ApiClient, MOCK_MODE, type MockHandler, apiClient, createClient } from "./client";
import { API_PREFIX } from "./routes";
import type { Items, Page } from "./types";

/**
 * Scheduling & front desk API (PRD 4.3, ADR 0003 §1). Paths mirror the Wave 1 controllers in
 * apps/api/src/scheduling/*.controller.ts — the source of truth:
 *   chairs.controller.ts         /chairs, /chairs/:id, /chairs/:id/{activate,deactivate}
 *   working-hours.controller.ts  /working-hours (GET, PUT), /scheduling/settings?branchId (GET, PATCH)
 *   dentists.controller.ts       /scheduling/dentists?branchId (appointment:read)
 *   availability.controller.ts   /availability
 *   appointments.controller.ts   /appointments, /appointments/walk-in, /appointments/:id,
 *                                /appointments/:id/{events,status,cancel,reschedule}, /front-desk/queue
 *   realtime/events.controller   /events (SSE, Bearer/cookie auth → fetch-based reader)
 *   plans/plans.controller.ts    /plans, /plans/:id (read-only here: plan-item link when booking)
 * Re-exported from the shared lib/api/routes.ts (`allRoutes`), the one route table.
 */

const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const schedulingRoutes = {
  // ---- Chairs ------------------------------------------------------------------------------
  /** GET ?branchId&active → { items }, POST createChairRequest */
  chairs: () => p("/chairs"),
  /** GET, PATCH updateChairRequest */
  chair: (chairId: string) => p(`/chairs/${id(chairId)}`),
  /** POST (200) */
  chairActivate: (chairId: string) => p(`/chairs/${id(chairId)}/activate`),
  /** POST (200) */
  chairDeactivate: (chairId: string) => p(`/chairs/${id(chairId)}/deactivate`),

  // ---- Working hours & knobs ---------------------------------------------------------------
  /** GET ?branchId&scope&userId&chairId&on&includeHistory → { items }, PUT setWorkingHoursRequest → { items } */
  workingHours: () => p("/working-hours"),
  /** GET ?branchId → schedulingSettingsResponse, PATCH ?branchId updateSchedulingSettingsRequest */
  schedulingSettings: () => p("/scheduling/settings"),
  /** GET ?branchId → schedulingDentistsResponse (appointment:read: usable by every scheduling role) */
  schedulingDentists: () => p("/scheduling/dentists"),

  // ---- Availability ------------------------------------------------------------------------
  /** GET ?branchId&date&durationMin&dentistUserId&chairId&stepMin → availabilityResponse */
  availability: () => p("/availability"),

  // ---- Appointments ------------------------------------------------------------------------
  /** GET listAppointmentsQuery → { items, truncated }, POST bookAppointmentRequest → appointmentResponse */
  appointments: () => p("/appointments"),
  /** POST createWalkInRequest → appointmentResponse */
  appointmentWalkIn: () => p("/appointments/walk-in"),
  /** GET → appointmentDetailResponse (with events), PATCH updateAppointmentRequest */
  appointment: (appointmentId: string) => p(`/appointments/${id(appointmentId)}`),
  /** GET → { items: appointmentEventResponse[] } */
  appointmentEvents: (appointmentId: string) => p(`/appointments/${id(appointmentId)}/events`),
  /** POST appointmentTransitionRequest (200) → appointmentResponse */
  appointmentStatus: (appointmentId: string) => p(`/appointments/${id(appointmentId)}/status`),
  /** POST cancelAppointmentRequest (200) → appointmentResponse */
  appointmentCancel: (appointmentId: string) => p(`/appointments/${id(appointmentId)}/cancel`),
  /** POST rescheduleAppointmentRequest (201) → the NEW appointmentResponse */
  appointmentReschedule: (appointmentId: string) =>
    p(`/appointments/${id(appointmentId)}/reschedule`),

  // ---- Front desk --------------------------------------------------------------------------
  /** GET ?branchId&date → checkInQueueResponse */
  frontDeskQueue: () => p("/front-desk/queue"),
  /** GET text/event-stream (SCHEDULING_EVENT_TYPES; data carries branchId) */
  events: () => p("/events"),

  // ---- Plans (read-only, for linking a booking to an ACCEPTED plan item) --------------------
  /** GET ?patientId&branchId&status&cursor&limit → page(treatmentPlanSummary) */
  plans: () => p("/plans"),
  /** GET → treatmentPlanResponse (with items) */
  plan: (planId: string) => p(`/plans/${id(planId)}`),

  // ---- Staff directory (M1 org module; both need staff:read, which RECEPTIONIST/DENTIST lack;
  // pickers use schedulingDentists instead) ----------------------------------------------------
  /** GET ?userId&branchId&status → { items: dentistAssignmentResponse[] } (org/assignments.controller.ts) */
  dentistAssignments: () => p("/dentist-assignments"),
  /** GET ?role&branchId → { items: staffMemberResponse[] } (org/staff.controller.ts) */
  staff: () => p("/staff"),
} as const;

export type SchedulingRouteName = keyof typeof schedulingRoutes;

/** `GET /appointments` filters (listAppointmentsQuery; `status` is a comma list on the wire). */
export interface AppointmentListQuery {
  branchId?: string;
  from?: string;
  to?: string;
  dentistUserId?: string;
  chairId?: string;
  patientId?: string;
  status?: readonly AppointmentStatus[];
}

const items = <T extends z.ZodType>(s: T) => z.object({ items: z.array(s) });

export function createSchedulingApi(c: ApiClient) {
  const get = <T>(path: string, query?: Record<string, unknown>, schema?: z.ZodType<T>) =>
    c.request<T>("GET", path, { query: query as Record<string, string>, schema });
  const send = <T>(
    method: "POST" | "PUT" | "PATCH",
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => c.request<T>(method, path, { body: body ?? {}, query });
  const r = schedulingRoutes;

  return {
    chairs: {
      list: (q: { branchId?: string; active?: boolean } = {}) =>
        get<Items<ChairResponse>>(r.chairs(), q, items(chairResponse)),
      get: (chairId: string) => get<ChairResponse>(r.chair(chairId), undefined, chairResponse),
      create: (b: CreateChairRequest) => send<ChairResponse>("POST", r.chairs(), b),
      update: (chairId: string, b: UpdateChairRequest) =>
        send<ChairResponse>("PATCH", r.chair(chairId), b),
      setActive: (chairId: string, active: boolean) =>
        send<ChairResponse>("POST", active ? r.chairActivate(chairId) : r.chairDeactivate(chairId)),
    },
    hours: {
      list: (q: {
        branchId: string;
        scope?: "BRANCH" | "DENTIST" | "CHAIR";
        userId?: string;
        chairId?: string;
        on?: string;
        includeHistory?: boolean;
      }) => get<Items<WorkingHoursResponse>>(r.workingHours(), q, items(workingHoursResponse)),
      set: (b: SetWorkingHoursRequest) =>
        send<Items<WorkingHoursResponse>>("PUT", r.workingHours(), b),
    },
    settings: {
      get: (branchId: string) =>
        get<SchedulingSettingsResponse>(
          r.schedulingSettings(),
          { branchId },
          schedulingSettingsResponse,
        ),
      update: (branchId: string, b: UpdateSchedulingSettingsRequest) =>
        send<SchedulingSettingsResponse>("PATCH", r.schedulingSettings(), b, { branchId }),
    },
    availability: (q: {
      branchId: string;
      date: string;
      durationMin: number;
      dentistUserId?: string;
      chairId?: string;
      stepMin?: number;
    }) => get<AvailabilityResponse>(r.availability(), q, availabilityResponse),
    /** Current dentists at a branch (ids + display names) for pickers, filters and labels. */
    dentists: (branchId: string) =>
      get<SchedulingDentistsResponse>(
        r.schedulingDentists(),
        { branchId },
        schedulingDentistsResponse,
      ),
    appointments: {
      /** `truncated`: the API cap was hit (later rows missing). */
      list: (q: AppointmentListQuery) =>
        get<AppointmentListResponse>(
          r.appointments(),
          { ...q, status: q.status?.length ? q.status.join(",") : undefined },
          appointmentListResponse,
        ),
      get: (appointmentId: string) =>
        get<AppointmentDetailResponse>(
          r.appointment(appointmentId),
          undefined,
          appointmentDetailResponse,
        ),
      events: (appointmentId: string) =>
        get<Items<AppointmentEventResponse>>(r.appointmentEvents(appointmentId)),
      book: (b: BookAppointmentRequest) => send<AppointmentResponse>("POST", r.appointments(), b),
      walkIn: (b: CreateWalkInRequest) =>
        send<AppointmentResponse>("POST", r.appointmentWalkIn(), b),
      update: (appointmentId: string, b: UpdateAppointmentRequest) =>
        send<AppointmentResponse>("PATCH", r.appointment(appointmentId), b),
      transition: (appointmentId: string, b: AppointmentTransitionRequest) =>
        send<AppointmentResponse>("POST", r.appointmentStatus(appointmentId), b),
      cancel: (appointmentId: string, reason: string) =>
        send<AppointmentResponse>("POST", r.appointmentCancel(appointmentId), { reason }),
      reschedule: (appointmentId: string, b: RescheduleAppointmentRequest) =>
        send<AppointmentResponse>("POST", r.appointmentReschedule(appointmentId), b),
    },
    frontDesk: {
      queue: (q: { branchId: string; date?: string }) =>
        get<CheckInQueueResponse>(r.frontDeskQueue(), q, checkInQueueResponse),
    },
    /**
     * Same endpoints as the shared api.dentists / api.staff, routed through this client so the
     * scheduling mock can enforce their staff:read gate (see scheduling-dentists.ts).
     */
    directory: {
      dentistAssignments: (q: { branchId?: string; status?: "current" | "all" }) =>
        get<Items<DentistAssignmentResponse>>(r.dentistAssignments(), q),
      staff: (q: { role?: string; branchId?: string } = {}) =>
        get<Items<StaffMemberResponse>>(r.staff(), q),
    },
    plans: {
      list: (q: { patientId: string; branchId?: string; limit?: number }) =>
        get<Page<TreatmentPlanSummary>>(r.plans(), { limit: 50, ...q }),
      get: (planId: string) => get<TreatmentPlanResponse>(r.plan(planId)),
    },
  };
}

export type SchedulingApi = ReturnType<typeof createSchedulingApi>;

/**
 * Same transport and switch as the shared client (NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_MOCK). In
 * mock mode scheduling paths are answered by ./scheduling-mock, which falls back to the shared M1
 * fixtures for everything else (patients, staff, branches). Loaded lazily so it never ships to prod.
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./scheduling-mock")).schedulingMockHandler(method, path, query, body);

export const schedulingClient: ApiClient = createClient({
  ...apiClient.config,
  mockHandler: MOCK_MODE ? lazyMock : undefined,
});

export const schedulingApi: SchedulingApi = createSchedulingApi(schedulingClient);
