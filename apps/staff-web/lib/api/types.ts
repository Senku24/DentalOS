import type {
  DuplicateCheckResponse,
  EffectivePriceResponse,
  InvitationResponse,
  MergePatientsRequest,
  PatientResponse,
  ServiceResponse,
  communicationPreference,
  z,
} from "@dentalos/validation";

/**
 * Response/request shapes the staff app relies on that are NOT (yet) in @dentalos/validation.
 * Each mirrors an apps/api local DTO or controller return value; candidates for promotion.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Items<T> {
  items: T[];
}

/** GET /org/onboarding (apps/api/src/org/tenant.controller.ts). */
export interface OnboardingResponse {
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED";
  onboardedAt: string | null;
  steps: { settings: boolean; branches: boolean; services: boolean; staff: boolean };
  complete: boolean;
}

/** GET /catalog/price-list row: service + effective price for the branch. */
export type PriceListItem = ServiceResponse & Omit<EffectivePriceResponse, "serviceId">;
export interface PriceListResponse {
  branchId: string;
  items: PriceListItem[];
}

/** POST /invitations and /resend also return the raw token once (shown to the inviter in dev). */
export type CreatedInvitation = InvitationResponse & { token?: string; acceptPath?: string };

export type CommunicationPreference = z.infer<typeof communicationPreference>;

/** Shared contract types (packages/validation); re-exported so screens import from one place. */
export { MERGEABLE_FIELDS } from "@dentalos/validation";
export type { ConvertEnquiryRequest, MergeableField } from "@dentalos/validation";
/** `mergePatientsRequest` now carries `fieldChoices` itself. */
export type MergeRequest = MergePatientsRequest;

/** `searchPatientsQuery` filters (intakeType/email now in the shared schema). */
export interface PatientSearch {
  q?: string;
  phone?: string;
  email?: string;
  dob?: string;
  originBranchId?: string;
  lifecycleStage?: string;
  intakeType?: string;
  includeMerged?: boolean;
  cursor?: string;
  limit?: number;
}

/** POST/PATCH /patients responses include likely matches found at write time. */
export type PatientWithDuplicates = PatientResponse & {
  possibleDuplicates?: DuplicateCheckResponse["matches"];
};

/** 409 possible_duplicates body. */
export interface PossibleDuplicatesBody {
  error: "possible_duplicates";
  matches: DuplicateCheckResponse["matches"];
}
