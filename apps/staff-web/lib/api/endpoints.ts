import {
  type AddAlertRequest,
  type AddAllergyRequest,
  type AddMedicalHistoryRequest,
  type AlertResponse,
  type AllergyResponse,
  type AssignDentistRequest,
  type BranchResponse,
  type ConsentResponse,
  type CreateBranchRequest,
  type CreateEnquiryRequest,
  type CreateInvitationRequest,
  type CreatePatientRequest,
  type CreateServiceCategoryRequest,
  type CreateServiceRequest,
  type DentistAssignmentResponse,
  type DocumentResponse,
  type DuplicateCandidateResponse,
  type DuplicateCheckRequest,
  type DuplicateCheckResponse,
  type EnquiryResponse,
  type InvitationResponse,
  type MedicalHistoryResponse,
  type MergeRecordResponse,
  type PatientResponse,
  type PatientSummary,
  type PriceOverrideResponse,
  type RecordConsentRequest,
  type RequestUploadRequest,
  type RequestUploadResponse,
  type ServiceCategoryResponse,
  type ServiceResponse,
  type SetCommunicationPreferencesRequest,
  type SetPriceOverrideRequest,
  type StaffMemberResponse,
  type TenantResponse,
  type TransferDentistRequest,
  type UpdateBranchRequest,
  type UpdateEnquiryRequest,
  type UpdateMembershipRequest,
  type UpdatePatientRequest,
  type UpdateServiceCategoryRequest,
  type UpdateServiceRequest,
  type UpdateTenantRequest,
  type VerifyIdentityRequest,
  branchResponse,
  duplicateCheckResponse,
  page,
  patientResponse,
  patientSummary,
  serviceResponse,
  tenantResponse,
  z,
} from "@dentalos/validation";
import { type ApiClient, apiClient } from "./client";
import { routes } from "./routes";
import type {
  CommunicationPreference,
  ConvertEnquiryRequest,
  CreatedInvitation,
  Items,
  MergeRequest,
  OnboardingResponse,
  Page,
  PatientSearch,
  PatientWithDuplicates,
  PriceListResponse,
} from "./types";

const items = <T extends z.ZodType>(s: T) => z.object({ items: z.array(s) });

