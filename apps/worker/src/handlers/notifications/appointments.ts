import {
  NOTIFICATION_QUEUES,
  appointmentChangedJob,
  appointmentReminderJob,
  reminderSendTimes,
  reminderTemplateCode,
  z,
} from "@dentalos/validation";
import { fmtDate, fmtTime } from "./format";
import {
  dispatch,
  enqueueForPatient,
  loadBranch,
  loadPatientContact,
  loadSettings,
} from "./outbox";
import { type HandlerCtx, log, registerWork } from "./work";

const ACTIVE = ["BOOKED", "CONFIRMED"] as const;
const SCAN_LIMIT = 500;

/** Template code for a reminder offset (custom offsets reuse the nearest well-known template). */
const codeFor = (offsetMinutes: number) =>
  reminderTemplateCode(offsetMinutes) ??
  (offsetMinutes >= 720 ? "APPT_REMINDER_24H" : "APPT_REMINDER_2H");

export const reminderKey = (appointmentId: string, offsetMinutes: number) =>
  `appt-reminder:${appointmentId}:${offsetMinutes}`;

/** Payload of the periodic scan (no fields: the tenant is in the envelope). */
export const reminderScanJob = z.object({});
/** Own queue (not in NOTIFICATION_QUEUES): the periodic reminder scan, one job per tenant per tick. */
export const REMINDER_SCAN_QUEUE = "notifications.reminder-scan";

