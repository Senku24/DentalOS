import { Prisma, type Tx } from "@dentalos/db";
import {
  AI_CAPABILITY_CATALOGUE,
  AI_QUEUES,
  type AiDenial,
  addCalendarDays,
  aiDailySummaryJob,
  aiUsageMonth,
  branchDailyMetrics,
  buildDailySummaryPrompt,
  evaluateAiAccess,
  extractJsonObject,
} from "@dentalos/validation";
import { type HandlerCtx, log, registerWork } from "../notifications/work";
import { currentProvider } from "./provider";

const CAPABILITY = "daily_branch_summary" as const;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DENIAL_CODE: Record<AiDenial, string> = {
  provider_disabled: "ai_disabled",
  capability_disabled: "ai_capability_disabled",
  role_not_allowed: "ai_role_denied",
  permission_missing: "ai_role_denied",
  quota_exceeded: "ai_quota_exceeded",
  region_not_compliant: "ai_region_not_compliant",
};
const DENIAL_OUTCOME: Record<AiDenial, string> = {
  provider_disabled: "disabled",
  capability_disabled: "disabled",
  role_not_allowed: "denied",
  permission_missing: "denied",
  quota_exceeded: "quota_exceeded",
  region_not_compliant: "refused",
};

interface Plan {
  snapshotId: string;
  branchId: string;
  prompt: ReturnType<typeof buildDailySummaryPrompt>;
  month: string;
  retainContent: boolean;
}

/**
 * `ai.daily-summary` (ADR 0005 §5.8): writes the AI narrative onto an existing AnalyticsSnapshot. The model sees the
 * snapshot's NUMBERS only (`buildDailySummaryPrompt`); the capability gate is the API's (provider + residency policy,
 * AiSetting enabled, monthly quota taken atomically, one AiActivityLog row, no content unless `retainContent`).
 * Three short transactions with the provider call OUTSIDE any transaction. Idempotent: a snapshot that already has a
 * summary is skipped (the API's regenerate overwrites on purpose). A refusal / provider failure is logged and NOT retried
 * (a retry would spend more quota); the next nightly run or a regenerate fills it.
 */
