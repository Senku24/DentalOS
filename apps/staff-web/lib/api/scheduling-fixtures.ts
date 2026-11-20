import type {
  AppointmentEventResponse,
  AppointmentResponse,
  AppointmentStatus,
  BranchResponse,
  ChairResponse,
  PatientResponse,
  SchedulingSettings,
  TreatmentPlanResponse,
  WorkingHoursResponse,
} from "@dentalos/validation";
import { branches, fid, patients, services, toPatientSummary } from "./fixtures";
import { effectiveHours } from "./scheduling-hours";
import { addDays, todayIn, weekdayOf, zonedIso } from "./scheduling-time";

/**
 * Synthetic scheduling data for mock mode, generated RELATIVE TO `now` so the calendar and the
 * front-desk queue always look like a working day: past visits completed (a few no-shows and
 * cancellations), a visit in the chair, patients waiting, the rest of the week booked. Built from the
 * shared M1 fixtures (branches, patients, dentist assignments) — no real people.
 */

const TZ = "Asia/Kolkata";
const [B1, B2, B3] = [fid("0b", 1), fid("0b", 2), fid("0b", 3)];
const ACTORS = ["usr-recep-1", "usr-recep-2", "dev-user"] as const;

/** Dentists with a current assignment per branch (mirrors fixtures.assignments). */
export const BRANCH_DENTISTS: Record<string, string[]> = {
  [B1]: ["usr-owner-1", "usr-dent-1"],
  [B2]: ["usr-dent-2"],
  [B3]: ["usr-dent-3"],
};

// ---------------------------------------------------------------------------------------------

export interface SchedulingFixtures {
  chairs: ChairResponse[];
  hours: WorkingHoursResponse[];
  settings: Record<string, SchedulingSettings>;
  appointments: AppointmentResponse[];
  events: AppointmentEventResponse[];
  plans: TreatmentPlanResponse[];
}

