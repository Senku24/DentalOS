import { Prisma, type PrismaClient, type Tx } from "@dentalos/db";
import {
  AI_CAPABILITY_CATALOGUE,
  AI_DENIAL_ERROR,
  type AiCapability,
  type AiConfig,
  type AiDenial,
  type AiProvider,
  aiUsageMonth,
  evaluateAiAccess,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { aiError, asJson, runTx } from "./ai-common";
import { AiProviderService } from "./ai-provider.service";

export type AiScope = "ORG" | "BRANCH" | "PATIENT";
export type AiAction =
  | "generate"
  | "transcribe"
  | "query"
  | "summarise"
  | "approve"
  | "reject"
  | "expire"
  | "proposal"
  | "refuse";
export type AiOutcome = "success" | "refused" | "error" | "quota_exceeded" | "disabled" | "denied";

/** What a successful gate hands back: everything the caller needs to run the provider call and account for it. */
export interface Admission {
  capability: AiCapability;
  provider: AiProvider;
  config: AiConfig;
  actorId: string;
  tenantId: string;
  scope: AiScope;
  branchId: string | null;
  patientId: string | null;
  /** "YYYY-MM-01" of the usage row that was incremented for this call. */
  month: string;
  retainContent: boolean;
  startedAt: number;
}

export interface LogFields {
  action: AiAction;
  outcome: AiOutcome;
  errorCode?: string | null;
  draftId?: string | null;
  approval?: "APPROVED" | "REJECTED" | null;
  usage?: { promptTokens: number; completionTokens: number };
  deidentified?: boolean;
  /** Stored ONLY when the tenant's `retainContent` flag for the capability is on. */
  content?: unknown;
}

/** The order in which denials are reported (spec §5.1): provider, region, setting, role, permission, quota. */
const DENIAL_ORDER: readonly AiDenial[] = [
  "provider_disabled",
  "region_not_compliant",
  "capability_disabled",
  "role_not_allowed",
  "permission_missing",
  "quota_exceeded",
];
const DENIAL_OUTCOME: Readonly<Record<AiDenial, AiOutcome>> = {
  provider_disabled: "disabled",
  capability_disabled: "disabled",
  region_not_compliant: "refused",
  role_not_allowed: "denied",
  permission_missing: "denied",
  quota_exceeded: "quota_exceeded",
};

export interface GateInput {
  p: Principal;
  capability: AiCapability;
  scope: AiScope;
  branchId?: string | null;
  patientId?: string | null;
  /** The caller holds the capability's permission AND its data permissions at the subject's branch. */
  hasPermissions: boolean;
}

/**
 * The gate every AI call passes (ADR 0005 §5.1): config -> region policy -> setting -> role -> permission -> quota.
 * A refusal writes an `AiActivityLog` row and throws; the quota is taken with ONE atomic upsert so parallel calls cannot
 * overshoot it. Nothing is sent to a provider before `admit` returns. The log never receives prompt / response content
 * unless the capability's `retainContent` is on.
 */
@Injectable()
export class AiGateService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly providers: AiProviderService,
  ) {}

  /** Name of the configured provider (or "disabled"), for log rows written before any admission. */
  providerName(): string {
    return this.providers.current().config.provider;
  }

  /** Month key (first day, tenant default time zone) of the current usage row. */
  async usageMonth(tx: Tx, tenantId: string): Promise<string> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const tz = (tenant?.settings as { defaultTimeZone?: string } | null)?.defaultTimeZone;
    try {
      return aiUsageMonth(new Date(), tz || undefined);
    } catch {
      return aiUsageMonth(new Date());
    }
  }

  async admit(g: GateInput): Promise<Admission> {
    const { config, provider } = this.providers.current();
    const base = {
      actorId: g.p.userId,
      tenantId: g.p.tenantId,
      scope: g.scope,
      branchId: g.branchId ?? null,
      patientId: g.patientId ?? null,
    };

    const state = await runTx(this.prisma, g.p, async (tx) => {
      const month = await this.usageMonth(tx, g.p.tenantId);
      const setting = await tx.aiSetting.findUnique({
        where: { tenantId_capability: { tenantId: g.p.tenantId, capability: g.capability } },
      });
      const usage = await tx.aiUsage.findUnique({
        where: {
          tenantId_month_capability: {
            tenantId: g.p.tenantId,
            month: new Date(`${month}T00:00:00.000Z`),
            capability: g.capability,
          },
        },
      });
      return { month, setting, used: usage?.requestCount ?? 0 };
    });

    const denials = evaluateAiAccess({
      config,
      capability: g.capability,
      setting: state.setting
        ? {
            enabled: state.setting.enabled,
            allowedRoles: state.setting.allowedRoles,
            monthlyQuota: state.setting.monthlyQuota,
          }
        : undefined,
      roles: g.p.roles,
      hasPermissions: g.hasPermissions,
      usedThisMonth: state.used,
    });
    const first = DENIAL_ORDER.find((d) => denials.includes(d));
    if (first || !provider) {
      const denial: AiDenial = first ?? "provider_disabled";
      await this.refuse(base, config, g.capability, denial);
      throw aiError(AI_DENIAL_ERROR[denial]);
    }

    // Atomic quota take: the row only moves while it is below the quota (a zero quota never gets here).
    const quota =
      state.setting?.monthlyQuota ?? AI_CAPABILITY_CATALOGUE[g.capability].defaultMonthlyQuota;
    const taken =
      quota > 0 &&
      (await runTx(this.prisma, g.p, async (tx) => {
        const rows = await tx.$queryRaw<{ requestCount: number }[]>(Prisma.sql`
          INSERT INTO "AiUsage" ("id", "tenantId", "month", "capability", "requestCount", "promptTokens", "completionTokens", "updatedAt")
          VALUES (gen_random_uuid(), ${g.p.tenantId}::uuid, ${state.month}::date, ${g.capability}, 1, 0, 0, now())
          ON CONFLICT ("tenantId", "month", "capability")
          DO UPDATE SET "requestCount" = "AiUsage"."requestCount" + 1, "updatedAt" = now()
          WHERE "AiUsage"."requestCount" < ${quota}
          RETURNING "requestCount"`);
        return rows.length === 1;
      }));
    if (!taken) {
      await this.refuse(base, config, g.capability, "quota_exceeded");
      throw aiError("ai_quota_exceeded");
    }

    return {
      ...base,
      capability: g.capability,
      provider,
      config,
      month: state.month,
      retainContent: state.setting?.retainContent ?? false,
      startedAt: Date.now(),
    };
  }

  /** Logs the call's outcome and (when given) its token counts; inside `tx` when the caller has one open. */
  async finish(adm: Admission, f: LogFields, tx?: Tx): Promise<string> {
    const run = async (t: Tx) => {
      if (f.usage && (f.usage.promptTokens > 0 || f.usage.completionTokens > 0))
        await t.$executeRaw(Prisma.sql`
          UPDATE "AiUsage"
             SET "promptTokens" = "promptTokens" + ${Math.max(0, Math.round(f.usage.promptTokens))},
                 "completionTokens" = "completionTokens" + ${Math.max(0, Math.round(f.usage.completionTokens))},
                 "updatedAt" = now()
           WHERE "tenantId" = ${adm.tenantId}::uuid AND "month" = ${adm.month}::date
             AND "capability" = ${adm.capability}`);
      return this.writeLog(t, {
        tenantId: adm.tenantId,
        actorId: adm.actorId,
        scope: adm.scope,
        branchId: adm.branchId,
        patientId: adm.patientId,
        capability: adm.capability,
        provider: adm.provider.name,
        model: adm.provider.model,
        latencyMs: Date.now() - adm.startedAt,
        retainContent: adm.retainContent,
        ...f,
      });
    };
    return tx ? run(tx) : runTx(this.prisma, { tenantId: adm.tenantId, userId: adm.actorId }, run);
  }

  /** A log row that is not a provider call (approve / reject / expire). */
  async record(
    tx: Tx | undefined,
    row: {
      tenantId: string;
      actorId: string;
      scope: AiScope;
      branchId: string | null;
      patientId: string | null;
      capability: string;
      provider: string;
      model: string;
      retainContent?: boolean;
    } & LogFields,
  ): Promise<string> {
    return tx
      ? this.writeLog(tx, row)
      : runTx(this.prisma, { tenantId: row.tenantId, userId: row.actorId }, (t) =>
          this.writeLog(t, row),
        );
  }

  private async refuse(
    base: {
      actorId: string;
      tenantId: string;
      scope: AiScope;
      branchId: string | null;
      patientId: string | null;
    },
    config: AiConfig,
    capability: AiCapability,
    denial: AiDenial,
  ): Promise<void> {
    await this.record(undefined, {
      ...base,
      capability,
      provider: config.provider,
      model: config.model || "none",
      action: "refuse",
      outcome: DENIAL_OUTCOME[denial],
      errorCode: AI_DENIAL_ERROR[denial],
    });
  }

  private async writeLog(
    tx: Tx,
    r: {
      tenantId: string;
      actorId: string;
      scope: AiScope;
      branchId: string | null;
      patientId: string | null;
      capability: string;
      provider: string;
      model: string;
      latencyMs?: number;
      retainContent?: boolean;
    } & LogFields,
  ): Promise<string> {
    const row = await tx.aiActivityLog.create({
      data: {
        tenantId: r.tenantId,
        actorId: r.actorId,
        scope: r.scope,
        branchId: r.branchId,
        patientId: r.patientId,
        capability: r.capability,
        provider: r.provider,
        model: r.model,
        action: r.action,
        draftId: r.draftId ?? null,
        approval: r.approval ?? null,
        outcome: r.outcome,
        errorCode: r.errorCode ?? null,
        promptTokens: Math.max(0, Math.round(r.usage?.promptTokens ?? 0)),
        completionTokens: Math.max(0, Math.round(r.usage?.completionTokens ?? 0)),
        latencyMs: r.latencyMs ?? null,
        deidentified: r.deidentified ?? false,
        // Content only with the tenant's retention flag for this capability; never otherwise.
        ...(r.retainContent && r.content !== undefined ? { content: asJson(r.content) } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }
}
