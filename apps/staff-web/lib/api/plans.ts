import type {
  AddPlanItemRequest,
  ApprovePlanRequest,
  ConsentTemplateResponse,
  ConsentTemplateVersionResponse,
  CreatePlanItemSessionRequest,
  CreatePlanRequest,
  DecidePlanItemsRequest,
  PlanItemSessionResponse,
  PlanItemTransitionRequest,
  PlanVersionResponse,
  SignConsentRequest,
  SignedConsentResponse,
  TreatmentPlanSummary,
  UpdatePlanItemRequest,
  UpdatePlanItemSessionRequest,
  UpdatePlanRequest,
} from "@dentalos/validation";
import type { ApiClient } from "./client";
import { clinicalClient } from "./clinical-client";
import { planRoutes as r } from "./clinical-routes";
import type { PlanDetail, PlanDiffResponse } from "./clinical-types";
import type { Items, Page } from "./types";

export interface PlanListQuery {
  patientId?: string;
  branchId?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

/** POST /plans/:id/items/reorder body (apps/api/src/plans/plans.dto.ts, not yet shared). */
export interface ReorderPlanItemsRequest {
  items: { itemId: string; phase?: number }[];
  reason?: string;
}

/** Typed treatment-plan, session and consent surface. Every plan write returns the full plan. */
export function createPlansApi(c: ApiClient) {
  const get = <T>(path: string, query?: object) =>
    c.request<T>("GET", path, { query: query as Record<string, string> });
  const send = <T>(method: "POST" | "PATCH", path: string, body?: unknown) =>
    c.request<T>(method, path, { body: body ?? {} });

  return {
    list: (q: PlanListQuery) => get<Page<TreatmentPlanSummary>>(r.plans(), q),
    create: (b: CreatePlanRequest) => send<PlanDetail>("POST", r.plans(), b),
    get: (id: string) => get<PlanDetail>(r.plan(id)),
    update: (id: string, b: UpdatePlanRequest) => send<PlanDetail>("PATCH", r.plan(id), b),
    present: (id: string, reason?: string) =>
      send<PlanDetail>("POST", r.planPresent(id), { reason }),
    decide: (id: string, b: DecidePlanItemsRequest) =>
      send<PlanDetail>("POST", r.planDecisions(id), b),
    approve: (id: string, b: ApprovePlanRequest) => send<PlanDetail>("POST", r.planApprove(id), b),
    cancel: (id: string, reason: string) => send<PlanDetail>("POST", r.planCancel(id), { reason }),
    addItem: (id: string, b: AddPlanItemRequest) => send<PlanDetail>("POST", r.planItems(id), b),
    reorder: (id: string, b: ReorderPlanItemsRequest) =>
      send<PlanDetail>("POST", r.planItemsReorder(id), b),
    versions: (id: string) => get<Items<PlanVersionResponse>>(r.planVersions(id)),
    version: (id: string, v: number) => get<PlanVersionResponse>(r.planVersion(id, v)),
    diff: (id: string, a: number, b: number) => get<PlanDiffResponse>(r.planDiff(id, a, b)),
    consents: (id: string) => get<Items<SignedConsentResponse>>(r.planConsents(id)),

    items: {
      update: (itemId: string, b: UpdatePlanItemRequest) =>
        send<PlanDetail>("PATCH", r.planItem(itemId), b),
      remove: (itemId: string) => c.request<PlanDetail>("DELETE", r.planItem(itemId)),
      transition: (itemId: string, b: PlanItemTransitionRequest) =>
        send<PlanDetail>("POST", r.planItemStatus(itemId), b),
      sessions: (itemId: string) => get<Items<PlanItemSessionResponse>>(r.planItemSessions(itemId)),
      createSession: (itemId: string, b: Partial<CreatePlanItemSessionRequest>) =>
        send<PlanItemSessionResponse>("POST", r.planItemSessions(itemId), b),
    },
    sessions: {
      update: (sessionId: string, b: UpdatePlanItemSessionRequest) =>
        send<PlanItemSessionResponse>("PATCH", r.planItemSession(sessionId), b),
      complete: (sessionId: string) =>
        send<PlanItemSessionResponse>("POST", r.planItemSessionComplete(sessionId)),
    },
    consent: {
      templates: (q: { type?: string; active?: boolean } = {}) =>
        get<Items<ConsentTemplateResponse>>(r.consentTemplates(), q),
      template: (templateId: string) => get<ConsentTemplateResponse>(r.consentTemplate(templateId)),
      versions: (templateId: string) =>
        get<Items<ConsentTemplateVersionResponse>>(r.consentTemplateVersions(templateId)),
      sign: (patientId: string, b: SignConsentRequest) =>
        send<SignedConsentResponse>("POST", r.signConsent(patientId), b),
    },
  };
}

export type PlansApi = ReturnType<typeof createPlansApi>;
export const plansApi: PlansApi = createPlansApi(clinicalClient);
