import { type Patient, Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  MERGEABLE_FIELDS,
  type MergePatientsRequest,
  type MergePreviewQuery,
  type MergeRecordResponse,
  type MergeableField,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { EventBus } from "../realtime/event-bus";
import { orderPair } from "./duplicate-scoring";
import { dateOnly, findPatientOr404, resolveSurvivorId, toResponse } from "./patient-common";

const fieldValue = (p: Patient, f: MergeableField): string | null => {
  if (f === "dob") return dateOnly(p.dob);
  return (p[f] as string | null) ?? null;
};

const NAME_OR_CONTACT: readonly MergeableField[] = [
  "firstName",
  "middleName",
  "lastName",
  "phone",
  "email",
];

/**
 * Filters for the re-pointable rows. Plans, encounters and other clinical rows are never re-pointed
 * (ADR 0003 §2.1); rows patient-bound to them by composite FK (plan-version consents,
 * encounter-attached documents) stay on the merged id too and are read through the lineage.
 */
const MOVABLE_CONSENT = { planVersionId: null };
const MOVABLE_DOCUMENT = { encounterId: null };

/**
 * Controlled merge (PRD 4.2: never automatic, authorised, auditable). Requires patient:merge.
 * Approval: the schema's `approvedBy` is optional, so M1 records the performer only (single-step,
 * permission-gated, step-up re-auth, audited). A four-eyes request/approve flow can fill approvedBy later.
 */
@Injectable()
export class MergeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  private async counts(tx: Tx, mergedId: string) {
    const where = { patientId: mergedId };
    const [allergies, alerts, consents, communicationPreferences, documents, histories] =
      await Promise.all([
        tx.patientAllergy.count({ where }),
        tx.patientAlert.count({ where }),
        tx.patientConsent.count({ where: { ...where, ...MOVABLE_CONSENT } }),
        tx.communicationPreference.count({ where }),
        tx.patientDocument.count({ where: { ...where, ...MOVABLE_DOCUMENT } }),
        tx.patientMedicalHistory.count({ where }),
      ]);
    const enquiries = await tx.patientEnquiry.count({ where: { convertedPatientId: mergedId } });
    const duplicateCandidates = await tx.duplicateCandidate.count({
      where: { OR: [{ patientAId: mergedId }, { patientBId: mergedId }] },
    });
    return {
      allergies,
      alerts,
      consents,
      communicationPreferences,
      documents,
      enquiries,
      duplicateCandidates,
      /** Stay on the merged id (append-only); shown through the survivor after merge. */
      medicalHistoryVersions: histories,
    };
  }

  async preview(p: Principal, q: MergePreviewQuery) {
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const survivor = await findPatientOr404(tx, q.survivorId);
      const merged = await findPatientOr404(tx, q.mergedId);
      const blockers: string[] = [];
      if (survivor.mergedIntoId) blockers.push("survivor_already_merged");
      if (merged.mergedIntoId) blockers.push("already_merged");
      const conflicts = MERGEABLE_FIELDS.flatMap((field) => {
        const s = fieldValue(survivor, field);
        const m = fieldValue(merged, field);
        return m !== null && m !== s ? [{ field, survivor: s, merged: m }] : [];
      });
      const [a, b] = orderPair(survivor.id, merged.id);
      const candidate = await tx.duplicateCandidate.findUnique({
        where: {
          tenantId_patientAId_patientBId: { tenantId: p.tenantId, patientAId: a, patientBId: b },
        },
      });
      return {
        survivor: toResponse(survivor),
        merged: toResponse(merged),
        conflicts,
        counts: await this.counts(tx, merged.id),
        blockers,
        duplicateCandidate: candidate
          ? { id: candidate.id, status: candidate.status, score: candidate.score }
          : null,
      };
    });
  }

  async execute(p: Principal, body: MergePatientsRequest) {
    const result = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        // Lock both rows in a fixed order: concurrent merges of overlapping pairs serialise, no deadlock.
        const [lo, hi] = orderPair(body.survivorId, body.mergedId);
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "Patient" WHERE id IN (${lo}::uuid, ${hi}::uuid) ORDER BY id FOR UPDATE`,
        );
        // RLS: a foreign-tenant id is simply not found.
        const survivor = await findPatientOr404(tx, body.survivorId);
        const merged = await findPatientOr404(tx, body.mergedId);
        if (survivor.mergedIntoId)
          throw new ConflictException({
            error: "survivor_already_merged",
            survivorId: await resolveSurvivorId(tx, survivor),
          });
        if (merged.mergedIntoId)
          throw new ConflictException({
            error: "already_merged",
            survivorId: await resolveSurvivorId(tx, merged),
          });

        const pairWhere = {
          tenantId_patientAId_patientBId: { tenantId: p.tenantId, patientAId: lo, patientBId: hi },
        };
        let candidate = await tx.duplicateCandidate.findUnique({ where: pairWhere });
        if (body.duplicateCandidateId) {
          if (!candidate || candidate.id !== body.duplicateCandidateId) {
            const exists = await tx.duplicateCandidate.findUnique({
              where: { id: body.duplicateCandidateId },
            });
            if (!exists) throw new NotFoundException({ error: "duplicate_candidate_not_found" });
            throw new BadRequestException({ error: "duplicate_candidate_mismatch" });
          }
          if (candidate.status !== "PENDING")
            throw new ConflictException({ error: "already_reviewed", status: candidate.status });
        }
        if (candidate && candidate.status !== "PENDING") candidate = null;

        // Snapshot before anything moves (the record is append-only; this is the undo map).
        const ids = async <T extends { id: string }>(rows: Promise<T[]>) =>
          (await rows).map((r) => r.id);
        const sel = { select: { id: true }, where: { patientId: merged.id } };
        const moved = {
          allergies: await ids(tx.patientAllergy.findMany(sel)),
          alerts: await ids(tx.patientAlert.findMany(sel)),
          consents: await ids(
            tx.patientConsent.findMany({ ...sel, where: { ...sel.where, ...MOVABLE_CONSENT } }),
          ),
          documents: await ids(
            tx.patientDocument.findMany({
              ...sel,
              where: { ...sel.where, ...MOVABLE_DOCUMENT },
            }),
          ),
          enquiries: await ids(
            tx.patientEnquiry.findMany({
              select: { id: true },
              where: { convertedPatientId: merged.id },
            }),
          ),
          medicalHistoryRetained: await ids(tx.patientMedicalHistory.findMany(sel)),
          communicationPreferences: { moved: [] as string[], collapsed: [] as string[] },
          duplicateCandidates: { repointed: [] as string[], closed: [] as string[] },
        };

        // Re-point mutable children. Medical history is append-only and stays on the merged id.
        const to = { patientId: survivor.id };
        await tx.patientAllergy.updateMany({ where: { patientId: merged.id }, data: to });
        await tx.patientAlert.updateMany({ where: { patientId: merged.id }, data: to });
        // Consents bound to a plan version and documents attached to an encounter are patient-bound
        // by composite FKs to clinical rows that stay on the merged id: they stay with them.
        await tx.patientConsent.updateMany({
          where: { patientId: merged.id, ...MOVABLE_CONSENT },
          data: to,
        });
        await tx.patientDocument.updateMany({
          where: { patientId: merged.id, ...MOVABLE_DOCUMENT },
          data: to,
        });
        await tx.patientEnquiry.updateMany({
          where: { convertedPatientId: merged.id },
          data: { convertedPatientId: survivor.id },
        });

        // Communication preferences are unique per (patient, channel, purpose): the most recently
        // updated preference wins (latest expressed wish), the losing duplicate row is removed.
        const survivorPrefs = await tx.communicationPreference.findMany({
          where: { patientId: survivor.id },
        });
        for (const mp of await tx.communicationPreference.findMany({
          where: { patientId: merged.id },
        })) {
          const sp = survivorPrefs.find(
            (s) => s.channel === mp.channel && s.purpose === mp.purpose,
          );
          if (!sp) {
            await tx.communicationPreference.update({ where: { id: mp.id }, data: to });
            moved.communicationPreferences.moved.push(mp.id);
            continue;
          }
          if (mp.updatedAt > sp.updatedAt && mp.optIn !== sp.optIn)
            await tx.communicationPreference.update({
              where: { id: sp.id },
              data: { optIn: mp.optIn, updatedBy: p.userId },
            });
          await tx.communicationPreference.delete({ where: { id: mp.id } });
          moved.communicationPreferences.collapsed.push(mp.id);
        }

        // Other duplicate pairs involving the merged patient now concern the survivor.
        const now = new Date();
        const others = await tx.duplicateCandidate.findMany({
          where: {
            OR: [{ patientAId: merged.id }, { patientBId: merged.id }],
            NOT: { patientAId: lo, patientBId: hi },
          },
        });
        for (const c of others) {
          const other = c.patientAId === merged.id ? c.patientBId : c.patientAId;
          const [na, nb] = orderPair(survivor.id, other);
          const clash = await tx.duplicateCandidate.findUnique({
            where: {
              tenantId_patientAId_patientBId: {
                tenantId: p.tenantId,
                patientAId: na,
                patientBId: nb,
              },
            },
          });
          if (clash) {
            if (c.status === "PENDING") {
              await tx.duplicateCandidate.update({
                where: { id: c.id },
                data: {
                  status: "MERGED",
                  reviewedBy: p.userId,
                  reviewedAt: now,
                  reviewReason: `superseded by merge into ${survivor.id}`,
                },
              });
              moved.duplicateCandidates.closed.push(c.id);
            }
          } else {
            await tx.duplicateCandidate.update({
              where: { id: c.id },
              data: { patientAId: na, patientBId: nb },
            });
            moved.duplicateCandidates.repointed.push(c.id);
          }
        }

        // Field choices: copy the chosen values from the merged record onto the survivor.
        const fieldChoices = body.fieldChoices ?? {};
        const taken = MERGEABLE_FIELDS.filter((f) => fieldChoices[f] === "merged");
        const data: Prisma.PatientUncheckedUpdateInput = {};
        for (const f of taken) {
          if (f === "dob") data.dob = merged.dob;
          else if (f === "sex") data.sex = merged.sex;
          else if (f === "firstName") data.firstName = merged.firstName;
          else if (f === "country") data.country = merged.country;
          else (data as Record<string, unknown>)[f] = merged[f];
        }
        if (taken.some((f) => NAME_OR_CONTACT.includes(f))) {
          const pick = <K extends MergeableField>(k: K) =>
            (taken.includes(k) ? merged : survivor)[k as keyof Patient] as string | null;
          data.nameNormalized = normalizeName(
            pick("firstName"),
            pick("middleName"),
            pick("lastName"),
          );
          data.phoneNormalized = normalizePhoneIN(pick("phone"));
          data.emailNormalized = normalizeEmail(pick("email"));
        }
        const updatedSurvivor = taken.length
          ? await tx.patient.update({ where: { id: survivor.id }, data })
          : survivor;
        await tx.patient.update({
          where: { id: merged.id },
          data: { mergedIntoId: survivor.id, mergedAt: now },
        });

        const snapshot = JSON.parse(
          JSON.stringify({
            survivorBefore: toResponse(survivor),
            merged: toResponse(merged),
            fieldChoices,
            fieldsTakenFromMerged: taken,
            moved,
          }),
        ) as Prisma.InputJsonValue;
        const record = await tx.patientMergeRecord.create({
          data: {
            tenantId: p.tenantId,
            survivorId: survivor.id,
            mergedId: merged.id,
            duplicateCandidateId: candidate?.id,
            performedBy: p.userId,
            approvedBy: null,
            reason: body.reason,
            snapshot,
          },
        });
        if (candidate)
          await tx.duplicateCandidate.update({
            where: { id: candidate.id },
            data: {
              status: "MERGED",
              reviewedBy: p.userId,
              reviewedAt: now,
              reviewReason: body.reason,
            },
          });
        return { record, survivor: updatedSurvivor, moved };
      },
      { actorId: p.userId },
    );

    await this.audit.record(p, {
      action: "patient.merge",
      resource: "patient_merge",
      resourceId: result.record.id,
      outcome: "success",
    });
    this.bus.publish({
      tenantId: p.tenantId,
      type: "patient.merged",
      data: { survivorId: result.record.survivorId, mergedId: result.record.mergedId },
    });
    return {
      mergeRecord: toMergeRecord(result.record),
      survivor: toResponse(result.survivor),
      repointed: {
        allergies: result.moved.allergies.length,
        alerts: result.moved.alerts.length,
        consents: result.moved.consents.length,
        documents: result.moved.documents.length,
        enquiries: result.moved.enquiries.length,
        communicationPreferences:
          result.moved.communicationPreferences.moved.length +
          result.moved.communicationPreferences.collapsed.length,
        duplicateCandidates:
          result.moved.duplicateCandidates.repointed.length +
          result.moved.duplicateCandidates.closed.length,
      },
    };
  }

  /** Merge history where the patient was survivor or merged (newest first). */
  async history(p: Principal, patientId: string) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      return tx.patientMergeRecord.findMany({
        where: { OR: [{ survivorId: patientId }, { mergedId: patientId }] },
        orderBy: { createdAt: "desc" },
      });
    });
    return { items: rows.map(toMergeRecord) };
  }
}

const toMergeRecord = (r: {
  id: string;
  survivorId: string;
  mergedId: string;
  performedBy: string;
  approvedBy: string | null;
  reason: string;
  createdAt: Date;
}): MergeRecordResponse => ({
  id: r.id,
  survivorId: r.survivorId,
  mergedId: r.mergedId,
  performedBy: r.performedBy,
  approvedBy: r.approvedBy,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
});
