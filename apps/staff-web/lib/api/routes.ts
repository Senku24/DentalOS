/**
 * Every API path staff-web calls, in one place. Aligned with the final M1 controllers in
 * apps/api/src (org, catalog, patients, documents). The API has no global prefix; `API_PREFIX`
 * exists so a future versioned mount (e.g. "/v1") is a one-line change.
 *
 * Methods are noted next to each path; `./endpoints.ts` is the only caller.
 */
export const API_PREFIX = "";

const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const routes = {
  // ---- Organisation ------------------------------------------------------------------------
  /** GET tenant, PATCH updateTenantRequest */
  org: () => p("/org"),
  /** GET onboarding checklist { status, onboardedAt, steps, complete } */
  orgOnboarding: () => p("/org/onboarding"),

  // ---- Branches ----------------------------------------------------------------------------
  /** GET ?active → { items }, POST createBranchRequest */
  branches: () => p("/branches"),
  /** GET, PATCH updateBranchRequest */
  branch: (branchId: string) => p(`/branches/${id(branchId)}`),
  /** POST */
  branchActivate: (branchId: string) => p(`/branches/${id(branchId)}/activate`),
  /** POST */
  branchDeactivate: (branchId: string) => p(`/branches/${id(branchId)}/deactivate`),

  // ---- Staff & invitations -----------------------------------------------------------------
  /** GET ?role&branchId → { items } */
  staff: () => p("/staff"),
  /** GET, PATCH updateMembershipRequest */
  staffMember: (memberId: string) => p(`/staff/${id(memberId)}`),
  /** GET ?status → { items }, POST createInvitationRequest (returns token + acceptPath once) */
  invitations: () => p("/invitations"),
  /** POST */
  invitationRevoke: (invitationId: string) => p(`/invitations/${id(invitationId)}/revoke`),
  /** POST { expiresInDays } (returns token + acceptPath once) */
  invitationResend: (invitationId: string) => p(`/invitations/${id(invitationId)}/resend`),
  /** POST acceptInvitationRequest (public; not used by the staff shell yet) */
  invitationAccept: () => p("/invitations/accept"),

  // ---- Dentist assignments -----------------------------------------------------------------
  /** GET ?userId&branchId&status=current|all → { items }, POST assignDentistRequest */
  dentistAssignments: () => p("/dentist-assignments"),
  /** POST transferDentistRequest */
  dentistTransfer: () => p("/dentist-assignments/transfer"),
  /** POST endAssignmentRequest */
  dentistAssignmentEnd: (assignmentId: string) =>
    p(`/dentist-assignments/${id(assignmentId)}/end`),

  // ---- Catalogue & pricing -----------------------------------------------------------------
  /** GET → { items }, POST createServiceCategoryRequest */
  catalogCategories: () => p("/catalog/categories"),
  /** GET, PATCH updateServiceCategoryRequest, DELETE (409 if in use) */
  catalogCategory: (categoryId: string) => p(`/catalog/categories/${id(categoryId)}`),
  /** GET ?q&categoryId&active&branchId&cursor&limit → page(service), POST createServiceRequest */
  catalogServices: () => p("/catalog/services"),
  /** GET, PATCH updateServiceRequest, DELETE */
  catalogService: (serviceId: string) => p(`/catalog/services/${id(serviceId)}`),
  /** POST */
  catalogServiceActivate: (serviceId: string) => p(`/catalog/services/${id(serviceId)}/activate`),
  /** POST */
  catalogServiceDeactivate: (serviceId: string) =>
    p(`/catalog/services/${id(serviceId)}/deactivate`),
  /** GET ?branchId → effectivePriceResponse */
  catalogServicePrice: (serviceId: string) => p(`/catalog/services/${id(serviceId)}/price`),
  /** GET ?branchId → { branchId, items: service & effectivePrice } */
  branchPriceList: () => p("/catalog/price-list"),
  /** GET ?branchId → { items: priceOverride[] } (history), PUT setPriceOverrideRequest */
  priceOverrides: (serviceId: string) => p(`/catalog/services/${id(serviceId)}/overrides`),
  /** POST clearPriceOverrideRequest */
  priceOverrideClear: (serviceId: string) =>
    p(`/catalog/services/${id(serviceId)}/overrides/clear`),

  // ---- Patients ----------------------------------------------------------------------------
  /** GET ?q&phone&email&dob&originBranchId&lifecycleStage&intakeType&includeMerged&cursor → page, POST createPatientRequest */
  patients: () => p("/patients"),
  /** GET patientResponse, PATCH updatePatientRequest */
  patient: (patientId: string) => p(`/patients/${id(patientId)}`),
  /** POST duplicateCheckRequest → { matches } */
  duplicateCheck: () => p("/patients/duplicate-check"),
  /** POST { stage } (409 when the transition is not allowed) */
  patientLifecycle: (patientId: string) => p(`/patients/${id(patientId)}/lifecycle`),
  /** POST verifyIdentityRequest */
  patientIdentity: (patientId: string) => p(`/patients/${id(patientId)}/identity-verification`),
  /** GET → merge records involving this patient */
  patientMerges: (patientId: string) => p(`/patients/${id(patientId)}/merges`),
  /** GET → { items } (newest first), POST addMedicalHistoryRequest */
  medicalHistory: (patientId: string) => p(`/patients/${id(patientId)}/medical-history`),
  /** GET ?includeResolved → { items }, POST addAllergyRequest */
  allergies: (patientId: string) => p(`/patients/${id(patientId)}/allergies`),
  /** POST resolveRequest */
  allergyResolve: (patientId: string, allergyId: string) =>
    p(`/patients/${id(patientId)}/allergies/${id(allergyId)}/resolve`),
  /** GET ?includeResolved → { items }, POST addAlertRequest */
  alerts: (patientId: string) => p(`/patients/${id(patientId)}/alerts`),
  /** POST resolveRequest */
  alertResolve: (patientId: string, alertId: string) =>
    p(`/patients/${id(patientId)}/alerts/${id(alertId)}/resolve`),
  /** GET → { items }, POST recordConsentRequest */
  consents: (patientId: string) => p(`/patients/${id(patientId)}/consents`),
  /** POST withdrawConsentRequest */
  consentWithdraw: (patientId: string, consentId: string) =>
    p(`/patients/${id(patientId)}/consents/${id(consentId)}/withdraw`),
  /** GET → { items }, PUT setCommunicationPreferencesRequest */
  communicationPreferences: (patientId: string) =>
    p(`/patients/${id(patientId)}/communication-preferences`),

  // ---- Enquiries ---------------------------------------------------------------------------
  /** GET ?status&branchId&q&cursor → page(enquiry), POST createEnquiryRequest */
  enquiries: () => p("/enquiries"),
  /** GET, PATCH updateEnquiryRequest */
  enquiry: (enquiryId: string) => p(`/enquiries/${id(enquiryId)}`),
  /** POST { existingPatientId } | createPatientRequest → patientResponse */
  enquiryConvert: (enquiryId: string) => p(`/enquiries/${id(enquiryId)}/convert`),

  // ---- Duplicates & merge ------------------------------------------------------------------
  /** GET ?status&cursor → page(duplicateCandidate) */
  duplicates: () => p("/duplicate-candidates"),
  /** POST dismissDuplicateRequest */
  duplicateDismiss: (candidateId: string) => p(`/duplicate-candidates/${id(candidateId)}/dismiss`),
  /** GET ?survivorId&mergedId → preview */
  mergePreview: () => p("/patient-merges/preview"),
  /** POST mergePatientsRequest + fieldChoices (step-up: 401 reauth_required) */
  patientMerge: () => p("/patient-merges"),

  // ---- Documents (not nested under patients) -----------------------------------------------
  /** GET ?patientId&category&branchId&cursor&limit → page(document) */
  documents: () => p("/documents"),
  /** POST requestUploadRequest → requestUploadResponse (presigned URL) */
  documentUploads: () => p("/documents/uploads"),
  /** GET documentResponse */
  document: (documentId: string) => p(`/documents/${id(documentId)}`),
  /** POST confirmUploadRequest → documentResponse */
  documentConfirm: (documentId: string) => p(`/documents/${id(documentId)}/confirm`),
  /** GET → downloadUrlResponse */
  documentDownload: (documentId: string) => p(`/documents/${id(documentId)}/download-url`),
  /** POST deleteDocumentRequest (soft delete) */
  documentDelete: (documentId: string) => p(`/documents/${id(documentId)}/delete`),
} as const;

export type RouteName = keyof typeof routes;

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Joins base URL + path + query. Undefined/null/empty-string values are dropped so optional filters
 * never reach the server as "undefined"; booleans become "true"/"false" (zod `stringbool`).
 */
export function buildUrl(base: string, path: string, query?: Record<string, QueryValue>): string {
  const trimmed = base.replace(/\/+$/, "");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return `${trimmed}${path}${s ? `?${s}` : ""}`;
}
