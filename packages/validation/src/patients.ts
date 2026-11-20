import { z } from "zod";
import {
  address,
  countryCode,
  dateOnly,
  email,
  isoDateTime,
  optionalText,
  pageQuery,
  phone,
  trimmed,
  uuid,
} from "./common";

// Shared patient profile, intake, clinical background, consent and duplicates (PRD 2.4, 4.2).

export const SEXES = ["MALE", "FEMALE", "OTHER", "UNKNOWN"] as const;
export const PATIENT_LIFECYCLE_STAGES = [
  "REGISTERED",
  "ACTIVE",
  "IN_TREATMENT",
  "FOLLOW_UP",
  "RECALL",
  "INACTIVE",
] as const;
export const INTAKE_TYPES = ["APPOINTMENT", "WALK_IN", "URGENT", "ENQUIRY"] as const;
export const IDENTITY_VERIFICATION_METHODS = [
  "IN_PERSON_DOCUMENT",
  "OTP_PHONE",
  "OTP_EMAIL",
  "GUARDIAN",
] as const;
export const IDENTITY_DOCUMENT_TYPES = [
  "AADHAAR",
  "PAN",
  "PASSPORT",
  "DRIVING_LICENCE",
  "VOTER_ID",
  "OTHER",
] as const;
export const ENQUIRY_SOURCES = [
  "WALK_IN",
  "PHONE",
  "WEBSITE",
  "WHATSAPP",
  "REFERRAL",
  "SOCIAL",
  "CAMPAIGN",
  "OTHER",
] as const;
export const ENQUIRY_STATUSES = ["NEW", "CONTACTED", "CONVERTED", "LOST"] as const;
export const SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export const CONSENT_STATUSES = ["GRANTED", "DECLINED", "WITHDRAWN"] as const;
export const COMM_CHANNELS = ["SMS", "WHATSAPP", "EMAIL", "VOICE"] as const;
export const COMM_PURPOSES = ["TRANSACTIONAL", "REMINDER", "MARKETING"] as const;
export const DUPLICATE_STATUSES = ["PENDING", "DISMISSED", "MERGED"] as const;
/**
 * Consent catalogue (PRD 12.2 leaves the full list open; extend here, DB column is text).
 * M2 adds the template-backed clinical types of ADR 0003 (`CONSENT_TEMPLATE_TYPES` in plans.ts).
 */
export const CONSENT_TYPES = [
  "DATA_PROCESSING",
  "TREATMENT_GENERAL",
  "CLINICAL_PHOTOGRAPHY",
  "COMMUNICATION_MARKETING",
  "AI_TRANSCRIPTION",
  "TREATMENT_PLAN",
  "PROCEDURE",
  "RADIOGRAPH",
  "COMMUNICATION",
] as const;
/**
 * Clinical consent types that exist only as a signed template version (ADR 0003 §4): captured via
 * POST /patients/:id/consents/sign, never via the free-form M1 endpoint. Parity with the DB CHECK
 * `PatientConsent_template_link_chk` (TREATMENT_PLAN additionally needs a plan version).
 */
export const TEMPLATE_ONLY_CONSENT_TYPES = [
  "TREATMENT_PLAN",
  "PROCEDURE",
  "RADIOGRAPH",
  "COMMUNICATION",
] as const satisfies readonly (typeof CONSENT_TYPES)[number][];
/** Types the free-form M1 endpoint (`recordConsentRequest`) accepts. */
export const RECORDABLE_CONSENT_TYPES = CONSENT_TYPES.filter(
  (t): t is Exclude<(typeof CONSENT_TYPES)[number], (typeof TEMPLATE_ONLY_CONSENT_TYPES)[number]> =>
    !(TEMPLATE_ONLY_CONSENT_TYPES as readonly string[]).includes(t),
);
export const CONSENT_METHODS = ["DIGITAL", "PAPER", "VERBAL"] as const;

export const sex = z.enum(SEXES);
export const lifecycleStage = z.enum(PATIENT_LIFECYCLE_STAGES);
export const intakeType = z.enum(INTAKE_TYPES);
export const severity = z.enum(SEVERITIES);

/** Past date, not more than 130 years ago. */
const dob = dateOnly.refine((d) => {
  const t = Date.parse(d);
  return t <= Date.now() && t >= Date.now() - 130 * 365.25 * 86_400_000;
}, "Implausible date of birth");

// ---------------------------------------------------------------------------------------------
// Patient profile
// ---------------------------------------------------------------------------------------------

const patientFields = address.extend({
  firstName: trimmed(100),
  middleName: optionalText(100),
  lastName: optionalText(100),
  preferredName: optionalText(100),
  dob: dob.optional(),
  sex: sex.default("UNKNOWN"),
  phone: phone.optional(),
  altPhone: phone.optional(),
  email: email.optional(),
});

