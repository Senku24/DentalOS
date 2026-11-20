import { ApiError, asApiError } from "./errors";

/**
 * Friendly copy for the M2 clinical / plan / consent error codes (ADR 0003 + Wave 1 addendum).
 * The frozen `errors.ts` only knows M1 codes, so the clinical client re-labels its errors here;
 * screens keep using `err.message` / `err.fieldErrors` as everywhere else.
 */

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const human = (v: unknown) => (str(v) ?? "").replace(/_/g, " ").toLowerCase();

const INVALID_PLAN_ITEM: Record<string, string> = {
  not_found: "That plan item isn't available for this patient.",
  plan_closed: "That plan is completed or cancelled, so work can't be recorded against it.",
  item_not_startable:
    "Only accepted, scheduled or in-progress plan items can be linked to a procedure.",
};

export const CLINICAL_ERROR_MESSAGES: Record<string, string | ((b: Body) => string)> = {
  // Encounters & notes
  encounter_signed:
    "This encounter is signed and can no longer be changed. Add an amendment to correct it.",
  encounter_not_signed: "Amendments can only be added after the encounter is signed.",
  not_treating_dentist: "Only the treating dentist can do this for the encounter.",
  not_author: "Only the clinician who recorded this entry can change it.",
  encounter_exists: "This appointment already has an encounter.",
  appointment_not_active: (b) =>
    `The appointment is ${human(b.status) || "not active"}, so an encounter can't be opened from it.`,
  appointment_patient_mismatch: "The appointment belongs to a different patient.",
  appointment_branch_mismatch: "The appointment is at a different branch.",
  dentist_not_in_branch: "That dentist can't sign clinical records at this branch.",
  not_a_member: "That person is not a member of this organisation.",
  not_a_dentist: "This staff member does not have the Dentist role.",
  note_not_found: "That note no longer exists.",
  invalid_initial_status: "A new procedure must be in progress or completed.",
  procedure_linked_to_plan:
    "This completed procedure is the only record of progress on its plan item, so it can't be deleted.",
  service_not_found: "That service is not in the catalogue.",
  service_inactive: "That service is inactive in the catalogue.",
  invalid_plan_item: (b) =>
    INVALID_PLAN_ITEM[str(b.reason) ?? ""] ?? "That plan item can't be linked to this procedure.",
  // Odontogram
  tooth_record_not_current: "That chart entry was already replaced. Refresh the chart.",
  tooth_record_immutable: "Chart history can't be changed.",
  tooth_record_not_found: "That chart entry no longer exists.",
  supersede_tooth_mismatch: "A replacement must be for the same tooth.",
  duplicate_supersedes: "The same chart entry was replaced twice.",
  encounter_patient_mismatch: "That encounter belongs to a different patient.",
  // Attachments
  document_not_available: "That document hasn't finished uploading or was deleted.",
  document_already_attached: "That document is already attached to another encounter.",
  document_patient_mismatch: "That document belongs to a different patient.",
  document_not_attached: "That document isn't attached to this encounter.",
  document_not_found: "That document no longer exists.",
  // Plans
  consent_required: (b) =>
    `The patient must sign the treatment-plan consent for the current version${
      num(b.version) ? ` (v${num(b.version)})` : ""
    } before the plan can be approved.`,
  item_still_scheduled:
    "This item still has a booked appointment. Cancel or move the appointment first.",
  item_has_scheduled_sessions:
    "This item still has scheduled sessions. Complete or cancel them before completing the item.",
  item_not_editable: (b) =>
    `Only proposed or deferred items can be edited (this one is ${human(b.status) || "decided"}).`,
  item_not_schedulable: "Sessions can only be planned for accepted items that aren't finished.",
  plan_item_history:
    "Items of a plan that has been presented are kept for history; cancel instead.",
  plan_empty: "Add at least one item before presenting the plan.",
  nothing_to_present: "There is nothing new to present.",
  plan_not_decided: "The patient must accept at least one item before the plan can be approved.",
  already_approved: "This version of the plan is already approved.",
  plan_closed: "This plan is completed or cancelled.",
  plan_not_presented: "Present the plan to the patient first.",
  plan_version_not_current: "The plan changed since this version. Use the latest version.",
  plan_version_not_found: "That plan version no longer exists.",
  plan_version_patient_mismatch: "That plan belongs to a different patient.",
  reorder_mismatch: "The plan changed while you were reordering. Refresh and try again.",
  concurrent_edit: "Someone else changed this plan at the same time. Refresh and try again.",
  concurrent_plan_edit: "Someone else changed this plan at the same time. Refresh and try again.",
  link_patient_mismatch: "That record belongs to a different patient.",
  appointment_linked_elsewhere: "That appointment is already linked to another plan item.",
  session_no_taken: "That session number is already used.",
  session_closed: "That session is already completed or cancelled.",
  session_status_server_derived: "Session status follows its appointment and encounter.",
  // Consent
  template_inactive: "That consent template is inactive.",
  template_version_outdated: "A newer version of this consent text exists. Reload the template.",
  template_version_not_found: "That consent version no longer exists.",
  invalid_signature_document: (b) =>
    str(b.reason) === "not_consent_form"
      ? "The signature must be uploaded as a Consent form document."
      : "The signature document hasn't finished uploading.",
  // Shared
  invalid_transition: (b) =>
    str(b.from) && str(b.to)
      ? `Can't move from ${human(b.from)} to ${human(b.to)}.`
      : "That status change isn't allowed.",
  branch_not_found: "That branch no longer exists.",
};

/** Copy for a known code (undefined for codes this module does not own). */
export function clinicalErrorMessage(
  code: string | undefined,
  body: Body = {},
): string | undefined {
  if (!code) return undefined;
  const m = CLINICAL_ERROR_MESSAGES[code];
  return typeof m === "function" ? m(body) : m;
}

/**
 * Re-labels an ApiError with clinical copy and maps `{ field }` codes (dentist_not_in_branch,
 * invalid_plan_item, appointment_linked_elsewhere…) onto `fieldErrors` so forms show them inline.
 */
export function withClinicalMessage(e: unknown): ApiError {
  const err = asApiError(e);
  const message = clinicalErrorMessage(err.code, err.body);
  if (!message) return err;
  const field = str(err.body.field);
  const fieldErrors =
    field && err.kind === "validation" && !(field in err.fieldErrors)
      ? { ...err.fieldErrors, [field]: message }
      : err.fieldErrors;
  return new ApiError({
    kind: err.kind,
    status: err.status,
    message,
    code: err.code,
    fieldErrors,
    body: err.body,
  });
}