export async function registerDailySummaryHandler(ctx: HandlerCtx) {
  await registerWork(ctx, AI_QUEUES.DAILY_SUMMARY, aiDailySummaryJob, async (c) => {
    const { config, provider } = currentProvider();
    const logRow = (
      tx: Tx,
      p: { branchId: string | null } & Record<string, unknown>,
      f: {
        action: string;
        outcome: string;
        errorCode?: string;
        usage?: { promptTokens: number; completionTokens: number };
        content?: unknown;
        retain?: boolean;
      },
    ) =>
      tx.aiActivityLog.create({
        data: {
          tenantId: c.env.tenantId,
          actorId: "system",
          scope: "BRANCH",
          branchId: p.branchId,
          capability: CAPABILITY,
          provider: provider?.name ?? config.provider,
          model: provider?.model ?? (config.model || "none"),
          action: f.action,
          outcome: f.outcome,
          errorCode: f.errorCode ?? null,
          promptTokens: Math.round(f.usage?.promptTokens ?? 0),
          completionTokens: Math.round(f.usage?.completionTokens ?? 0),
          deidentified: true,
          ...(f.retain && f.content !== undefined
            ? { content: f.content as Prisma.InputJsonValue }
            : {}),
        },
      });

    // 1. Gate + quota (the provider is not touched yet).
    const plan: Plan | null = await c.tx(async (tx) => {
      const snap = await tx.analyticsSnapshot.findUnique({ where: { id: c.env.data.snapshotId } });
      if (!snap) {
        log("warn", "ai.daily-summary: snapshot not found", { snapshotId: c.env.data.snapshotId });
        return null;
      }
      if (snap.aiSummary) return null;
      const tenant = await tx.tenant.findUnique({
        where: { id: c.env.tenantId },
        select: { settings: true },
      });
      const tz = (tenant?.settings as { defaultTimeZone?: string } | null)?.defaultTimeZone;
      let month: string;
      try {
        month = aiUsageMonth(new Date(), tz || undefined);
      } catch {
        month = aiUsageMonth(new Date());
      }
      const setting = await tx.aiSetting.findUnique({
        where: { tenantId_capability: { tenantId: c.env.tenantId, capability: CAPABILITY } },
      });
      const usage = await tx.aiUsage.findUnique({
        where: {
          tenantId_month_capability: {
            tenantId: c.env.tenantId,
            month: new Date(`${month}T00:00:00.000Z`),
            capability: CAPABILITY,
          },
        },
      });
      const denial = evaluateAiAccess({
        config,
        capability: CAPABILITY,
        setting: setting
          ? {
              enabled: setting.enabled,
              // A job has no role: judge everything but the role list.
              allowedRoles: setting.allowedRoles,
              monthlyQuota: setting.monthlyQuota,
            }
          : undefined,
        roles: setting?.allowedRoles ?? [],
        hasPermissions: true,
        usedThisMonth: usage?.requestCount ?? 0,
      }).find((d) => d !== "role_not_allowed");
      if (denial || !provider) {
        const d: AiDenial = denial ?? "provider_disabled";
        await logRow(
          tx,
          { branchId: snap.branchId },
          {
            action: "refuse",
            outcome: DENIAL_OUTCOME[d],
            errorCode: DENIAL_CODE[d],
          },
        );
        return null;
      }
      const quota =
        setting?.monthlyQuota ?? AI_CAPABILITY_CATALOGUE[CAPABILITY].defaultMonthlyQuota;
      const taken =
        quota > 0 &&
        (
          await tx.$queryRaw<{ requestCount: number }[]>(Prisma.sql`
            INSERT INTO "AiUsage" ("id", "tenantId", "month", "capability", "requestCount", "promptTokens", "completionTokens", "updatedAt")
            VALUES (gen_random_uuid(), ${c.env.tenantId}::uuid, ${month}::date, ${CAPABILITY}, 1, 0, 0, now())
            ON CONFLICT ("tenantId", "month", "capability")
            DO UPDATE SET "requestCount" = "AiUsage"."requestCount" + 1, "updatedAt" = now()
            WHERE "AiUsage"."requestCount" < ${quota}
            RETURNING "requestCount"`)
        ).length === 1;
      if (!taken) {
        await logRow(
          tx,
          { branchId: snap.branchId },
          {
            action: "refuse",
            outcome: "quota_exceeded",
            errorCode: "ai_quota_exceeded",
          },
        );
        return null;
      }
      const m = branchDailyMetrics.parse(snap.metrics);
      const branch = await tx.branch.findUnique({ where: { id: snap.branchId } });
      const prev = await tx.analyticsSnapshot.findUnique({
        where: {
          tenantId_branchId_day: {
            tenantId: c.env.tenantId,
            branchId: snap.branchId,
            day: new Date(`${addCalendarDays(ymd(snap.day), -1)}T00:00:00.000Z`),
          },
        },
      });
      const pm = prev ? branchDailyMetrics.safeParse(prev.metrics) : null;
      return {
        snapshotId: snap.id,
        branchId: snap.branchId,
        month,
        retainContent: setting?.retainContent ?? false,
        prompt: buildDailySummaryPrompt(
          {
            branchName: branch?.name ?? "Branch",
            day: ymd(snap.day),
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
        ),
      };
    });
    if (!plan || !provider) return;

    // 2. Provider call, outside any transaction.
    const started = Date.now();
    let chat: Awaited<ReturnType<typeof provider.chat>> | null = null;
    let summary: string | null = null;
    try {
      chat = await provider.chat({
        task: plan.prompt.task,
        promptVersion: plan.prompt.promptVersion,
        system: plan.prompt.system,
        user: plan.prompt.user,
        payload: plan.prompt.payload,
        language: "en",
        json: true,
        maxOutputTokens: 600,
      });
      const obj = extractJsonObject(chat.text) as { summary?: unknown } | null;
      summary = typeof obj?.summary === "string" ? obj.summary.trim().slice(0, 2000) : null;
    } catch {
      summary = null;
    }

    // 3. Store the narrative + usage tokens + the log row.
    await c.tx(async (tx) => {
      if (chat) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "AiUsage"
             SET "promptTokens" = "promptTokens" + ${Math.round(chat.usage.promptTokens)},
                 "completionTokens" = "completionTokens" + ${Math.round(chat.usage.completionTokens)},
                 "updatedAt" = now()
           WHERE "tenantId" = ${c.env.tenantId}::uuid AND "month" = ${plan.month}::date
             AND "capability" = ${CAPABILITY}`);
      }
      if (!summary || !chat) {
        await logRow(
          tx,
          { branchId: plan.branchId },
          {
            action: "summarise",
            outcome: "error",
            errorCode: "ai_provider_error",
            usage: chat?.usage,
          },
        );
        return;
      }
      await tx.analyticsSnapshot.updateMany({
        where: { id: plan.snapshotId, aiSummary: null },
        data: {
          aiSummary: summary,
          aiSummaryMeta: {
            provider: chat.provider,
            model: chat.model,
            promptVersion: plan.prompt.promptVersion,
          },
        },
      });
      await logRow(
        tx,
        { branchId: plan.branchId },
        {
          action: "summarise",
          outcome: "success",
          usage: chat.usage,
          retain: plan.retainContent,
          content: {
            prompt: plan.prompt.user,
            response: chat.text,
            latencyMs: Date.now() - started,
          },
        },
      );
    });
  });
}