export const createPatientRequest = patientFields.extend({
  /** Registering branch; must be in the caller's branch scope. Immutable afterwards. */
  originBranchId: uuid,
  intakeType,
  /** Converting an enquiry: links PatientEnquiry.convertedPatientId. */
  enquiryId: uuid.optional(),
  /** Skip the duplicate warning after the user reviewed candidates (still recorded in audit). */
  acknowledgeDuplicates: z.boolean().default(false),
});
export type CreatePatientRequest = z.infer<typeof createPatientRequest>;

/** PATCH: defaults stripped so absent keys stay absent (a PATCH of `{ city }` must not reset sex/country). */
export const updatePatientRequest = patientFields.partial().extend({
  sex: sex.optional(),
  country: countryCode.optional(),
  lifecycleStage: lifecycleStage.optional(),
});
export type UpdatePatientRequest = z.infer<typeof updatePatientRequest>;

/** POST /patients/:id/lifecycle — only transitions allowed by the API's lifecycle table succeed (409 otherwise). */
export const lifecycleTransitionRequest = z.object({ stage: lifecycleStage });
export type LifecycleTransitionRequest = z.infer<typeof lifecycleTransitionRequest>;

export const verifyIdentityRequest = z.object({
  method: z.enum(IDENTITY_VERIFICATION_METHODS),
  documentType: z.enum(IDENTITY_DOCUMENT_TYPES).optional(),
  /** Never send or store full government id numbers (Aadhaar etc.). */
  documentLast4: z
    .string()
    .regex(/^[A-Za-z0-9]{1,4}$/)
    .optional(),
});
export type VerifyIdentityRequest = z.infer<typeof verifyIdentityRequest>;

export const searchPatientsQuery = pageQuery.extend({
  /** Free text: name (trigram), phone digits, email or MRN. */
  q: z.string().trim().min(1).max(100).optional(),
  phone: phone.optional(),
  dob: dateOnly.optional(),
  originBranchId: uuid.optional(),
  lifecycleStage: lifecycleStage.optional(),
  intakeType: intakeType.optional(),
  /** Exact (normalised) email match. */
  email: email.optional(),
  includeMerged: z.stringbool().default(false),
});
export type SearchPatientsQuery = z.infer<typeof searchPatientsQuery>;

export const patientSummary = z.object({
  id: uuid,
  mrn: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  preferredName: z.string().nullable(),
  dob: dateOnly.nullable(),
  sex,
  phone: z.string().nullable(),
  originBranchId: uuid,
  lifecycleStage,
  mergedIntoId: uuid.nullable(),
});
export type PatientSummary = z.infer<typeof patientSummary>;

