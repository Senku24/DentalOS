import { type AiSetting, Prisma, type PrismaClient } from "@dentalos/db";
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_CATALOGUE,
  type AiActivityResponse,
  type AiCapabilitiesResponse,
  type AiProviderInfo,
  type AiSettingResponse,
  type AiSettingsResponse,
  type AiUsageQuery,
  type AiUsageResponse,
  type ListAiActivityQuery,
  type UpdateAiSettingRequest,
  aiQuotaRemaining,
  evaluateAiAccess,
} from "@dentalos/validation";
import type { AiCapability } from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { beforeCursor, encodeCursor, runTx } from "./ai-common";
import { hasAiPermissions } from "./ai-context";
import { AiGateService } from "./ai-gate.service";
import { AiProviderService } from "./ai-provider.service";

const monthDate = (m: string) => new Date(`${m}T00:00:00.000Z`);

/** Settings, the caller's capability list, usage and the activity log (ADR 0005 §5.10, §5.11). */
@Injectable()
export class AiAdminService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly providers: AiProviderService,
    private readonly gate: AiGateService,
    private readonly audit: AuditService,
  ) {}

  private providerInfo(): AiProviderInfo {
    const { config } = this.providers.current();
    return {
      provider: config.provider,
      model: config.model,
      regionCompliant: config.regionCompliant,
      problem: config.problem,
    };
  }

  /** Setting rows, this month's usage rows (by capability). */
  private async state(p: Principal, month?: string) {
    return runTx(this.prisma, p, async (tx) => {
      const m = month ?? (await this.gate.usageMonth(tx, p.tenantId));
      const [settings, usage] = await Promise.all([
        tx.aiSetting.findMany(),
        tx.aiUsage.findMany({ where: { month: monthDate(m) } }),
      ]);
      return {
        month: m,
        settings: new Map(settings.map((s) => [s.capability, s])),
        usage: new Map(usage.map((u) => [u.capability, u])),
      };
    });
  }

  private settingResponse(
    capability: AiCapability,
    s: AiSetting | undefined,
    used: number,
  ): AiSettingResponse {
    const info = AI_CAPABILITY_CATALOGUE[capability];
    return {
      capability,
      title: info.title,
      enabled: s?.enabled ?? false,
      allowedRoles: (s?.allowedRoles ?? info.defaultRoles) as AiSettingResponse["allowedRoles"],
      monthlyQuota: s?.monthlyQuota ?? null,
      effectiveMonthlyQuota: s?.monthlyQuota ?? info.defaultMonthlyQuota,
      retainContent: s?.retainContent ?? false,
      usedThisMonth: used,
      updatedBy: s?.updatedBy ?? null,
      updatedAt: s?.updatedAt.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------------------------------

  /** What THIS caller can use and why not (role, settings, permissions, quota, provider). */
  async capabilities(p: Principal): Promise<AiCapabilitiesResponse> {
    const { config } = this.providers.current();
    const st = await this.state(p);
    return {
      provider: this.providerInfo(),
      capabilities: AI_CAPABILITIES.map((code) => {
        const info = AI_CAPABILITY_CATALOGUE[code];
        const s = st.settings.get(code);
        const used = st.usage.get(code)?.requestCount ?? 0;
        const denied = evaluateAiAccess({
          config,
          capability: code,
          setting: s
            ? { enabled: s.enabled, allowedRoles: s.allowedRoles, monthlyQuota: s.monthlyQuota }
            : undefined,
          roles: p.roles,
          hasPermissions: hasAiPermissions(p, code),
          usedThisMonth: used,
        });
        return {
          code,
          title: info.title,
          description: info.description,
          available: denied.length === 0,
          denied,
          remainingQuota: s?.enabled
            ? aiQuotaRemaining(code, s.monthlyQuota, used).remaining
            : null,
          requiresDentistApproval: info.requiresDentistApproval,
        };
      }),
    };
  }

  async settings(p: Principal): Promise<AiSettingsResponse> {
    const st = await this.state(p);
    return {
      provider: this.providerInfo(),
      capabilities: AI_CAPABILITIES.map((c) =>
        this.settingResponse(c, st.settings.get(c), st.usage.get(c)?.requestCount ?? 0),
      ),
    };
  }

  async updateSetting(
    p: Principal,
    capability: AiCapability,
    body: UpdateAiSettingRequest,
  ): Promise<AiSettingResponse> {
    const row = await runTx(this.prisma, p, async (tx) => {
      const existing = await tx.aiSetting.findUnique({
        where: { tenantId_capability: { tenantId: p.tenantId, capability } },
      });
      const data = {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.allowedRoles !== undefined
          ? { allowedRoles: [...new Set(body.allowedRoles)] }
          : {}),
        ...(body.monthlyQuota !== undefined ? { monthlyQuota: body.monthlyQuota } : {}),
        ...(body.retainContent !== undefined ? { retainContent: body.retainContent } : {}),
        updatedBy: p.userId,
      };
      if (existing)
        return tx.aiSetting.update({
          where: { tenantId_capability: { tenantId: p.tenantId, capability } },
          data,
        });
      return tx.aiSetting.create({
        data: {
          tenantId: p.tenantId,
          capability,
          enabled: false,
          allowedRoles: [...AI_CAPABILITY_CATALOGUE[capability].defaultRoles],
          ...data,
        },
      });
    });
    await this.audit.record(p, {
      action: "ai.setting.update",
      resource: "ai_setting",
      resourceId: row.id,
      outcome: "success",
    });
    const st = await this.state(p);
    return this.settingResponse(capability, row, st.usage.get(capability)?.requestCount ?? 0);
  }

  async usage(p: Principal, q: AiUsageQuery): Promise<AiUsageResponse> {
    const st = await this.state(p, q.month ? `${q.month}-01` : undefined);
    return {
      month: st.month,
      capabilities: AI_CAPABILITIES.map((capability) => {
        const u = st.usage.get(capability);
        const quota = aiQuotaRemaining(
          capability,
          st.settings.get(capability)?.monthlyQuota ?? null,
          u?.requestCount ?? 0,
        );
        return {
          capability,
          requestCount: u?.requestCount ?? 0,
          promptTokens: u?.promptTokens ?? 0,
          completionTokens: u?.completionTokens ?? 0,
          quota: quota.quota,
          remaining: quota.remaining,
        };
      }),
    };
  }

  async activity(p: Principal, q: ListAiActivityQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.AiActivityLogWhereInput[] = [
        ...(beforeCursor("createdAt", q.cursor) as Prisma.AiActivityLogWhereInput[]),
      ];
      if (q.capability) and.push({ capability: q.capability });
      if (q.actorId) and.push({ actorId: q.actorId });
      if (q.outcome) and.push({ outcome: q.outcome });
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00.000Z`) } });
      if (q.to)
        and.push({ createdAt: { lt: new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86_400_000) } });
      const rows = await tx.aiActivityLog.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        // `content` (only present when retention is on) is deliberately NOT part of the response.
        items: items.map(
          (r): AiActivityResponse => ({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            actorId: r.actorId,
            scope: r.scope as AiActivityResponse["scope"],
            branchId: r.branchId,
            patientId: r.patientId,
            capability: r.capability,
            provider: r.provider,
            model: r.model,
            action: r.action as AiActivityResponse["action"],
            draftId: r.draftId,
            approval: r.approval as AiActivityResponse["approval"],
            outcome: r.outcome as AiActivityResponse["outcome"],
            errorCode: r.errorCode,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            latencyMs: r.latencyMs,
            deidentified: r.deidentified,
          }),
        ),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }
}
