import { Prisma } from "@dentalos/db";
import { NOTIFICATION_QUEUES, addDays, recallDueOn, recallSweepJob } from "@dentalos/validation";
import { dayIn, fmtDate } from "./format";
import {
  dispatch,
  enqueueForPatient,
  loadBranch,
  loadPatientContact,
  loadSettings,
} from "./outbox";
import { type HandlerCtx, log, registerWork } from "./work";

const ACTIVE_APPT = ["BOOKED", "CONFIRMED", "CHECKED_IN", "IN_CHAIR"] as const;
const PER_SETTING_LIMIT = 500;

interface LastCompleted {
  patientId: string;
  branchId: string;
  performedAt: Date;
}

/**
 * `notifications.recall-sweep` (ADR 0004 §9.4): for every active `RecallSetting` find patients whose LAST COMPLETED
 * procedure of that service plus `intervalDays` is due within `recallLeadDays`, who have no upcoming appointment and
 * (outbox key `recall:<patient>:<service>:<due date>`) no recall for that due date yet. One RECALL_REMINDER per
 * (patient, service, due date); consent / channel choice follow the same rules as every other message. The sweep is
 * safe to re-run any number of times. `asOf` ("YYYY-MM-DD") overrides today (probes / back-fills).
 */
export async function registerRecallHandler(ctx: HandlerCtx) {
  await registerWork(ctx, NOTIFICATION_QUEUES.RECALL_SWEEP, recallSweepJob, async (c) => {
    const now = new Date();
    const created = await c.tx(async (tx) => {
      const settings = await loadSettings(tx, c.env.tenantId);
      const recalls = await tx.recallSetting.findMany({
        where: { active: true },
        include: { service: { select: { name: true, active: true } } },
      });
      const out: Array<{ id: string; status: "QUEUED"; scheduledFor: Date }> = [];
      const branches = new Map<string, Awaited<ReturnType<typeof loadBranch>>>();
      for (const rs of recalls) {
        const lead = settings.recallLeadDays;
        // Loose SQL pre-filter (one day of slack); the exact per-branch calendar maths follow in JS.
        const cutoff = new Date(
          now.getTime() - Math.max(0, rs.intervalDays - lead - 1) * 86_400_000,
        );
        const last = await tx.$queryRaw<LastCompleted[]>(Prisma.sql`
          SELECT x."patientId", x."branchId", x."performedAt" FROM (
            SELECT DISTINCT ON (pr."patientId") pr."patientId", e."branchId", pr."performedAt"
            FROM "ProcedureRecord" pr
            JOIN "Encounter" e ON e."tenantId" = pr."tenantId" AND e."id" = pr."encounterId"
            WHERE pr."serviceId" = ${rs.serviceId}::uuid AND pr."status" = 'COMPLETED'
            ORDER BY pr."patientId", pr."performedAt" DESC
          ) x
          WHERE x."performedAt" <= ${cutoff}
          LIMIT ${PER_SETTING_LIMIT}`);
        if (last.length === 0) continue;

        const upcoming = new Set(
          (
            await tx.appointment.findMany({
              where: {
                patientId: { in: last.map((l) => l.patientId) },
                startsAt: { gt: now },
                status: { in: [...ACTIVE_APPT] },
              },
              select: { patientId: true },
            })
          ).map((a) => a.patientId),
        );
        for (const l of last) {
          if (upcoming.has(l.patientId)) continue;
          if (!branches.has(l.branchId)) branches.set(l.branchId, await loadBranch(tx, l.branchId));
          const branch = branches.get(l.branchId);
          if (!branch) continue;
          const today = c.env.data.asOf ?? dayIn(now, branch.timeZone);
          const due = recallDueOn(dayIn(l.performedAt, branch.timeZone), rs.intervalDays);
          if (today < addDays(due, -lead)) continue; // not yet in the lead window
          const patient = await loadPatientContact(tx, l.patientId);
          if (!patient) continue;
          const r = await enqueueForPatient(tx, c.env.tenantId, settings, {
            patient,
            actorId: c.env.actorId,
            branchId: branch.id,
            templateCode: "RECALL_REMINDER",
            idempotencyKey: `recall:${l.patientId}:${rs.serviceId}:${due}`,
            source: "recall.sweep",
            refType: "recall_setting",
            refId: rs.id,
            variables: {
              patientName: patient.displayName,
              serviceName: rs.service.name,
              dueDate: fmtDate(new Date(`${due}T00:00:00Z`), "UTC"),
              branchName: branch.name,
              branchPhone: branch.phone,
            },
          });
          if (r.ok && r.created && r.row.status === "QUEUED")
            out.push({ id: r.row.id, status: "QUEUED", scheduledFor: r.row.scheduledFor });
        }
      }
      return out;
    });
    for (const row of created) await dispatch(c, row);
    log("info", "recall sweep", { tenantId: c.env.tenantId, queued: created.length });
  });
}