export const patientResponse = patientSummary.extend({
  middleName: z.string().nullable(),
  altPhone: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  intakeType,
  identityVerifiedAt: isoDateTime.nullable(),
  identityVerificationMethod: z.enum(IDENTITY_VERIFICATION_METHODS).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PatientResponse = z.infer<typeof patientResponse>;

// ---------------------------------------------------------------------------------------------
// Enquiries (leads)
// ---------------------------------------------------------------------------------------------

export const createEnquiryRequest = z
  .object({
    branchId: uuid.optional(),
    name: trimmed(160),
    phone: phone.optional(),
    email: email.optional(),
    source: z.enum(ENQUIRY_SOURCES),
    areaOfInterest: optionalText(200),
    notes: optionalText(2000),
  })
  .refine((v) => v.phone !== undefined || v.email !== undefined, {
    message: "Phone or email required",
    path: ["phone"],
  });
export type CreateEnquiryRequest = z.infer<typeof createEnquiryRequest>;

export const updateEnquiryRequest = z.object({
  status: z.enum(ENQUIRY_STATUSES).exclude(["CONVERTED"]).optional(),
  areaOfInterest: optionalText(200),
  notes: optionalText(2000),
});
export type UpdateEnquiryRequest = z.infer<typeof updateEnquiryRequest>;

/** Convert an enquiry either into a new patient (profile fields) or by linking an existing one. */
export const convertEnquiryRequest = z.union([
  z.strictObject({ existingPatientId: uuid }),
  createPatientRequest
    .omit({ enquiryId: true })
    .extend({ intakeType: intakeType.default("ENQUIRY") }),
]);
export type ConvertEnquiryRequest = z.infer<typeof convertEnquiryRequest>;

export const listEnquiriesQuery = pageQuery.extend({
  status: z.enum(ENQUIRY_STATUSES).optional(),
  branchId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListEnquiriesQuery = z.infer<typeof listEnquiriesQuery>;

export const enquiryResponse = z.object({
  id: uuid,
  branchId: uuid.nullable(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  source: z.enum(ENQUIRY_SOURCES),
  areaOfInterest: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.enum(ENQUIRY_STATUSES),
  convertedPatientId: uuid.nullable(),
  createdAt: isoDateTime,
});
export type EnquiryResponse = z.infer<typeof enquiryResponse>;

// ---------------------------------------------------------------------------------------------
// Medical / dental history (append-only versions), allergies, clinical alerts
// ---------------------------------------------------------------------------------------------

export const medication = z.object({
  name: trimmed(160),
  dose: optionalText(80),
  frequency: optionalText(80),
});

/** Structured questionnaire answers; keys are form-defined. Values are small scalars or string lists. */
const answers = z.record(
  z.string().max(64),
  z.union([z.boolean(), z.string().max(2000), z.number(), z.array(z.string().max(200)).max(50)]),
);

/** Creates version N+1; previous versions are immutable. */
export const addMedicalHistoryRequest = z.object({
  branchId: uuid.optional(),
  medical: answers.default({}),
  dental: answers.default({}),
  medications: z.array(medication).max(50).default([]),
  notes: optionalText(4000),
});
export type AddMedicalHistoryRequest = z.infer<typeof addMedicalHistoryRequest>;

export const medicalHistoryResponse = z.object({
  id: uuid,
  patientId: uuid,
  version: z.number().int(),
  medical: answers,
  dental: answers,
  medications: z.array(medication),
  notes: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: isoDateTime,
});
export type MedicalHistoryResponse = z.infer<typeof medicalHistoryResponse>;

export const addAllergyRequest = z.object({
  substance: trimmed(160),
  reaction: optionalText(500),
  severity: severity.default("MODERATE"),
});
export type AddAllergyRequest = z.infer<typeof addAllergyRequest>;

export const allergyResponse = z.object({
  id: uuid,
  substance: z.string(),
  reaction: z.string().nullable(),
  severity,
  active: z.boolean(),
  notedBy: z.string(),
  notedAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  /** Stored since 0005; optional until the API returns it. */
  resolutionReason: z.string().nullable().optional(),
});
export type AllergyResponse = z.infer<typeof allergyResponse>;

export const addAlertRequest = z.object({
  title: trimmed(160),
  details: optionalText(2000),
  severity,
});
export type AddAlertRequest = z.infer<typeof addAlertRequest>;

export const alertResponse = z.object({
  id: uuid,
  title: z.string(),
  details: z.string().nullable(),
  severity,
  active: z.boolean(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  resolvedAt: isoDateTime.nullable(),
  /** Stored since 0005; optional until the API returns it. */
  resolutionReason: z.string().nullable().optional(),
});
export type AlertResponse = z.infer<typeof alertResponse>;

/** Allergies and alerts are resolved (deactivated), never deleted. `reason` is stored as resolutionReason. */
export const resolveRequest = z.object({ reason: optionalText(500) });

/** GET allergies / alerts: active only unless `includeResolved=true`. */
export const includeResolvedQuery = z.object({ includeResolved: z.stringbool().default(false) });
export type IncludeResolvedQuery = z.infer<typeof includeResolvedQuery>;

// ---------------------------------------------------------------------------------------------
// Consent & communication preferences
// ---------------------------------------------------------------------------------------------

/** Free-form (M1) consent. Template-only clinical types go through `signConsentRequest`. */
export const recordConsentRequest = z.object({
  type: z.enum(CONSENT_TYPES).exclude([...TEMPLATE_ONLY_CONSENT_TYPES]),
  version: trimmed(32),
  status: z.enum(CONSENT_STATUSES).exclude(["WITHDRAWN"]),
  method: z.enum(CONSENT_METHODS),
  branchId: uuid.optional(),
  /** Signed form stored as a PatientDocument. */
  documentId: uuid.optional(),
});
export type RecordConsentRequest = z.infer<typeof recordConsentRequest>;

/** `reason` is stored as PatientConsent.withdrawalReason. */
export const withdrawConsentRequest = z.object({ reason: optionalText(500) });

export const consentResponse = z.object({
  id: uuid,
  type: z.string(),
  version: z.string(),
  status: z.enum(CONSENT_STATUSES),
  method: z.string().nullable(),
  /** Branch the consent was captured at (always returned by the API; optional for older fixtures). */
  branchId: uuid.nullable().optional(),
  documentId: uuid.nullable(),
  capturedBy: z.string(),
  grantedAt: isoDateTime.nullable(),
  withdrawnAt: isoDateTime.nullable(),
  /** Stored since 0005; optional until the API returns it. */
  withdrawalReason: z.string().nullable().optional(),
});
export type ConsentResponse = z.infer<typeof consentResponse>;

export const communicationPreference = z.object({
  channel: z.enum(COMM_CHANNELS),
  purpose: z.enum(COMM_PURPOSES).default("TRANSACTIONAL"),
  optIn: z.boolean(),
});
export const setCommunicationPreferencesRequest = z.object({
  preferences: z.array(communicationPreference).min(1).max(12),
});
export type SetCommunicationPreferencesRequest = z.infer<typeof setCommunicationPreferencesRequest>;

// ---------------------------------------------------------------------------------------------
// Duplicate detection & controlled merge (never automatic — PRD 4.2)
// ---------------------------------------------------------------------------------------------

export const duplicateCheckRequest = z.object({
  firstName: trimmed(100),
  lastName: optionalText(100),
  dob: dateOnly.optional(),
  phone: phone.optional(),
  email: email.optional(),
  /** Exclude this patient (editing an existing record). */
  excludePatientId: uuid.optional(),
  /** Respond 409 `possible_duplicates` when likely matches exist (otherwise the check never blocks). */
  failOnMatch: z.boolean().optional(),
});
export type DuplicateCheckRequest = z.infer<typeof duplicateCheckRequest>;

export const DUPLICATE_REASONS = [
  "PHONE_EXACT",
  "EMAIL_EXACT",
  "NAME_SIMILAR",
  "NAME_EXACT",
  "DOB_EXACT",
] as const;
export const duplicateMatch = z.object({
  patient: patientSummary,
  /** 0–100. */
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.enum(DUPLICATE_REASONS)),
});
export const duplicateCheckResponse = z.object({ matches: z.array(duplicateMatch) });
export type DuplicateCheckResponse = z.infer<typeof duplicateCheckResponse>;

export const listDuplicateCandidatesQuery = pageQuery.extend({
  status: z.enum(DUPLICATE_STATUSES).default("PENDING"),
});

export const duplicateCandidateResponse = z.object({
  id: uuid,
  patientA: patientSummary,
  patientB: patientSummary,
  score: z.number().int(),
  reasons: z.array(z.enum(DUPLICATE_REASONS)),
  status: z.enum(DUPLICATE_STATUSES),
  reviewedBy: z.string().nullable(),
  reviewedAt: isoDateTime.nullable(),
  /** Stored since 0005; optional until the API returns it. */
  reviewReason: z.string().nullable().optional(),
  createdAt: isoDateTime,
});
export type DuplicateCandidateResponse = z.infer<typeof duplicateCandidateResponse>;

/** `reason` is stored as DuplicateCandidate.reviewReason. */
export const dismissDuplicateRequest = z.object({ reason: trimmed(500) });

/** Profile fields a merge may take from either record. Ids, lifecycle, intake and identity stay with the survivor. */
export const MERGEABLE_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "preferredName",
  "dob",
  "sex",
  "phone",
  "altPhone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;
export type MergeableField = (typeof MERGEABLE_FIELDS)[number];
/** Per-field value source for a merge; omitted fields keep the survivor's value. */
export const mergeFieldChoices = z.partialRecord(
  z.enum(MERGEABLE_FIELDS),
  z.enum(["survivor", "merged"]),
);
export type MergeFieldChoices = z.infer<typeof mergeFieldChoices>;

/** Requires a recent interactive sign-in (step-up, 401 `reauth_required`). */
export const mergePatientsRequest = z
  .object({
    survivorId: uuid,
    mergedId: uuid,
    duplicateCandidateId: uuid.optional(),
    reason: trimmed(500).min(5),
    fieldChoices: mergeFieldChoices.optional(),
  })
  .refine((v) => v.survivorId !== v.mergedId, {
    message: "Cannot merge a patient into itself",
    path: ["mergedId"],
  });
export type MergePatientsRequest = z.infer<typeof mergePatientsRequest>;

export const mergePreviewQuery = z
  .object({ survivorId: uuid, mergedId: uuid })
  .refine((v) => v.survivorId !== v.mergedId, {
    message: "Cannot merge a patient into itself",
    path: ["mergedId"],
  });
export type MergePreviewQuery = z.infer<typeof mergePreviewQuery>;

export const mergeRecordResponse = z.object({
  id: uuid,
  survivorId: uuid,
  mergedId: uuid,
  performedBy: z.string(),
  approvedBy: z.string().nullable(),
  reason: z.string(),
  createdAt: isoDateTime,
});
export type MergeRecordResponse = z.infer<typeof mergeRecordResponse>;
