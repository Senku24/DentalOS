import type { AnalyticsSnapshot, PrismaClient, Tx } from "@dentalos/db";
import {
  type AnalyticsSnapshotResponse,
  type DailySummaryQuery,
  type RegenerateDailySummaryRequest,
  addCalendarDays,
  branchDailyMetrics,
  buildDailySummaryPrompt,
  extractJsonObject,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { assertCan } from "../common/principal";
import { aiError, asJson, notFound, runTx } from "./ai-common";
import { hasAiPermissions } from "./ai-context";
import { AiGateService } from "./ai-gate.service";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET returns the stored snapshot (money masked without finance:report; the AI narrative quotes money, so it is shown
 * only to finance viewers). Regenerate re-writes the narrative from the stored numbers (counts against the quota).
 * The nightly job lives in apps/worker/src/handlers/ai (`ai.daily-summary`).
 */
@Injectable()
export class AiDailySummaryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly gate: AiGateService,
  ) {}

  private toResponse(row: AnalyticsSnapshot, finance: boolean): AnalyticsSnapshotResponse {
    const m = branchDailyMetrics.parse(row.metrics);
    const meta = row.aiSummaryMeta as {
      provider: string;
      model: string;
      promptVersion: string;
    } | null;
    return {
      id: row.id,
      branchId: row.branchId,
      day: ymd(row.day),
      metrics: {
        ...m,
        billedPaise: finance ? m.billedPaise : null,
        collectedPaise: finance ? m.collectedPaise : null,
        outstandingPaise: finance ? m.outstandingPaise : null,
      },
      aiSummary: finance ? row.aiSummary : null,
      aiSummaryMeta: finance && row.aiSummary ? meta : null,
      generatedAt: row.generatedAt.toISOString(),
    };
  }

  private find(tx: Tx, tenantId: string, branchId: string, day?: string) {
    return day
      ? tx.analyticsSnapshot.findUnique({
          where: {
            tenantId_branchId_day: { tenantId, branchId, day: new Date(`${day}T00:00:00.000Z`) },
          },
        })
      : tx.analyticsSnapshot.findFirst({ where: { branchId }, orderBy: { day: "desc" } });
  }

  async get(p: Principal, q: DailySummaryQuery): Promise<AnalyticsSnapshotResponse> {
    assertCan(p, "analytics:branch", { branchId: q.branchId });
    return runTx(this.prisma, p, async (tx) => {
      const row = await this.find(tx, p.tenantId, q.branchId, q.day);
      if (!row) throw notFound("snapshot_not_found");
      return this.toResponse(row, can(p, "finance:report", { branchId: q.branchId }));
    });
  }

  async regenerate(
    p: Principal,
    body: RegenerateDailySummaryRequest,
  ): Promise<AnalyticsSnapshotResponse> {
    const capability = "daily_branch_summary" as const;
    const permitted =
      hasAiPermissions(p, capability, body.branchId) &&
      can(p, "finance:report", { branchId: body.branchId });
    const snap = await runTx(this.prisma, p, async (tx) => {
      // Out-of-scope callers must not learn whether a snapshot exists: the gate below answers them first.
      if (!permitted) return null;
      const row = await this.find(tx, p.tenantId, body.branchId, body.day);
      if (!row) throw notFound("snapshot_not_found");
      const branch = await tx.branch.findUnique({ where: { id: body.branchId } });
      const prev = await tx.analyticsSnapshot.findUnique({
        where: {
          tenantId_branchId_day: {
            tenantId: p.tenantId,
            branchId: body.branchId,
            day: new Date(`${addCalendarDays(ymd(row.day), -1)}T00:00:00.000Z`),
          },
        },
      });
      return { row, branchName: branch?.name ?? "Branch", prev };
    });
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "BRANCH",
      branchId: body.branchId,
      hasPermissions: permitted,
    });
    if (!snap) throw aiError("ai_role_denied"); // unreachable: `permitted` false is denied by the gate
    const m = branchDailyMetrics.parse(snap.row.metrics);
    const pm = snap.prev ? branchDailyMetrics.safeParse(snap.prev.metrics) : null;
    const prompt = buildDailySummaryPrompt(
      {
        branchName: snap.branchName,
        day: ymd(snap.row.day),
        metrics: {
          appointments: m.appointments.total,
          completedVisits: m.completedVisits,
          newPatients: m.newPatients,
          cancellationRateBp: m.cancellationRateBp,
          noShowRateBp: m.noShowRateBp,
          billedPaise: m.billedPaise,
          collectedPaise: m.collectedPaise,
          outstandingPaise: m.outstandingPaise,
        },
        previous: pm?.success
          ? {
              appointments: pm.data.appointments.total,
              completedVisits: pm.data.completedVisits,
              collectedPaise: pm.data.collectedPaise,
            }
          : null,
      },
      { language: "en" },
    );
    let text: string | null = null;
    let chat: Awaited<ReturnType<typeof adm.provider.chat>> | null = null;
    try {
      chat = await adm.provider.chat({
        task: prompt.task,
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        payload: prompt.payload,
        language: "en",
        json: true,
        maxOutputTokens: 600,
      });
      const obj = extractJsonObject(chat.text) as { summary?: unknown } | null;
      text = typeof obj?.summary === "string" ? obj.summary.trim().slice(0, 2000) : null;
    } catch {
      text = null;
    }
    if (!text || !chat) {
      await this.gate.finish(adm, {
        action: "summarise",
        outcome: "error",
        errorCode: "ai_provider_error",
        usage: chat?.usage,
        deidentified: true,
      });
      throw aiError("ai_provider_error");
    }
    const done = chat;
    const summary = text;
    const row = await runTx(this.prisma, p, async (tx) => {
      const updated = await tx.analyticsSnapshot.update({
        where: { id: snap.row.id },
        data: {
          aiSummary: summary,
          aiSummaryMeta: asJson({
            provider: done.provider,
            model: done.model,
            promptVersion: prompt.promptVersion,
          }),
        },
      });
      await this.gate.finish(
        adm,
        {
          action: "summarise",
          outcome: "success",
          usage: done.usage,
          deidentified: true,
          content: { prompt: prompt.user, response: done.text },
        },
        tx,
      );
      return updated;
    });
    return this.toResponse(row, true);
  }
}
