import { type AiDraft, Prisma, type PrismaClient, type Tx } from "@dentalos/db";
import {
  AI_DRAFT_KINDS,
  type AiCapability,
  type AiDraftKind,
  type AiDraftResponse,
  type ApproveAiDraftRequest,
  type ApproveAiDraftResponse,
  type ListAiDraftsQuery,
  type RejectAiDraftRequest,
  type UpdateAiDraftRequest,
  aiContentHash,
  aiDraftMetadata,
  aiNoteContent,
  evaluateAiAccess,
  parseDraftContent,
  soapNotesFromDraft,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { loadEncounter, lockEncounter } from "../clinical/clinical-common";
import { branchWhere } from "../common/principal";
import {
  aiError,
  asJson,
  beforeCursor,
  encodeCursor,
  encounterSigned,
  runTx,
  toDraftResponse,
} from "./ai-common";
import { hasAiPermissions } from "./ai-context";
import { AiGateService } from "./ai-gate.service";

export const CAPABILITY_OF_KIND: Readonly<Record<AiDraftKind, AiCapability>> = {
  PATIENT_HISTORY_SUMMARY: "patient_history_summary",
  ENCOUNTER_SUMMARY: "encounter_summary",
  CLINICAL_NOTE: "clinical_note_draft",
  VOICE_NOTE: "voice_note_draft",
  PLAN_EXPLANATION: "plan_explanation",
};
const NOTE_KINDS: readonly AiDraftKind[] = ["CLINICAL_NOTE", "VOICE_NOTE"];

/**
 * AI drafts: list / get / edit / approve / reject (ADR 0005 §5.2-§5.5). A draft is visible and workable only for callers
 * who hold the capability's permissions at the draft's branch (a draft outside that scope answers 404). Approving a
 * clinical note draft writes the ClinicalNote rows AS THE APPROVING DENTIST in the same transaction (the DB refuses
 * anything else, and a signed encounter); approving a plan explanation only records the approval (the portal reads it).
 * Nothing here executes a suggestion: there is no code path from a draft to any other record besides those notes.
 */
@Injectable()
export class AiDraftsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly gate: AiGateService,
    private readonly audit: AuditService,
  ) {}

  private canWork(p: Principal, d: Pick<AiDraft, "kind" | "branchId">): boolean {
    return hasAiPermissions(p, CAPABILITY_OF_KIND[d.kind], d.branchId);
  }

  /** The draft, or 404 when it does not exist / the caller has no access to its branch and kind. */
  private async visible(tx: Tx, p: Principal, id: string): Promise<AiDraft> {
    const d = await tx.aiDraft.findUnique({ where: { id } });
    if (!d || !this.canWork(p, d)) throw aiError("ai_draft_not_found");
    return d;
  }

  async list(p: Principal, q: ListAiDraftsQuery) {
    const kinds = AI_DRAFT_KINDS.filter((k) => hasAiPermissions(p, CAPABILITY_OF_KIND[k]));
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.AiDraftWhereInput[] = [
        branchWhere(p) as Prisma.AiDraftWhereInput,
        { kind: { in: kinds } },
        ...(beforeCursor("createdAt", q.cursor) as Prisma.AiDraftWhereInput[]),
      ];
      if (q.status) and.push({ status: q.status });
      if (q.kind) and.push({ kind: q.kind });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.encounterId) and.push({ encounterId: q.encounterId });
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.mine) and.push({ createdBy: p.userId });
      const rows = await tx.aiDraft.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: await Promise.all(items.map(toDraftResponse)),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  async get(p: Principal, id: string): Promise<AiDraftResponse> {
    return runTx(this.prisma, p, async (tx) => toDraftResponse(await this.visible(tx, p, id)));
  }

  // ------------------------------------------------------------------------------------------
  // Edit
  // ------------------------------------------------------------------------------------------

  async update(p: Principal, id: string, body: UpdateAiDraftRequest): Promise<AiDraftResponse> {
    const row = await runTx(this.prisma, p, async (tx) => {
      const d = await this.visible(tx, p, id);
      if (d.status !== "DRAFT") throw aiError("ai_draft_final", { status: d.status });
      if (d.expiresAt.getTime() < Date.now()) throw aiError("ai_draft_expired");
      const merged = { ...((d.content ?? {}) as Record<string, unknown>), ...body.content };
      const parsed = parseDraftContent(d.kind, merged);
      if (!parsed.success)
        throw aiError("ai_draft_content_invalid", {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      const r = await tx.aiDraft.updateMany({
        where: { id, status: "DRAFT" },
        data: { content: asJson(parsed.data), editedBy: p.userId, editedAt: new Date() },
      });
      if (r.count !== 1) throw aiError("ai_draft_final");
      return tx.aiDraft.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.record(p, {
      action: "ai.draft.edit",
      resource: "ai_draft",
      resourceId: id,
      branchId: row.branchId,
      outcome: "success",
    });
    return await toDraftResponse(row);
  }

  // ------------------------------------------------------------------------------------------
  // Approve
  // ------------------------------------------------------------------------------------------

  async approve(
    p: Principal,
    id: string,
    body: ApproveAiDraftRequest,
  ): Promise<ApproveAiDraftResponse> {
    // Step 1 (read only, no row locks): the gate that needs no provider — setting, role and permission.
    const pre = await runTx(this.prisma, p, async (tx) => {
      const d = await this.visible(tx, p, id);
      const setting = await tx.aiSetting.findUnique({
        where: {
          tenantId_capability: { tenantId: p.tenantId, capability: CAPABILITY_OF_KIND[d.kind] },
        },
      });
      return { d, setting };
    });
    const capability = CAPABILITY_OF_KIND[pre.d.kind];
    const denied = evaluateAiAccess({
      // The provider is not called on approval: judge the setting, role and permissions only.
      config: { provider: "stub", model: "", baseUrl: null, regionCompliant: true, problem: null },
      capability,
      setting: pre.setting
        ? {
            enabled: pre.setting.enabled,
            allowedRoles: pre.setting.allowedRoles,
            monthlyQuota: null,
          }
        : undefined,
      roles: p.roles,
      hasPermissions: this.canWork(p, pre.d),
      usedThisMonth: 0,
    }).find(
      (x) => x === "capability_disabled" || x === "role_not_allowed" || x === "permission_missing",
    );
    if (denied) {
      const code = denied === "capability_disabled" ? "ai_capability_disabled" : "ai_role_denied";
      await this.logDraftEvent(p, pre.d, {
        action: "approve",
        outcome: denied === "capability_disabled" ? "disabled" : "denied",
        errorCode: code,
      });
      throw aiError(code);
    }

    // Step 2: the state transition (and, for note drafts, the notes) in ONE transaction.
    const out = await runTx(this.prisma, p, async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "AiDraft" WHERE "id" = ${id}::uuid FOR UPDATE`);
      const d = await tx.aiDraft.findUniqueOrThrow({ where: { id } });
      if (d.status !== "DRAFT") throw aiError("ai_draft_final", { status: d.status });
      if (d.expiresAt.getTime() < Date.now()) throw aiError("ai_draft_expired");
      if ((await aiContentHash(d.content)) !== body.contentHash)
        throw aiError("ai_content_changed");

      const noteIds: string[] = [];
      let resulting: { type: string; id: string } | null = null;
      if (NOTE_KINDS.includes(d.kind)) {
        if (!d.encounterId) throw aiError("ai_draft_content_invalid", { reason: "no_encounter" });
        const content = aiNoteContent.safeParse(d.content);
        if (!content.success) throw aiError("ai_draft_content_invalid");
        // Never touch a signed encounter: share-lock it so a concurrent sign waits, then check it is still OPEN.
        await lockEncounter(tx, d.encounterId);
        const enc = await loadEncounter(tx, d.encounterId);
        if (enc.status !== "OPEN") throw encounterSigned();
        for (const n of soapNotesFromDraft(content.data)) {
          const note = await tx.clinicalNote.create({
            data: {
              tenantId: p.tenantId,
              encounterId: enc.id,
              kind: n.kind,
              body: n.body,
              authorId: p.userId, // the approving dentist, not the draft's creator and not "AI"
              aiAssisted: true,
              aiDraftId: d.id,
            },
            select: { id: true },
          });
          noteIds.push(note.id);
        }
        const first = noteIds[0];
        if (!first) throw aiError("ai_draft_content_invalid", { reason: "empty" });
        resulting = { type: "ClinicalNote", id: first };
      }
      const r = await tx.aiDraft.updateMany({
        where: { id, status: "DRAFT" },
        data: {
          status: "APPROVED",
          reviewedBy: p.userId,
          reviewedAt: new Date(),
          reviewNote: body.note ?? null,
          resultingRecordType: resulting?.type ?? null,
          resultingRecordId: resulting?.id ?? null,
        },
      });
      if (r.count !== 1) throw aiError("ai_draft_final");
      const row = await tx.aiDraft.findUniqueOrThrow({ where: { id } });
      await this.logDraftEvent(
        p,
        row,
        { action: "approve", outcome: "success", approval: "APPROVED" },
        tx,
      );
      return { row, noteIds };
    });
    await this.audit.record(p, {
      action: "ai.draft.approve",
      resource: "ai_draft",
      resourceId: id,
      branchId: out.row.branchId,
      outcome: "success",
    });
    return { draft: await toDraftResponse(out.row), noteIds: out.noteIds };
  }

  // ------------------------------------------------------------------------------------------
  // Reject
  // ------------------------------------------------------------------------------------------

  async reject(p: Principal, id: string, body: RejectAiDraftRequest): Promise<AiDraftResponse> {
    const row = await runTx(this.prisma, p, async (tx) => {
      await this.visible(tx, p, id);
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "AiDraft" WHERE "id" = ${id}::uuid FOR UPDATE`);
      const d = await tx.aiDraft.findUniqueOrThrow({ where: { id } });
      if (d.status !== "DRAFT") throw aiError("ai_draft_final", { status: d.status });
      const r = await tx.aiDraft.updateMany({
        where: { id, status: "DRAFT" },
        data: {
          status: "REJECTED",
          reviewedBy: p.userId,
          reviewedAt: new Date(),
          reviewNote: body.reason,
        },
      });
      if (r.count !== 1) throw aiError("ai_draft_final");
      const row = await tx.aiDraft.findUniqueOrThrow({ where: { id } });
      await this.logDraftEvent(
        p,
        row,
        { action: "reject", outcome: "success", approval: "REJECTED" },
        tx,
      );
      return row;
    });
    await this.audit.record(p, {
      action: "ai.draft.reject",
      resource: "ai_draft",
      resourceId: id,
      branchId: row.branchId,
      outcome: "success",
    });
    return await toDraftResponse(row);
  }

  /** Activity-log row for a draft event; provider / model come from the draft's own provenance. */
  private async logDraftEvent(
    p: Principal,
    d: AiDraft,
    f: {
      action: "approve" | "reject";
      outcome: "success" | "denied" | "disabled";
      approval?: "APPROVED" | "REJECTED";
      errorCode?: string;
    },
    tx?: Tx,
  ) {
    const meta = aiDraftMetadata.parse(d.metadata);
    await this.gate.record(tx, {
      tenantId: p.tenantId,
      actorId: p.userId,
      scope: "PATIENT",
      branchId: d.branchId,
      patientId: d.patientId,
      capability: CAPABILITY_OF_KIND[d.kind],
      provider: meta.provider,
      model: meta.model,
      draftId: d.id,
      deidentified: meta.deidentified,
      ...f,
    });
  }
}
