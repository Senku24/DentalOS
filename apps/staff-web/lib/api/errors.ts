/**
 * API error model. The server answers failures with `{ error: "<code>", issues?: [{ path, message }] }`
 * (see apps/api/src/common/zod.pipe.ts). Everything is mapped to one `ApiError` so screens only
 * deal with `kind`, a human message and optional per-field messages.
 */

export type ApiErrorKind =
  | "network"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "gone"
  | "rate_limited"
  | "server"
  | "unknown";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** Server error code, e.g. "last_owner", "validation_failed". */
  readonly code: string | undefined;
  /** Field path ("branchScope", "address.city") → message, from server validation issues. */
  readonly fieldErrors: Record<string, string>;
  /** Raw JSON error body, for contracts that carry data (possible_duplicates.matches, patient_merged.survivorId). */
  readonly body: Record<string, unknown>;

  constructor(init: {
    kind: ApiErrorKind;
    status: number;
    message: string;
    code?: string;
    fieldErrors?: Record<string, string>;
    body?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.fieldErrors = init.fieldErrors ?? {};
    this.body = init.body ?? {};
  }

  /** 409 possible_duplicates (create patient): resubmit with acknowledgeDuplicates after review. */
  get isPossibleDuplicates() {
    return this.status === 409 && this.code === "possible_duplicates";
  }
  /** 409 patient_merged: the record was merged; `survivorId` is where it lives now. */
  get mergedSurvivorId(): string | undefined {
    if (this.code !== "patient_merged") return undefined;
    const v = this.body.survivorId ?? this.body.mergedIntoId;
    return typeof v === "string" ? v : undefined;
  }
  /** 401 reauth_required: step-up (recent sign-in) needed, e.g. patient merge. */
  get needsReauth() {
    return this.status === 401 && this.code === "reauth_required";
  }
}

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unknown";
}

/** Friendly copy for known server error codes. Unknown codes fall back to the kind's default. */
const CODE_MESSAGES: Record<string, string> = {
  validation_failed: "Some details need fixing.",
  last_owner: "The organisation must keep at least one organisation-wide owner.",
  unknown_branch: "One of the selected branches no longer exists.",
  branch_inactive: "That branch is inactive.",
  not_a_dentist: "This staff member does not have the Dentist role.",
  no_open_assignment: "The dentist has no current assignment at the source branch.",
  effective_date_in_past: "The effective date cannot be in the past.",
  transfer_before_assignment_start: "The transfer date is before the current assignment started.",
  end_before_assignment_start: "The end date is before the assignment started.",
  assignment_closed: "This assignment has already ended.",
  invitation_not_pending: "This invitation is no longer pending.",
  invitation_not_resendable: "This invitation can no longer be resent.",
  already_member: "This person is already a member of the organisation.",
  invalid_settings: "The organisation settings are invalid.",
  conflict: "That conflicts with an existing record (for example a duplicate code).",
  possible_duplicates: "Possible duplicate patients were found. Review them before creating.",
  patient_merged: "This patient record was merged into another record. Open the surviving record.",
  reauth_required: "For your security, sign in again to complete this action.",
  invalid_transition: "That lifecycle change isn't allowed from the patient's current stage.",
  category_in_use: "This category still has services. Move or remove them first.",
};

const KIND_MESSAGES: Record<ApiErrorKind, string> = {
  network: "Can't reach the DentalOS server. Check your connection and try again.",
  unauthorized: "Your session has expired. Sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "We couldn't find that record.",
  validation: "Some details need fixing.",
  conflict: "That change conflicts with the current data. Refresh and try again.",
  gone: "That link or record is no longer available.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  server: "Something went wrong on our side. Try again shortly.",
  unknown: "Something unexpected happened.",
};

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  issues?: unknown;
}

/** Builds an ApiError from an HTTP status and (possibly non-JSON) response body. Pure: unit tested. */
export function mapHttpError(status: number, body: unknown): ApiError {
  const kind = kindForStatus(status);
  const b = (body && typeof body === "object" ? body : {}) as ErrorBody;
  const code = typeof b.error === "string" ? b.error : undefined;
  const fieldErrors: Record<string, string> = {};
  if (Array.isArray(b.issues)) {
    for (const i of b.issues) {
      if (i && typeof i === "object" && "path" in i && "message" in i) {
        const path = String((i as { path: unknown }).path);
        if (!(path in fieldErrors)) fieldErrors[path] = String((i as { message: unknown }).message);
      }
    }
  }
  const message = (code && CODE_MESSAGES[code]) ?? KIND_MESSAGES[kind];
  return new ApiError({ kind, status, message, code, fieldErrors, body: b as Record<string, unknown> });
}

export function networkError(): ApiError {
  return new ApiError({ kind: "network", status: 0, message: KIND_MESSAGES.network });
}

export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError({
    kind: "unknown",
    status: 0,
    message: e instanceof Error && e.message ? e.message : KIND_MESSAGES.unknown,
  });
}

/** Title/description pair for the shared `<ErrorState>` / DataTable `error` prop. */
export function errorStateFor(e: unknown): { title: string; description: string } {
  const err = asApiError(e);
  const titles: Record<ApiErrorKind, string> = {
    network: "Offline or server unreachable",
    unauthorized: "Signed out",
    forbidden: "Access denied",
    not_found: "Not found",
    validation: "Request rejected",
    conflict: "Conflict",
    gone: "No longer available",
    rate_limited: "Slow down",
    server: "Server error",
    unknown: "Something went wrong",
  };
  return { title: titles[err.kind], description: err.message };
}
