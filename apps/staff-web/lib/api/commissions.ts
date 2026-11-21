import type {
  ApproveSettlementRequest,
  CloseCommissionRuleRequest,
  CommissionEntryResponse,
  CommissionRuleResponse,
  CreateCommissionAdjustmentRequest,
  CreateCommissionRuleRequest,
  CreateSettlementRequest,
  DentistStatementResponse,
  PaySettlementRequest,
  SettlementDetailResponse,
  SettlementResponse,
  SupersedeCommissionRuleRequest,
} from "@dentalos/validation";
import {
  type ApiClient,
  type Method,
  type MockHandler,
  type RequestOptions,
  apiClient,
  createClient,
} from "./client";
import { withCommissionMessage } from "./commissions-errors";
import { API_PREFIX, type QueryValue } from "./routes";
import type { Page } from "./types";

/**
 * Client for the dentist-compensation API (PRD 4.6, ADR 0004 §7; apps/api/src/commissions). Errors are
 * re-labelled with compensation copy; in mock mode `commissions-mock.ts` serves the routes and falls back
 * to the shared M1 mock for branches, staff and the service catalogue.
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./commissions-mock")).commissionsMockHandler(method, path, query, body);

function withCommissionErrors(c: ApiClient): ApiClient {
  return {
    config: c.config,
    request<T>(method: Method, path: string, opts?: RequestOptions<T>) {
      return c.request<T>(method, path, opts).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw withCommissionMessage(e);
      });
    },
  };
}

export const commissionsClient: ApiClient = withCommissionErrors(
  createClient({ ...apiClient.config, mockHandler: lazyMock }),
);

const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const commissionRoutes = {
  /** GET ?dentistUserId&serviceCategoryId&defaultsOnly&asOf&open → page(rule); POST createCommissionRuleRequest */
  rules: () => p("/commission-rules"),
  rule: (ruleId: string) => p(`/commission-rules/${id(ruleId)}`),
  /** POST supersedeCommissionRuleRequest: closes the open rule and inserts the new one */
  ruleSupersede: (ruleId: string) => p(`/commission-rules/${id(ruleId)}/supersede`),
  /** POST closeCommissionRuleRequest (200) */
  ruleClose: (ruleId: string) => p(`/commission-rules/${id(ruleId)}/close`),
  /** GET ?dentistUserId&branchId&invoiceId&kind&settled&from&to → page(entry) */
  entries: () => p("/commission-entries"),
  /** POST createCommissionAdjustmentRequest (compensation:manage) */
  adjustments: () => p("/commission-entries/adjustments"),
  /** POST createSettlementRequest; GET ?dentistUserId&status&from&to → page(settlement) */
  settlements: () => p("/commission-settlements"),
  /** GET detail with frozen items; DELETE (204, DRAFT only) */
  settlement: (settlementId: string) => p(`/commission-settlements/${id(settlementId)}`),
  /** POST approveSettlementRequest (200, compensation:settle) */
  settlementApprove: (settlementId: string) =>
    p(`/commission-settlements/${id(settlementId)}/approve`),
  /** POST paySettlementRequest (200, compensation:manage) */
  settlementPay: (settlementId: string) => p(`/commission-settlements/${id(settlementId)}/pay`),
  /** GET ?dentistUserId&branchId&from&to (required) → statement */
  statement: () => p("/compensation/statement"),
  /** POST (200, compensation:manage): manual / recovery accrual for one payment allocation */
  accrue: (allocationId: string) => p(`/commissions/accrue/${id(allocationId)}`),
} as const;

/** POST /commissions/accrue/:allocationId (apps/api/src/commissions/accrual.ts `AccrualResult`). */
export interface AccrualResult {
  allocationId: string;
  /** "accrued" = at least one entry written; "noop" = nothing to write (replay / nothing earned). */
  status: "accrued" | "noop" | "not_found";
  entries: unknown[];
  skipped: { invoiceLineId: string | null; reason: string }[];
}

export interface RuleListQuery {
  dentistUserId?: string;
  serviceCategoryId?: string;
  defaultsOnly?: boolean;
  asOf?: string;
  open?: boolean;
  cursor?: string;
  limit?: number;
}
export interface EntryListQuery {
  dentistUserId?: string;
  branchId?: string;
  invoiceId?: string;
  kind?: string;
  settled?: boolean;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface SettlementListQuery {
  dentistUserId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface StatementQuery {
  dentistUserId?: string;
  branchId?: string;
  from: string;
  to: string;
}

type Q = Record<string, QueryValue>;

export function createCommissionsApi(c: ApiClient) {
  const get = <T>(path: string, query?: object) =>
    c.request<T>("GET", path, { query: query as Q | undefined });
  const post = <T>(path: string, body: unknown) => c.request<T>("POST", path, { body });
  const r = commissionRoutes;
  return {
    rules: {
      list: (q: RuleListQuery = {}) => get<Page<CommissionRuleResponse>>(r.rules(), q),
      create: (b: CreateCommissionRuleRequest) => post<CommissionRuleResponse>(r.rules(), b),
      supersede: (ruleId: string, b: SupersedeCommissionRuleRequest) =>
        post<CommissionRuleResponse>(r.ruleSupersede(ruleId), b),
      close: (ruleId: string, b: CloseCommissionRuleRequest) =>
        post<CommissionRuleResponse>(r.ruleClose(ruleId), b),
    },
    entries: {
      list: (q: EntryListQuery = {}) => get<Page<CommissionEntryResponse>>(r.entries(), q),
      adjust: (b: CreateCommissionAdjustmentRequest) =>
        post<CommissionEntryResponse>(r.adjustments(), b),
    },
    settlements: {
      list: (q: SettlementListQuery = {}) => get<Page<SettlementResponse>>(r.settlements(), q),
      get: (settlementId: string) => get<SettlementDetailResponse>(r.settlement(settlementId)),
      create: (b: CreateSettlementRequest) => post<SettlementResponse>(r.settlements(), b),
      approve: (settlementId: string, b: ApproveSettlementRequest) =>
        post<SettlementResponse>(r.settlementApprove(settlementId), b),
      pay: (settlementId: string, b: PaySettlementRequest) =>
        post<SettlementResponse>(r.settlementPay(settlementId), b),
      remove: (settlementId: string) => c.request<void>("DELETE", r.settlement(settlementId)),
    },
    statement: (q: StatementQuery) => get<DentistStatementResponse>(r.statement(), q),
    accrue: (allocationId: string) => post<AccrualResult>(r.accrue(allocationId), {}),
  };
}

export const commissionsApi = createCommissionsApi(commissionsClient);
