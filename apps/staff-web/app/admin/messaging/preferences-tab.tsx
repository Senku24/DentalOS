"use client";
import { Alert, Badge, Button, SelectField } from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PURPOSES,
  type NotificationChannel,
  type NotificationPurpose,
  type PatientSummary,
  type PreferenceCheckResponse,
} from "@dentalos/validation";
import { useState } from "react";
import { Section } from "../../../components/common";
import { PatientPicker } from "../../../components/scheduling/patient-picker";
import { asApiError } from "../../../lib/api/errors";
import { useMutation } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import { channelLabel, consentReason, purposeLabel } from "../../../lib/api/notifications-labels";
import { patientName } from "../../../lib/format";

/** "Would this send?" for a patient, channel and purpose, using the same consent resolver as the send job. */
export function PreferencesTab() {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [channel, setChannel] = useState<NotificationChannel>("WHATSAPP");
  const [purpose, setPurpose] = useState<NotificationPurpose>("REMINDER");
  const [result, setResult] = useState<PreferenceCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useMutation(
    () => {
      if (!patient) throw new Error("Pick a patient first.");
      return nApi.checkPreferences({ patientId: patient.id, channel, purpose });
    },
    {
      onSuccess: (r) => {
        setResult(r);
        setError(null);
      },
      onError: (e) => {
        setResult(null);
        setError(asApiError(e).message);
      },
    },
  );

  const stale = (r: PreferenceCheckResponse) =>
    !patient || r.patientId !== patient.id || r.channel !== channel || r.purpose !== purpose;

  return (
    <Section
      title="Preferences check"
      description="See whether a message would reach a patient, and why. Rules: an opt-out of transactional messages blocks the whole channel; a marketing opt-out never blocks appointment or billing messages; marketing is never implied."
    >
      <form
        className="dos-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (patient) void check.run();
        }}
        noValidate
      >
        <PatientPicker
          value={patient}
          onChange={(p) => {
            setPatient(p);
            setResult(null);
            setError(null);
          }}
        />
        <div className="dos-form-grid">
          <SelectField
            label="Channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as NotificationChannel)}
          >
            {NOTIFICATION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as NotificationPurpose)}
          >
            {NOTIFICATION_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {purposeLabel(p)}
              </option>
            ))}
          </SelectField>
        </div>
        <div>
          <Button type="submit" disabled={!patient} loading={check.pending}>
            Check
          </Button>
        </div>
      </form>
      <div aria-live="polite" className="dos-stack">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <div className="dos-card dos-stack" data-gap="sm">
            {stale(result) ? (
              <Alert tone="info">Inputs changed since this result. Check again.</Alert>
            ) : null}
            <div className="dos-cluster">
              <Badge
                tone={
                  result.decision === "SEND"
                    ? "success"
                    : result.decision === "OPTED_OUT"
                      ? "neutral"
                      : "warning"
                }
              >
                {result.decision === "SEND"
                  ? "Would send"
                  : result.decision === "OPTED_OUT"
                    ? "Opted out"
                    : "Skipped: no consent"}
              </Badge>
              <strong>
                {purposeLabel(result.purpose)} on {channelLabel(result.channel)}
                {patient ? ` for ${patientName(patient)}` : ""}
              </strong>
            </div>
            <p style={{ margin: 0 }}>{consentReason(result.reason)}</p>
            {result.decision === "SEND" && !result.hasAddress ? (
              <Alert tone="warning">
                Consent is fine, but the patient has no{" "}
                {result.channel === "EMAIL" ? "email" : "phone number"} on file, so the message
                would fail. Add one on the patient profile.
              </Alert>
            ) : null}
            {result.decision !== "SEND" ? (
              <p className="dos-hint" style={{ margin: 0 }}>
                Staff can record the patient's consent on their profile. If a message is still
                queued when consent changes, it is checked again at send time.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