/** Small deterministic PRNG (mulberry32) so fixtures are stable for a given day. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chair = (n: number, branchId: string, code: string, name: string, active = true) => ({
  id: fid("31", n),
  branchId,
  code,
  name,
  active,
  createdAt: "2026-07-01T04:30:00.000Z",
});

export function buildSchedulingFixtures(now: Date = new Date()): SchedulingFixtures {
  const today = todayIn(TZ, now);
  const rand = rng(Number(today.replace(/-/g, "")));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  let seq = 0;
  const nextId = (kind: string) => fid(kind, ++seq);

  const chairs: ChairResponse[] = [
    chair(1, B1, "OP1", "Operatory 1"),
    chair(2, B1, "OP2", "Operatory 2"),
    chair(3, B1, "HYG", "Hygiene bay"),
    chair(4, B2, "OP1", "Operatory 1"),
    chair(5, B2, "OP2", "Operatory 2"),
    chair(6, B3, "OP1", "Operatory 1"),
    chair(7, B3, "OP2", "Operatory 2 (under repair)", false),
  ];

  // ---- Working hours: B1 has explicit rows (with a change scheduled), the others use M1 JSON ----
  const hours: WorkingHoursResponse[] = [];
  const row = (
    o: Pick<WorkingHoursResponse, "scope" | "branchId" | "weekday" | "startMinute" | "endMinute"> &
      Partial<WorkingHoursResponse>,
  ): WorkingHoursResponse => ({
    id: fid("32", hours.length + 1),
    userId: null,
    chairId: null,
    effectiveFrom: addDays(today, -60),
    effectiveTo: null,
    createdBy: "usr-owner-1",
    createdAt: "2026-09-20T04:30:00.000Z",
    ...o,
  });
  const nextMonday = addDays(today, (8 - weekdayOf(today)) % 7 || 7);
  // A PUT replaces the whole week, so the weekday rows are closed and re-inserted too.
  for (const period of [
    { effectiveTo: nextMonday },
    { effectiveFrom: nextMonday, createdAt: now.toISOString() },
  ])
    for (const wd of [1, 2, 3, 4, 5]) {
      hours.push(
        row({
          scope: "BRANCH",
          branchId: B1,
          weekday: wd,
          startMinute: 570,
          endMinute: 810,
          ...period,
        }),
      );
      hours.push(
        row({
          scope: "BRANCH",
          branchId: B1,
          weekday: wd,
          startMinute: 990,
          endMinute: 1230,
          ...period,
        }),
      );
    }
  // Saturday: 10:00–16:00 until next Monday, then 10:00–18:00 (effective-dated change).
  hours.push(
    row({
      scope: "BRANCH",
      branchId: B1,
      weekday: 6,
      startMinute: 600,
      endMinute: 960,
      effectiveTo: nextMonday,
    }),
  );
  hours.push(
    row({
      scope: "BRANCH",
      branchId: B1,
      weekday: 6,
      startMinute: 600,
      endMinute: 1080,
      effectiveFrom: nextMonday,
      createdAt: now.toISOString(),
    }),
  );
  // Dr. Neha Iyer: mornings Mon–Sat, evenings Mon/Wed/Fri only.
  for (const wd of [1, 2, 3, 4, 5, 6])
    hours.push(
      row({
        scope: "DENTIST",
        branchId: B1,
        userId: "usr-dent-1",
        weekday: wd,
        startMinute: wd === 6 ? 600 : 570,
        endMinute: wd === 6 ? 960 : 810,
        effectiveFrom: addDays(today, -40),
      }),
    );
  for (const wd of [1, 3, 5])
    hours.push(
      row({
        scope: "DENTIST",
        branchId: B1,
        userId: "usr-dent-1",
        weekday: wd,
        startMinute: 990,
        endMinute: 1230,
        effectiveFrom: addDays(today, -40),
      }),
    );
  // Hygiene bay: mornings only.
  for (const wd of [1, 2, 3, 4, 5, 6])
    hours.push(
      row({
        scope: "CHAIR",
        branchId: B1,
        chairId: fid("31", 3),
        weekday: wd,
        startMinute: wd === 6 ? 600 : 570,
        endMinute: 810,
      }),
    );

  const settings: Record<string, SchedulingSettings> = {
    [B1]: {
      noShowGraceMinutes: 15,
      slotMinutes: 15,
      allowUnassignedDentist: true,
      allowOutsideHoursBooking: true,
    },
    [B2]: {
      noShowGraceMinutes: 20,
      slotMinutes: 30,
      allowUnassignedDentist: true,
      allowOutsideHoursBooking: true,
    },
    [B3]: {
      noShowGraceMinutes: 15,
      slotMinutes: 15,
      allowUnassignedDentist: false,
      allowOutsideHoursBooking: false,
    },
  };

  // ---- Appointments ------------------------------------------------------------------------
  const pool = patients.filter((p) => !p.mergedIntoId);
  const byId = new Map(patients.map((p) => [p.id, p]));
  const appointments: AppointmentResponse[] = [];
  const events: AppointmentEventResponse[] = [];
  const nowMs = now.getTime();
  const ACTIVE: AppointmentStatus[] = ["BOOKED", "CONFIRMED", "CHECKED_IN", "IN_CHAIR"];

  const clashes = (c: {
    startsAt: string;
    endsAt: string;
    dentistUserId: string | null;
    chairId: string | null;
  }) =>
    appointments.some(
      (a) =>
        ACTIVE.includes(a.status) &&
        a.startsAt < c.endsAt &&
        a.endsAt > c.startsAt &&
        ((c.dentistUserId && a.dentistUserId === c.dentistUserId) ||
          (c.chairId && a.chairId === c.chairId)),
    );

  const ev = (
    a: AppointmentResponse,
    fromStatus: AppointmentStatus | null,
    toStatus: AppointmentStatus,
    at: string,
    actorId: string,
    reason: string | null = null,
  ) => {
    events.push({
      id: nextId("34"),
      appointmentId: a.id,
      fromStatus,
      toStatus,
      actorId,
      reason,
      at,
    });
  };

  const add = (o: {
    patient: PatientResponse;
    branchId: string;
    startsAt: string;
    durationMin: number;
    dentistUserId: string | null;
    chairId: string | null;
    appointmentType: string;
    status: AppointmentStatus;
    source?: AppointmentResponse["source"];
    checkedInAt?: string | null;
    cancelReason?: string | null;
    outsideHoursReason?: string | null;
    notes?: string | null;
    planItemId?: string | null;
    rescheduledFromId?: string | null;
  }): AppointmentResponse => {
    const startMs = Date.parse(o.startsAt);
    const createdMs =
      o.source && o.source !== "SCHEDULED"
        ? startMs - 5 * 60_000
        : startMs - (2 + Math.floor(rand() * 12)) * 86_400_000;
    const actor = pick(ACTORS);
    const a: AppointmentResponse = {
      id: nextId("33"),
      patientId: o.patient.id,
      branchId: o.branchId,
      dentistUserId: o.dentistUserId,
      chairId: o.chairId,
      appointmentType: o.appointmentType,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(startMs + o.durationMin * 60_000).toISOString(),
      status: o.status,
      source: o.source ?? "SCHEDULED",
      rescheduledFromId: o.rescheduledFromId ?? null,
      rescheduledToId: null,
      planItemId: o.planItemId ?? null,
      cancelReason: o.cancelReason ?? null,
      outsideHoursReason: o.outsideHoursReason ?? null,
      notes: o.notes ?? null,
      checkedInAt: o.checkedInAt ?? null,
      createdBy: actor,
      createdAt: new Date(Math.min(createdMs, nowMs)).toISOString(),
      updatedAt: new Date(Math.min(startMs, nowMs)).toISOString(),
      patient: toPatientSummary(o.patient),
    };
    appointments.push(a);
    // History: creation, then the path to the final status.
    ev(a, null, "BOOKED", a.createdAt, actor, o.outsideHoursReason ?? null);
    const path: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
      CONFIRMED: ["CONFIRMED"],
      CHECKED_IN: ["CONFIRMED", "CHECKED_IN"],
      IN_CHAIR: ["CONFIRMED", "CHECKED_IN", "IN_CHAIR"],
      COMPLETED: ["CONFIRMED", "CHECKED_IN", "IN_CHAIR", "COMPLETED"],
      NO_SHOW: ["NO_SHOW"],
      CANCELLED: ["CANCELLED"],
      RESCHEDULED: ["RESCHEDULED"],
    };
    let from: AppointmentStatus = "BOOKED";
    for (const to of path[a.status] ?? []) {
      if (a.source !== "SCHEDULED" && to === "CONFIRMED") continue;
      const at =
        to === "CONFIRMED"
          ? new Date(Math.min(startMs - 86_400_000, nowMs)).toISOString()
          : to === "CHECKED_IN"
            ? (a.checkedInAt ?? new Date(Math.min(startMs - 600_000, nowMs)).toISOString())
            : to === "IN_CHAIR"
              ? new Date(Math.min(startMs + 300_000, nowMs)).toISOString()
              : to === "COMPLETED"
                ? a.endsAt
                : to === "NO_SHOW"
                  ? new Date(Math.min(startMs + 1_800_000, nowMs)).toISOString()
                  : new Date(Math.min(startMs - 2 * 86_400_000, nowMs)).toISOString();
      const who = to === "IN_CHAIR" || to === "COMPLETED" ? (a.dentistUserId ?? actor) : actor;
      ev(a, from, to, at, who, to === "CANCELLED" ? a.cancelReason : null);
      from = to;
    }
    return a;
  };

  const TYPES = ["CHECKUP", "TREATMENT", "FOLLOW_UP", "CONSULTATION", "HYGIENE", "REVIEW"] as const;
  const DURATIONS = [15, 30, 30, 30, 45, 60] as const;
  const CANCEL_REASONS = [
    "Patient travelling; will call back to rebook",
    "Patient unwell (fever)",
    "Clinic request: dentist on leave",
  ];
  let patientCursor = 0;
  const nextPatient = () => pool[patientCursor++ % pool.length] as PatientResponse;
  let leftUnmarked = false;
  let waitingMade = 0;

  for (const branchId of [B1, B2, B3]) {
    const branch = branches.find((b) => b.id === branchId);
    const density = branchId === B1 ? 0.62 : 0.36;
    const dentists = BRANCH_DENTISTS[branchId] ?? [];
    const branchChairs = chairs.filter(
      (c) => c.branchId === branchId && c.active && c.code !== "HYG",
    );
    for (let d = -10; d <= 21; d++) {
      const day = addDays(today, d);
      branchChairs.forEach((ch, i) => {
        const dentist = dentists[i] ?? null;
        const sessions = effectiveHours(hours, branch, day, {
          dentistUserId: dentist,
          chairId: ch.id,
        });
        for (const s of sessions) {
          let m = s.start;
          while (m < s.end) {
            const dur = pick(DURATIONS);
            if (m + dur > s.end) break;
            if (rand() < density) {
              const startsAt = zonedIso(day, m, TZ);
              const endsMs = Date.parse(startsAt) + dur * 60_000;
              const startMs = Date.parse(startsAt);
              let status: AppointmentStatus;
              let checkedInAt: string | null = null;
              let cancelReason: string | null = null;
              const r = rand();
              if (endsMs <= nowMs) {
                if (day === today && !leftUnmarked && startMs + 20 * 60_000 < nowMs) {
                  status = "CONFIRMED"; // never arrived: no-show eligible (front desk decides)
                  leftUnmarked = true;
                } else status = r < 0.82 ? "COMPLETED" : r < 0.91 ? "NO_SHOW" : "CANCELLED";
              } else if (startMs <= nowMs) {
                status = "IN_CHAIR";
                checkedInAt = new Date(startMs - 8 * 60_000).toISOString();
              } else if (day === today && startMs - nowMs <= 45 * 60_000 && waitingMade < 2) {
                status = "CHECKED_IN";
                waitingMade++;
                checkedInAt = new Date(nowMs - (6 + waitingMade * 7) * 60_000).toISOString();
              } else status = r < 0.4 ? "CONFIRMED" : r < 0.95 ? "BOOKED" : "CANCELLED";
              if (status === "CANCELLED") cancelReason = pick(CANCEL_REASONS);
              const cand = {
                startsAt,
                endsAt: new Date(endsMs).toISOString(),
                dentistUserId: dentist,
                chairId: ch.id,
              };
              if (!clashes(cand) || !ACTIVE.includes(status))
                add({
                  patient: nextPatient(),
                  branchId,
                  startsAt,
                  durationMin: dur,
                  dentistUserId: dentist,
                  chairId: ch.id,
                  appointmentType: pick(TYPES),
                  status,
                  checkedInAt,
                  cancelReason,
                });
            }
            m += dur + (rand() < 0.3 ? 15 : 0);
          }
        }
      });
    }
  }

  // ---- Walk-ins at the front desk right now (always present, even outside clinic hours) ----
  const p41 = byId.get(fid("01", 41)) as PatientResponse;
  const p44 = byId.get(fid("01", 44)) as PatientResponse;
  const p12 = byId.get(fid("01", 12)) as PatientResponse;
  const ago = (min: number) => new Date(nowMs - min * 60_000).toISOString();
  add({
    patient: p44,
    branchId: B1,
    startsAt: ago(4),
    durationMin: 30,
    dentistUserId: null,
    chairId: null,
    appointmentType: "EMERGENCY",
    status: "CHECKED_IN",
    source: "URGENT",
    checkedInAt: ago(4),
    notes: "Severe pain lower left since last night",
  });
  add({
    patient: p12,
    branchId: B1,
    startsAt: ago(18),
    durationMin: 30,
    dentistUserId: null,
    chairId: null,
    appointmentType: "CONSULTATION",
    status: "CHECKED_IN",
    source: "WALK_IN",
    checkedInAt: ago(18),
  });
  add({
    patient: byId.get(fid("01", 7)) as PatientResponse,
    branchId: B1,
    startsAt: ago(12),
    durationMin: 45,
    dentistUserId: null,
    chairId: fid("31", 3),
    appointmentType: "HYGIENE",
    status: "IN_CHAIR",
    source: "WALK_IN",
    checkedInAt: ago(25),
  });

  // ---- Plan for Rahul Sharma: one item already scheduled, one accepted and bookable ----
  const planId = fid("35", 1);
  const svc = (n: number) => services.find((s) => s.id === fid("05", n));
  const item = (
    n: number,
    serviceN: number,
    status: TreatmentPlanResponse["items"][number]["status"],
    toothCode: number | null,
    sequence: number,
  ) => ({
    id: fid("36", n),
    planId,
    phase: 1,
    sequence,
    serviceId: fid("05", serviceN),
    toothCode,
    surfaces: [],
    quantity: 1,
    estimatePricePaise: svc(serviceN)?.basePricePaise ?? 0,
    priceSource: "BASE" as const,
    pricedAt: ago(60 * 24 * 9),
    status,
    notes: null,
    decidedAt: status === "PROPOSED" ? null : ago(60 * 24 * 8),
    decidedBy: status === "PROPOSED" ? null : "usr-dent-1",
    decisionReason: null,
  });
  const planItems = [
    item(1, 9, "SCHEDULED", 36, 1),
    item(2, 10, "ACCEPTED", 36, 2),
    item(3, 4, "ACCEPTED", null, 3),
    item(4, 13, "PROPOSED", 48, 4),
  ];
  const total = (xs: typeof planItems) => xs.reduce((s, i) => s + i.estimatePricePaise, 0);
  const plans: TreatmentPlanResponse[] = [
    {
      id: planId,
      patientId: p41.id,
      branchId: B1,
      title: "Lower left molar rehabilitation",
      status: "PARTIALLY_ACCEPTED",
      currentVersion: 3,
      totals: {
        estimatePaise: total(planItems),
        acceptedPaise: total(planItems.filter((i) => i.status !== "PROPOSED")),
        completedPaise: 0,
        pendingPaise: total(planItems.filter((i) => i.status !== "PROPOSED")),
      },
      createdAt: ago(60 * 24 * 10),
      updatedAt: ago(60 * 24 * 8),
      encounterId: null,
      notes: null,
      presentedAt: ago(60 * 24 * 9),
      presentedBy: "usr-dent-1",
      approvedAt: null,
      approvedBy: null,
      cancelReason: null,
      createdBy: "usr-dent-1",
      items: planItems,
    },
  ];
  // RCT session booked for the day after tomorrow, 10:00 with Dr. Neha Iyer in OP2.
  const rctDay = addDays(today, weekdayOf(addDays(today, 2)) === 0 ? 3 : 2);
  const rct = {
    startsAt: zonedIso(rctDay, 600, TZ),
    endsAt: zonedIso(rctDay, 690, TZ),
    dentistUserId: "usr-dent-1",
    chairId: fid("31", 2),
  };
  for (const a of appointments)
    if (ACTIVE.includes(a.status) && a.startsAt < rct.endsAt && a.endsAt > rct.startsAt)
      if (a.dentistUserId === rct.dentistUserId || a.chairId === rct.chairId) {
        a.status = "CANCELLED";
        a.cancelReason = "Clinic request: slot needed for root canal session";
        ev(a, "BOOKED", "CANCELLED", ago(60 * 24 * 7), "usr-recep-1", a.cancelReason);
      }
  add({
    patient: p41,
    branchId: B1,
    startsAt: rct.startsAt,
    durationMin: 90,
    dentistUserId: rct.dentistUserId,
    chairId: rct.chairId,
    appointmentType: "TREATMENT",
    status: "CONFIRMED",
    planItemId: fid("36", 1),
    notes: "RCT 36, session 1 of 2",
  });

  // ---- A reschedule pair and an approved outside-hours booking (tomorrow / later) ----
  const firstFuture = appointments.find(
    (a) =>
      a.branchId === B1 &&
      a.status === "BOOKED" &&
      a.source === "SCHEDULED" &&
      a.startsAt > ago(-60 * 24),
  );
  if (firstFuture) {
    const startDay = addDays(todayIn(TZ, new Date(firstFuture.startsAt)), 7);
    const durationMin = Math.round(
      (Date.parse(firstFuture.endsAt) - Date.parse(firstFuture.startsAt)) / 60_000,
    );
    for (const minute of [1170, 1200, 1215]) {
      const startsAt = zonedIso(startDay, minute, TZ);
      const cand = {
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + durationMin * 60_000).toISOString(),
        dentistUserId: firstFuture.dentistUserId,
        chairId: null,
      };
      if (clashes(cand)) continue;
      firstFuture.status = "RESCHEDULED";
      ev(
        firstFuture,
        "BOOKED",
        "RESCHEDULED",
        ago(60 * 3),
        "usr-recep-1",
        "Patient asked for a later week",
      );
      const next = add({
        patient: byId.get(firstFuture.patientId) as PatientResponse,
        branchId: B1,
        startsAt,
        durationMin,
        dentistUserId: firstFuture.dentistUserId,
        chairId: null,
        appointmentType: firstFuture.appointmentType,
        status: "BOOKED",
        rescheduledFromId: firstFuture.id,
      });
      firstFuture.rescheduledToId = next.id;
      break;
    }
  }
  const lateDay = addDays(today, weekdayOf(addDays(today, 1)) === 0 ? 2 : 1);
  const late = {
    startsAt: zonedIso(lateDay, 1245, TZ),
    endsAt: zonedIso(lateDay, 1275, TZ),
    dentistUserId: "usr-owner-1",
    chairId: fid("31", 1),
  };
  if (!clashes(late))
    add({
      patient: byId.get(fid("01", 3)) as PatientResponse,
      branchId: B1,
      startsAt: late.startsAt,
      durationMin: 30,
      dentistUserId: late.dentistUserId,
      chairId: late.chairId,
      appointmentType: "FOLLOW_UP",
      status: "BOOKED",
      outsideHoursReason: "Patient works night shifts; approved by Dr. Malhotra",
    });

  appointments.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { chairs, hours, settings, appointments, events, plans };
}