/** Typed API surface. One function per endpoint; screens never build paths themselves. */
export function createApi(c: ApiClient) {
  const get = <T>(path: string, query?: Record<string, unknown>, schema?: z.ZodType<T>) =>
    c.request<T>("GET", path, { query: query as Record<string, string>, schema });
  const send = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    c.request<T>(method, path, { body: body ?? {} });

  return {
    org: {
      get: () => get<TenantResponse>(routes.org(), undefined, tenantResponse),
      update: (b: UpdateTenantRequest) => send<TenantResponse>("PATCH", routes.org(), b),
      onboarding: () => get<OnboardingResponse>(routes.orgOnboarding()),
    },
    branches: {
      list: (q: { active?: boolean } = {}) =>
        get<Items<BranchResponse>>(routes.branches(), q, items(branchResponse)),
      get: (id: string) => get<BranchResponse>(routes.branch(id), undefined, branchResponse),
      create: (b: CreateBranchRequest) => send<BranchResponse>("POST", routes.branches(), b),
      update: (id: string, b: UpdateBranchRequest) =>
        send<BranchResponse>("PATCH", routes.branch(id), b),
      setActive: (id: string, active: boolean) =>
        send<BranchResponse>(
          "POST",
          active ? routes.branchActivate(id) : routes.branchDeactivate(id),
        ),
    },
    staff: {
      list: (q: { role?: string; branchId?: string } = {}) =>
        get<Items<StaffMemberResponse>>(routes.staff(), q),
      update: (id: string, b: UpdateMembershipRequest) =>
        send<StaffMemberResponse>("PATCH", routes.staffMember(id), b),
    },
    invitations: {
      list: (q: { status?: string } = {}) =>
        get<Items<InvitationResponse>>(routes.invitations(), q),
      create: (b: CreateInvitationRequest) =>
        send<CreatedInvitation>("POST", routes.invitations(), b),
      revoke: (id: string) => send<InvitationResponse>("POST", routes.invitationRevoke(id)),
      resend: (id: string, expiresInDays = 7) =>
        send<CreatedInvitation>("POST", routes.invitationResend(id), { expiresInDays }),
    },
    dentists: {
      list: (q: { userId?: string; branchId?: string; status?: "current" | "all" } = {}) =>
        get<Items<DentistAssignmentResponse>>(routes.dentistAssignments(), q),
      assign: (b: AssignDentistRequest) =>
        send<DentistAssignmentResponse>("POST", routes.dentistAssignments(), b),
      transfer: (b: TransferDentistRequest) =>
        send<{ closed: DentistAssignmentResponse; opened: DentistAssignmentResponse }>(
          "POST",
          routes.dentistTransfer(),
          b,
        ),
      end: (id: string, effectiveTo: string) =>
        send<DentistAssignmentResponse>("POST", routes.dentistAssignmentEnd(id), { effectiveTo }),
    },
    catalog: {
      categories: () => get<Items<ServiceCategoryResponse>>(routes.catalogCategories()),
      createCategory: (b: CreateServiceCategoryRequest) =>
        send<ServiceCategoryResponse>("POST", routes.catalogCategories(), b),
      updateCategory: (id: string, b: UpdateServiceCategoryRequest) =>
        send<ServiceCategoryResponse>("PATCH", routes.catalogCategory(id), b),
      deleteCategory: (id: string) => c.request<void>("DELETE", routes.catalogCategory(id)),
      services: (q: {
        q?: string;
        categoryId?: string;
        active?: boolean;
        branchId?: string;
        cursor?: string;
        limit?: number;
      }) => get<Page<ServiceResponse>>(routes.catalogServices(), q, page(serviceResponse)),
      createService: (b: CreateServiceRequest) =>
        send<ServiceResponse>("POST", routes.catalogServices(), b),
      updateService: (id: string, b: UpdateServiceRequest) =>
        send<ServiceResponse>("PATCH", routes.catalogService(id), b),
      setServiceActive: (id: string, active: boolean) =>
        send<ServiceResponse>(
          "POST",
          active ? routes.catalogServiceActivate(id) : routes.catalogServiceDeactivate(id),
        ),
      priceList: (branchId: string) =>
        get<PriceListResponse>(routes.branchPriceList(), { branchId }),
      overrideHistory: (serviceId: string, branchId?: string) =>
        get<Items<PriceOverrideResponse>>(routes.priceOverrides(serviceId), { branchId }),
      setOverride: (serviceId: string, b: SetPriceOverrideRequest) =>
        send<PriceOverrideResponse>("PUT", routes.priceOverrides(serviceId), b),
      clearOverride: (serviceId: string, b: { branchId: string; reason: string }) =>
        send<unknown>("POST", routes.priceOverrideClear(serviceId), b),
    },
    patients: {
      search: (q: PatientSearch) =>
        get<Page<PatientSummary>>(routes.patients(), { ...q }, page(patientSummary)),
      get: (id: string) => get<PatientResponse>(routes.patient(id), undefined, patientResponse),
      create: (b: CreatePatientRequest) =>
        send<PatientWithDuplicates>("POST", routes.patients(), b),
      update: (id: string, b: UpdatePatientRequest) =>
        send<PatientWithDuplicates>("PATCH", routes.patient(id), b),
      setLifecycle: (id: string, stage: string) =>
        send<PatientResponse>("POST", routes.patientLifecycle(id), { stage }),
      verifyIdentity: (id: string, b: VerifyIdentityRequest) =>
        send<PatientResponse>("POST", routes.patientIdentity(id), b),
      merges: (id: string) => get<Items<MergeRecordResponse>>(routes.patientMerges(id)),
      duplicateCheck: (b: DuplicateCheckRequest) =>
        c.request<DuplicateCheckResponse>("POST", routes.duplicateCheck(), {
          body: b,
          schema: duplicateCheckResponse,
        }),
      merge: (b: MergeRequest) => send<MergeRecordResponse>("POST", routes.patientMerge(), b),
      mergePreview: (survivorId: string, mergedId: string) =>
        get<unknown>(routes.mergePreview(), { survivorId, mergedId }),
      // API returns { latest, versions } (newest first); screens consume the common Items shape.
      medicalHistory: async (id: string): Promise<Items<MedicalHistoryResponse>> => {
        const r = await get<{
          latest: MedicalHistoryResponse | null;
          versions: MedicalHistoryResponse[];
        }>(routes.medicalHistory(id));
        return { items: r.versions };
      },
      addMedicalHistory: (id: string, b: AddMedicalHistoryRequest) =>
        send<MedicalHistoryResponse>("POST", routes.medicalHistory(id), b),
      allergies: (id: string, includeResolved = true) =>
        get<Items<AllergyResponse>>(routes.allergies(id), { includeResolved }),
      addAllergy: (id: string, b: AddAllergyRequest) =>
        send<AllergyResponse>("POST", routes.allergies(id), b),
      resolveAllergy: (id: string, allergyId: string, reason?: string) =>
        send<AllergyResponse>("POST", routes.allergyResolve(id, allergyId), { reason }),
      alerts: (id: string, includeResolved = true) =>
        get<Items<AlertResponse>>(routes.alerts(id), { includeResolved }),
      addAlert: (id: string, b: AddAlertRequest) =>
        send<AlertResponse>("POST", routes.alerts(id), b),
      resolveAlert: (id: string, alertId: string, reason?: string) =>
        send<AlertResponse>("POST", routes.alertResolve(id, alertId), { reason }),
      consents: (id: string) => get<Items<ConsentResponse>>(routes.consents(id)),
      recordConsent: (id: string, b: RecordConsentRequest) =>
        send<ConsentResponse>("POST", routes.consents(id), b),
      withdrawConsent: (id: string, consentId: string, reason?: string) =>
        send<ConsentResponse>("POST", routes.consentWithdraw(id, consentId), { reason }),
      commPrefs: (id: string) =>
        get<Items<CommunicationPreference>>(routes.communicationPreferences(id)),
      setCommPrefs: (id: string, b: SetCommunicationPreferencesRequest) =>
        send<Items<CommunicationPreference>>("PUT", routes.communicationPreferences(id), b),
    },
    enquiries: {
      list: (q: { status?: string; branchId?: string; q?: string; cursor?: string }) =>
        get<Page<EnquiryResponse>>(routes.enquiries(), q),
      get: (id: string) => get<EnquiryResponse>(routes.enquiry(id)),
      create: (b: CreateEnquiryRequest) => send<EnquiryResponse>("POST", routes.enquiries(), b),
      update: (id: string, b: UpdateEnquiryRequest) =>
        send<EnquiryResponse>("PATCH", routes.enquiry(id), b),
      convert: (id: string, b: ConvertEnquiryRequest) =>
        send<PatientResponse>("POST", routes.enquiryConvert(id), b),
    },
    duplicates: {
      list: (q: { status?: string; cursor?: string } = {}) =>
        get<Page<DuplicateCandidateResponse>>(routes.duplicates(), q),
      dismiss: (id: string, reason: string) =>
        send<DuplicateCandidateResponse>("POST", routes.duplicateDismiss(id), { reason }),
    },
    documents: {
      list: (
        patientId: string,
        q: { category?: string; branchId?: string; cursor?: string } = {},
      ) => get<Page<DocumentResponse>>(routes.documents(), { patientId, ...q }),
      requestUpload: (b: RequestUploadRequest) =>
        send<RequestUploadResponse>("POST", routes.documentUploads(), b),
      confirm: (documentId: string, sha256?: string) =>
        send<DocumentResponse>("POST", routes.documentConfirm(documentId), { sha256 }),
      downloadUrl: (documentId: string) =>
        get<{ url: string; expiresInSeconds: number }>(routes.documentDownload(documentId)),
      remove: (documentId: string, reason: string) =>
        send<DocumentResponse>("POST", routes.documentDelete(documentId), { reason }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
export const api: Api = createApi(apiClient);
