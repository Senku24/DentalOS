import {
  type ClinicalNote,
  type ClinicalNoteAmendment,
  type Diagnosis,
  type Encounter,
  type PatientDocument,
  Prisma,
  type ProcedureRecord,
  type ProcedureStatus,
  type ToothRecord,
  type Tx,
} from "@dentalos/db";
import {
  type AmendmentResponse,
  type DiagnosisResponse,
  type EncounterResponse,
  type NoteResponse,
  type PlanItemStatus,
  type ProcedureResponse,
  type ToothRecordResponse,
  type ToothSurface,
  type TreatmentPlanStatus,
  areValidSurfaces,
  canTransitionPlanItem,
  derivePlanStatus,
  planItemTransitionPermissions,
  planTotals,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { type Permission, type Principal, branchFilter, can } from "../auth/roles";
import { clinicalGuardError, isUniqueViolation, notAMember } from "../common/db-errors";

// ---------------------------------------------------------------------------------------------
// Mappers (ids/status only ever leave through audit; bodies only through these responses)
// ---------------------------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const surfaces = (s: string[]) => s as ToothSurface[];

export const toEncounter = (e: Encounter): EncounterResponse => ({
  id: e.id,
  patientId: e.patientId,
  branchId: e.branchId,
  appointmentId: e.appointmentId,
  treatingDentistUserId: e.treatingDentistUserId,
  status: e.status,
  openedBy: e.openedBy,
  openedAt: e.openedAt.toISOString(),
  signedAt: iso(e.signedAt),
  signedBy: e.signedBy,
});

export const toAmendment = (a: ClinicalNoteAmendment): AmendmentResponse => ({
  id: a.id,
  encounterId: a.encounterId,
  noteId: a.noteId,
  body: a.body,
  reason: a.reason,
  authorId: a.authorId,
  createdAt: a.createdAt.toISOString(),
});

export const toNote = (n: ClinicalNote, amendments?: ClinicalNoteAmendment[]): NoteResponse => ({
  id: n.id,
  encounterId: n.encounterId,
  kind: n.kind,
  body: n.body,
  authorId: n.authorId,
  createdAt: n.createdAt.toISOString(),
  updatedAt: n.updatedAt.toISOString(),
  ...(amendments ? { amendments: amendments.map(toAmendment) } : {}),
});

export const toDiagnosis = (d: Diagnosis): DiagnosisResponse => ({
  id: d.id,
  encounterId: d.encounterId,
  patientId: d.patientId,
  code: d.code,
  label: d.label,
  toothCode: d.toothCode,
  surfaces: surfaces(d.surfaces),
  notes: d.notes,
  diagnosedBy: d.diagnosedBy,
  createdAt: d.createdAt.toISOString(),
});

export const toProcedure = (r: ProcedureRecord): ProcedureResponse => ({
  id: r.id,
  encounterId: r.encounterId,
  patientId: r.patientId,
  serviceId: r.serviceId,
  planItemId: r.planItemId,
  description: r.description,
  toothCode: r.toothCode,
  surfaces: surfaces(r.surfaces),
  status: r.status,
  notes: r.notes,
  performedBy: r.performedBy,
  performedAt: r.performedAt.toISOString(),
});

export const toTooth = (t: ToothRecord): ToothRecordResponse => ({
  id: t.id,
  patientId: t.patientId,
  encounterId: t.encounterId,
  toothCode: t.toothCode,
  dentition: t.dentition,
  condition: t.condition,
  surfaces: surfaces(t.surfaces),
  notes: t.notes,
  status: t.status,
  recordedBy: t.recordedBy,
  recordedAt: t.recordedAt.toISOString(),
  supersededAt: iso(t.supersededAt),
  supersededBy: t.supersededBy,
});

export const toDocument = (d: PatientDocument) => ({
  id: d.id,
  patientId: d.patientId,
  branchId: d.branchId,
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  category: d.category,
  description: d.description,
  status: d.status,
  uploadedBy: d.uploadedBy,
  createdAt: d.createdAt.toISOString(),
  encounterId: d.encounterId,
  deletedReason: d.deletedReason,
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** 409 encounter_signed — the service checks first; the DB trigger is the backstop. */
export const encounterSigned = () => new ConflictException({ error: "encounter_signed" });

/**
 * Maps DB-enforced rules to stable API errors: clinical triggers (409 / clinical_row_moved 400),
 * tenant_member_guard (400 not_a_member), composite FK (400 invalid_reference), unique (409).
 * HttpExceptions thrown by the service pass through unchanged.
 */
export function mapClinicalDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const g = clinicalGuardError(e);
  if (g === "clinical_row_moved") throw new BadRequestException({ error: g });
  if (g) throw new ConflictException({ error: g });
  const m = notAMember(e);
  if (m) throw new BadRequestException({ error: "not_a_member", field: m });
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
    throw new BadRequestException({ error: "invalid_reference" });
  if (isUniqueViolation(e)) throw new ConflictException({ error: "conflict" });
  throw e;
}

/** Runs `fn` and maps DB errors (see mapClinicalDbError). */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    mapClinicalDbError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Loaders / checks
// ---------------------------------------------------------------------------------------------

/** RLS hides other tenants' rows: a foreign id is indistinguishable from a missing one (404). */
export async function loadEncounter(tx: Tx, id: string): Promise<Encounter> {
  const e = await tx.encounter.findUnique({ where: { id } });
  if (!e) throw new NotFoundException({ error: "encounter_not_found" });
  return e;
}

export function assertOpen(e: Encounter): void {
  if (e.status !== "OPEN") throw encounterSigned();
}

/**
 * Takes a FOR SHARE lock on the encounter row so a concurrent sign (an UPDATE) waits for this
 * transaction, and this transaction's next read sees a sign that committed first. Used where no
 * DB trigger serialises against sign (PatientDocument.encounterId changes). A missing / foreign
 * row locks nothing; the following loadEncounter answers 404.
 */
export async function lockEncounter(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Encounter" WHERE "id" = ${id}::uuid FOR SHARE`;
}

/**
 * Authorship (ADR 0003 §2 proposal, flagged): a draft note / diagnosis / procedure keeps its
 * author, so only the author may edit it (403 not_author); the author or the current treating
 * dentist may delete it (deletion does not misattribute text).
 */
export function assertAuthor(p: Principal, authorId: string): void {
  if (authorId !== p.userId) throw new ForbiddenException({ error: "not_author" });
}

export function assertAuthorOrTreating(p: Principal, authorId: string, e: Encounter): void {
  if (authorId !== p.userId && e.treatingDentistUserId !== p.userId)
    throw new ForbiddenException({ error: "not_author" });
}

// ---------------------------------------------------------------------------------------------
// Odontogram scope (patient-level chart, branch-scoped encounter detail; flagged for the ADR)
// ---------------------------------------------------------------------------------------------

/**
 * The caller's clinical branch scope for patient-level odontogram access: `undefined` when
 * org-wide; 403 for a non-org-wide principal without any branch (the route-level @Can only
 * proves the role).
 */
export function odontogramScope(p: Principal): string[] | undefined {
  const ids = branchFilter(p);
  if (ids !== undefined && ids.length === 0) throw new ForbiddenException();
  return ids;
}

type ToothWithBranch = ToothRecord & { encounter: { branchId: string } | null };

/** Include fragment that lets `toVisibleTooth` see each row's encounter branch. */
export const TOOTH_ENCOUNTER_BRANCH = { encounter: { select: { branchId: true } } } as const;

/**
 * The tooth state is patient-level (every in-scope clinician sees every CURRENT condition, for
 * clinical safety), but a row charted inside an encounter outside the caller's scope is
 * redacted: no free-text notes and no encounterId (that encounter answers 403 anyway).
 */
export function toVisibleTooth(scope: string[] | undefined) {
  return (t: ToothWithBranch): ToothRecordResponse => {
    const { encounter, ...row } = t;
    if (scope === undefined || !encounter || scope.includes(encounter.branchId))
      return toTooth(row);
    return toTooth({ ...row, notes: null, encounterId: null });
  };
}

/** True when the principal holds any one of the permissions for the branch. */
export const canAny = (p: Principal, perms: readonly string[], branchId: string) =>
  perms.some((perm) => can(p, perm as Permission, { branchId }));

/**
 * Treating dentist (ADR 0003 §2, M2 conventions): a member of the tenant holding DENTIST whose
 * Principal holds clinical:sign at the branch (org-wide or the branch in Membership.branchScope).
 * It must match the clinical:* check every encounter action (sign included) makes, else the encounter could be
 * handed to a dentist who can neither read nor sign it. A DentistBranchAssignment alone does not
 * count (it is not part of the Principal; flagged for the Commander). The DB trigger only checks
 * membership, so this runs first for clear 400s.
 */
export async function assertTreatingDentist(
  tx: Tx,
  tenantId: string,
  userId: string,
  branchId: string,
): Promise<void> {
  const m = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  if (!m) throw new BadRequestException({ error: "not_a_member", field: "treatingDentistUserId" });
  if (!m.roles.includes("DENTIST"))
    throw new BadRequestException({ error: "not_a_dentist", field: "treatingDentistUserId" });
  // The same check sign() makes, on the Principal the auth guard would build for this member.
  const principal: Principal = {
    userId: m.userId,
    tenantId: m.tenantId,
    roles: m.roles,
    orgWide: m.orgWide,
    branchScope: m.branchScope,
  };
  if (!can(principal, "clinical:sign", { branchId }))
    throw new BadRequestException({
      error: "dentist_not_in_branch",
      field: "treatingDentistUserId",
    });
}

/** Merged tooth/surface pair of a PATCH must still be valid (the DB CHECK is the backstop). */
export function assertToothSurfaces(toothCode: number | null, s: readonly string[]): void {
  if (s.length === 0) return;
  if (toothCode === null || !areValidSurfaces(toothCode, s))
    throw new BadRequestException({
      error: "validation_failed",
      issues: [
        {
          path: "surfaces",
          message: toothCode === null ? "Surfaces require a tooth" : "Invalid surfaces for tooth",
        },
      ],
    });
}

// ---------------------------------------------------------------------------------------------
// Procedure records — local transition table (ADR 0003 does not define one; reported for the ADR)
// ---------------------------------------------------------------------------------------------

/** IN_PROGRESS -> COMPLETED | ABANDONED; COMPLETED and ABANDONED are terminal. */
export const PROCEDURE_TRANSITIONS: Readonly<Record<ProcedureStatus, readonly ProcedureStatus[]>> =
  {
    IN_PROGRESS: ["COMPLETED", "ABANDONED"],
    COMPLETED: [],
    ABANDONED: [],
  };
/** A procedure is recorded as started or done; "abandoned" only follows a started one. */
export const PROCEDURE_INITIAL_STATUSES: readonly ProcedureStatus[] = ["IN_PROGRESS", "COMPLETED"];

export function assertProcedureTransition(from: ProcedureStatus, to: ProcedureStatus): void {
  const allowed = PROCEDURE_TRANSITIONS[from];
  if (from === to || !allowed.includes(to))
    throw new ConflictException({ error: "invalid_transition", from, to, allowed: [...allowed] });
}

// ---------------------------------------------------------------------------------------------
// Plan item progress (cross-table write via Prisma + shared helpers; no import of plans/)
// ---------------------------------------------------------------------------------------------

const PLAN_ITEM_STARTABLE: readonly PlanItemStatus[] = ["ACCEPTED", "SCHEDULED"];
const FROZEN_PLAN_STATUSES: readonly TreatmentPlanStatus[] = ["COMPLETED", "CANCELLED"];

/** Item states a procedure may link to: work can still start on it, or already has. */
const PLAN_ITEM_LINKABLE: readonly PlanItemStatus[] = [...PLAN_ITEM_STARTABLE, "IN_PROGRESS"];

const invalidPlanItem = (reason: string) =>
  new BadRequestException({ error: "invalid_plan_item", field: "planItemId", reason });

/**
 * A procedure's planItemId must name an item of the encounter's patient, on a plan the caller
 * can read (plan:read at the plan's branch, which may differ from the encounter's), that is not
 * frozen, in a state work can be recorded against (ACCEPTED | SCHEDULED | IN_PROGRESS). Else 400
 * invalid_plan_item — the link cannot be corrected later (UpdateProcedureRequest has no
 * planItemId), so a link to an item that can never move is refused up front.
 */
export async function assertLinkablePlanItem(
  tx: Tx,
  p: Principal,
  planItemId: string,
  patientId: string,
) {
  const item = await tx.planItem.findUnique({ where: { id: planItemId } });
  if (!item || item.patientId !== patientId) throw invalidPlanItem("not_found");
  const plan = await tx.treatmentPlan.findUnique({ where: { id: item.planId } });
  // Same answer as a missing item: the caller may not learn the plan exists.
  if (!plan || !can(p, "plan:read", { branchId: plan.branchId }))
    throw invalidPlanItem("not_found");
  if (FROZEN_PLAN_STATUSES.includes(plan.status as TreatmentPlanStatus))
    throw invalidPlanItem("plan_closed");
  if (!PLAN_ITEM_LINKABLE.includes(item.status as PlanItemStatus))
    throw invalidPlanItem("item_not_startable");
  return item;
}

/**
 * True when deleting this COMPLETED, plan-linked procedure would leave its item IN_PROGRESS (or
 * later) with no completed procedure behind it — the item cannot go back (ADR 0003 §3.1). When
 * the item never moved (startPlanItem skipped it) or another completed procedure also links it,
 * the draft may be deleted.
 */
export async function isOnlyEvidenceOfPlanProgress(
  tx: Tx,
  procedureId: string,
  planItemId: string,
): Promise<boolean> {
  // FOR UPDATE: two concurrent deletes of the item's last two completed procedures serialise.
  const [item] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "PlanItem" WHERE "id" = ${planItemId}::uuid FOR UPDATE`;
  if (!item || !["IN_PROGRESS", "COMPLETED"].includes(item.status)) return false;
  const others = await tx.procedureRecord.count({
    where: { planItemId, status: "COMPLETED", id: { not: procedureId } },
  });
  return others === 0;
}

/**
 * A COMPLETED procedure linked to a plan item moves the item ACCEPTED|SCHEDULED -> IN_PROGRESS
 * (never COMPLETED: plan completion belongs to the plans module). An IN_PROGRESS procedure does
 * not move it, and the last COMPLETED procedure behind a moved item cannot be deleted (409
 * procedure_linked_to_plan, see isOnlyEvidenceOfPlanProgress) — ADR 0003 §3.1 has no way back
 * from IN_PROGRESS. The link itself is validated by assertLinkablePlanItem. Silently skipped
 * when the item is in another state, the plan is frozen, or the caller lacks the permission at
 * the plan's branch (recording the procedure must not fail because of the plan).
 * After presentation every plan change appends a TreatmentPlanVersion snapshot (ADR 0003 §3.2).
 * Returns the item id when it moved.
 */
export async function startPlanItem(
  tx: Tx,
  p: Principal,
  planItemId: string,
): Promise<string | null> {
  const item = await tx.planItem.findUnique({ where: { id: planItemId } });
  if (!item) return null;
  const from = item.status as PlanItemStatus;
  if (!PLAN_ITEM_STARTABLE.includes(from) || !canTransitionPlanItem(from, "IN_PROGRESS"))
    return null;
  const plan = await tx.treatmentPlan.findUnique({ where: { id: item.planId } });
  if (!plan || FROZEN_PLAN_STATUSES.includes(plan.status as TreatmentPlanStatus)) return null;
  if (!canAny(p, planItemTransitionPermissions(from, "IN_PROGRESS"), plan.branchId)) return null;

  const moved = await tx.planItem.updateMany({
    where: { id: item.id, status: item.status },
    data: { status: "IN_PROGRESS" },
  });
  if (moved.count === 0) return null; // concurrent change: leave it to whoever won

  const items = await tx.planItem.findMany({
    where: { planId: plan.id },
    include: { service: { select: { code: true, name: true } } },
    orderBy: [{ phase: "asc" }, { sequence: "asc" }, { createdAt: "asc" }],
  });
  const status = derivePlanStatus(
    plan.status as TreatmentPlanStatus,
    items.map((i) => i.status as PlanItemStatus),
  );
  if (plan.currentVersion === 0) {
    if (status !== plan.status)
      await tx.treatmentPlan.update({ where: { id: plan.id }, data: { status } });
    return item.id;
  }
  const version = plan.currentVersion + 1;
  const snapshot = {
    plan: {
      id: plan.id,
      patientId: plan.patientId,
      branchId: plan.branchId,
      title: plan.title,
      notes: plan.notes,
      status,
    },
    items: items.map((i) => ({
      id: i.id,
      phase: i.phase,
      sequence: i.sequence,
      serviceId: i.serviceId,
      serviceCode: i.service.code,
      serviceName: i.service.name,
      toothCode: i.toothCode,
      surfaces: i.surfaces,
      quantity: i.quantity,
      estimatePricePaise: i.estimatePricePaise,
      priceSource: i.priceSource,
      status: i.status,
      decisionReason: i.decisionReason,
      notes: i.notes,
    })),
    totals: planTotals(
      items.map((i) => ({
        status: i.status as PlanItemStatus,
        estimatePricePaise: i.estimatePricePaise,
        quantity: i.quantity,
      })),
    ),
  };
  const bumped = await tx.treatmentPlan.updateMany({
    where: { id: plan.id, currentVersion: plan.currentVersion },
    data: { currentVersion: version, status },
  });
  if (bumped.count === 0) throw new ConflictException({ error: "concurrent_plan_edit" });
  try {
    await tx.treatmentPlanVersion.create({
      data: {
        tenantId: plan.tenantId,
        planId: plan.id,
        patientId: plan.patientId,
        version,
        snapshot: snapshot as Prisma.InputJsonValue,
        reason: "procedure_started",
        createdBy: p.userId,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictException({ error: "concurrent_plan_edit" });
    throw e;
  }
  return item.id;
}