export async function registerAppointmentHandlers(ctx: HandlerCtx) {
  /**
   * Periodic scan (scheduling code is frozen, so reminders are discovered rather than scheduled at booking time):
   * finds BOOKED / CONFIRMED appointments starting within the largest reminder offset that have no reminder outbox
   * row yet and enqueues one delayed `appointment-reminder` job per remaining offset (`reminderSendTimes` drops offsets
   * already in the past). Re-running is harmless: the job key and the outbox key are both deterministic.
   * It also nudges QUEUED outbox rows that are overdue and probably lost their job (enqueue failed after commit).
   */
  await registerWork(ctx, REMINDER_SCAN_QUEUE, reminderScanJob, async (c) => {
    const now = new Date();
    const { settings, appts, have, overdue } = await c.tx(async (tx) => {
      const settings = await loadSettings(tx, c.env.tenantId);
      const maxOffset = Math.max(...settings.reminderOffsetsMinutes);
      const appts = await tx.appointment.findMany({
        where: {
          status: { in: [...ACTIVE] },
          startsAt: { gt: now, lte: new Date(now.getTime() + (maxOffset + 10) * 60_000) },
        },
        select: { id: true, startsAt: true },
        orderBy: { startsAt: "asc" },
        take: SCAN_LIMIT,
      });
      const keys = appts.flatMap((a) =>
        settings.reminderOffsetsMinutes.map((o) => reminderKey(a.id, o)),
      );
      const have = new Set(
        (
          await tx.notificationOutbox.findMany({
            where: { idempotencyKey: { in: keys } },
            select: { idempotencyKey: true },
          })
        ).map((r) => r.idempotencyKey),
      );
      const overdue = await tx.notificationOutbox.findMany({
        where: { status: "QUEUED", scheduledFor: { lt: new Date(now.getTime() - 5 * 60_000) } },
        select: { id: true, status: true, scheduledFor: true, nextAttemptAt: true },
        take: 200,
      });
      return { settings, appts, have, overdue };
    });
    let queued = 0;
    for (const a of appts) {
      for (const r of reminderSendTimes(a.startsAt, settings.reminderOffsetsMinutes, now)) {
        if (have.has(reminderKey(a.id, r.offsetMinutes))) continue;
        const id = await c.send(
          NOTIFICATION_QUEUES.APPOINTMENT_REMINDER,
          { appointmentId: a.id, offsetMinutes: r.offsetMinutes },
          {
            idempotencyKey: reminderKey(a.id, r.offsetMinutes),
            startAfter: r.sendAt,
            source: "appointment.reminder.scan",
          },
        );
        if (id) queued++;
      }
    }
    let rescued = 0;
    for (const row of overdue) {
      const due =
        row.nextAttemptAt && row.nextAttemptAt > row.scheduledFor
          ? row.nextAttemptAt
          : row.scheduledFor;
      if (due.getTime() > now.getTime() - 5 * 60_000) continue; // a retry is still waiting for its time
      if (
        await c.send(
          NOTIFICATION_QUEUES.SEND,
          { outboxId: row.id },
          { idempotencyKey: `send:${row.id}:rescue:${Math.floor(now.getTime() / 600_000)}` },
        )
      )
        rescued++;
    }
    if (queued > 0 || rescued > 0)
      log("info", "reminder scan", {
        tenantId: c.env.tenantId,
        scanned: appts.length,
        queued,
        rescued,
      });
  });

  /**
   * `notifications.appointment-reminder`: runs at T-offset, RE-READS the appointment and writes nothing when it is no
   * longer active, has started, or moved to a later time (the scan will schedule the new time). Otherwise it creates the
   * reminder outbox row (first consented channel in `reminderChannelOrder`) and enqueues its send job.
   */
  await registerWork(
    ctx,
    NOTIFICATION_QUEUES.APPOINTMENT_REMINDER,
    appointmentReminderJob,
    async (c) => {
      const { appointmentId, offsetMinutes } = c.env.data;
      const now = new Date();
      const row = await c.tx(async (tx) => {
        const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
        if (!a || !(ACTIVE as readonly string[]).includes(a.status)) return null;
        if (a.startsAt <= now) return null;
        const sendAt = a.startsAt.getTime() - offsetMinutes * 60_000;
        if (sendAt > now.getTime() + 60_000) return null; // start moved later
        const [patient, branch, settings] = await Promise.all([
          loadPatientContact(tx, a.patientId),
          loadBranch(tx, a.branchId),
          loadSettings(tx, c.env.tenantId),
        ]);
        if (!patient || !branch) return null;
        const dentist = a.dentistUserId
          ? await tx.membership.findUnique({
              where: { tenantId_userId: { tenantId: c.env.tenantId, userId: a.dentistUserId } },
              select: { displayName: true },
            })
          : null;
        const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
          patient,
          actorId: c.env.actorId,
          branchId: a.branchId,
          templateCode: codeFor(offsetMinutes),
          idempotencyKey: reminderKey(a.id, offsetMinutes),
          source: `appointment.reminder.${offsetMinutes === 1440 ? "24h" : offsetMinutes === 120 ? "2h" : `${offsetMinutes}m`}`,
          refType: "appointment",
          refId: a.id,
          variables: {
            patientName: patient.displayName,
            appointmentDate: fmtDate(a.startsAt, branch.timeZone),
            appointmentTime: fmtTime(a.startsAt, branch.timeZone),
            branchName: branch.name,
            branchPhone: branch.phone,
            dentistName: dentist?.displayName ?? "your dentist",
          },
        });
        if (!r.ok) {
          log("warn", "reminder not created", { appointmentId, offsetMinutes, reason: r.reason });
          return null;
        }
        return r.created ? r.row : null;
      });
      if (row) await dispatch(c, row);
    },
  );

  /**
   * `notifications.appointment-changed`: confirmation / change notice (booked, confirmed, cancelled, rescheduled).
   * The wording of `changeSummary` is generic (no clinical content).
   */
  await registerWork(
    ctx,
    NOTIFICATION_QUEUES.APPOINTMENT_CHANGED,
    appointmentChangedJob,
    async (c) => {
      const { appointmentId, change } = c.env.data;
      const row = await c.tx(async (tx) => {
        const a = await tx.appointment.findUnique({ where: { id: appointmentId } });
        if (!a) return null;
        const [patient, branch, settings] = await Promise.all([
          loadPatientContact(tx, a.patientId),
          loadBranch(tx, a.branchId),
          loadSettings(tx, c.env.tenantId),
        ]);
        if (!patient || !branch) return null;
        const confirmation = change === "BOOKED" || change === "CONFIRMED";
        const dentist = a.dentistUserId
          ? await tx.membership.findUnique({
              where: { tenantId_userId: { tenantId: c.env.tenantId, userId: a.dentistUserId } },
              select: { displayName: true },
            })
          : null;
        const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
          patient,
          actorId: c.env.actorId,
          branchId: a.branchId,
          templateCode: confirmation ? "APPT_CONFIRMATION" : "APPT_CHANGED",
          idempotencyKey: `appt-changed:${a.id}:${change}`,
          source: `appointment.${change.toLowerCase()}`,
          refType: "appointment",
          refId: a.id,
          variables: {
            patientName: patient.displayName,
            appointmentDate: fmtDate(a.startsAt, branch.timeZone),
            appointmentTime: fmtTime(a.startsAt, branch.timeZone),
            branchName: branch.name,
            branchPhone: branch.phone,
            dentistName: dentist?.displayName ?? "your dentist",
            changeSummary: change === "CANCELLED" ? "cancelled" : "rescheduled",
          },
        });
        if (!r.ok) {
          log("warn", "appointment notice not created", {
            appointmentId,
            change,
            reason: r.reason,
          });
          return null;
        }
        return r.created ? r.row : null;
      });
      if (row) await dispatch(c, row);
    },
  );
}
