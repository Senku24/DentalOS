"use client";
import { Alert, Button, DescriptionList, SelectField, TextField } from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type OutboxResponse,
  type PatientSummary,
  renderTemplate,
} from "@dentalos/validation";
import { useEffect, useState } from "react";
import { Section } from "../../../components/common";
import { OutboxDrawer } from "../../../components/notifications/outbox-drawer";
import { OutboxStatusChip } from "../../../components/notifications/status-chip";
import { PatientPicker } from "../../../components/scheduling/patient-picker";
import { collectPages } from "../../../lib/api/clinical-client";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, asApiError } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import { channelLabel, consentReason, sampleFor } from "../../../lib/api/notifications-labels";
import { formatDateTime, patientName } from "../../../lib/format";

const MAX_POLLS = 30;

/**
 * Sends a template through the real pipeline (outbox + send job) to one address, using the console
 * provider. comms:templates only: the address is arbitrary, so this must never be a reception tool.
 * The API sends the template's CURRENT version; no patient consent applies to test sends.
 */
export function SendTestTab() {
  const [channel, setChannel] = useState<NotificationChannel>("SMS");
  const [templateId, setTemplateId] = useState("");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | undefined>();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; at: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const settings = useQuery(() => nApi.settings.get(), []);
  const enabled = settings.data?.effective.enabledChannels;
  const templates = useQuery(
    () =>
      collectPages((cursor) => nApi.templates.list({ channel, active: true, limit: 100, cursor })),
    [channel],
  );
  const tpl = templates.data?.find((t) => t.id === templateId) ?? templates.data?.[0];
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the choice when the channel's list changes
  useEffect(() => setTemplateId(""), [channel]);

  const placeholders = tpl?.latest?.placeholders ?? [];
  const patientFill = patient ? { patientName: patientName(patient) } : {};
  const values: Record<string, string> = Object.fromEntries(
    placeholders.map((p) => [
      p,
      overrides[p] ?? (patientFill as Record<string, string>)[p] ?? sampleFor(p),
    ]),
  );
  const preview = tpl?.latest ? renderTemplate(tpl.latest.body, values) : null;

  const pickPatient = async (p: PatientSummary | null) => {
    setPatient(p);
    setOverrides((o) => {
      const { patientName: _x, ...rest } = o;
      return rest;
    });
    if (!p) return;
    let to: string | null = p.phone;
    if (channel === "EMAIL") {
      try {
        to = (await api.patients.get(p.id)).email;
      } catch {
        to = null;
      }
    }
    if (to) {
      setAddress(to);
      setAddressError(undefined);
    } else {
      setAddressError(
        channel === "EMAIL"
          ? "This patient has no email on file."
          : "This patient has no phone on file.",
      );
    }
  };

  const send = useMutation(nApi.sendTest, {
    success: "Test message queued",
    onSuccess: (r) => setSent({ id: r.outboxId, at: Date.now() }),
    onError: (e: ApiError) => {
      if (e.fieldErrors.toAddress) setAddressError(e.fieldErrors.toAddress);
      else if (e.code === "address_invalid") setAddressError(e.message);
      else setFormError(e.message);
    },
  });

  const submit = () => {
    setFormError(null);
    setAddressError(undefined);
    if (!tpl) return setFormError("Pick a template first.");
    if (address.trim().length < 5)
      return setAddressError(
        channel === "EMAIL" ? "Enter an email address" : "Enter a 10-digit mobile number",
      );
    const vars = Object.fromEntries(
      Object.entries(values).filter(([, v]) => String(v).trim() !== ""),
    );
    void send.run({
      channel,
      templateCode: tpl.code,
      language: tpl.language,
      toAddress: address.trim(),
      variables: vars,
    });
  };

  return (
    <div className="dos-split">
      <Section
        title="Send a test message"
        description="Goes through the real queue and the console provider, which logs the message on the server instead of contacting a phone or inbox."
      >
        <form
          className="dos-stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {formError ? <Alert tone="danger">{formError}</Alert> : null}
          <div className="dos-form-grid">
            <SelectField
              label="Channel"
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value as NotificationChannel);
                setAddress("");
                setAddressError(undefined);
              }}
              hint={
                enabled && !enabled.includes(channel)
                  ? "This channel is switched off in Settings; the send will be refused."
                  : undefined
              }
            >
              {NOTIFICATION_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {channelLabel(c)}
                  {enabled && !enabled.includes(c) ? " (off)" : ""}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Template"
              value={tpl?.id ?? ""}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={!templates.data?.length}
              error={templates.error?.message}
              hint={
                templates.loading
                  ? "Loading templates"
                  : tpl
                    ? `Sends the current version, v${tpl.currentVersion}`
                    : "No active template for this channel. Create one under Templates."
              }
            >
              {(templates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} ({t.language}) {t.name}
                </option>
              ))}
            </SelectField>
          </div>
          <PatientPicker
            label="Use a patient's details (optional)"
            value={patient}
            onChange={(p) => void pickPatient(p)}
          />
          <TextField
            label={channel === "EMAIL" ? "Send to (email)" : "Send to (mobile number)"}
            required
            type={channel === "EMAIL" ? "email" : "tel"}
            autoComplete="off"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setAddressError(undefined);
            }}
            error={addressError}
            hint={
              channel === "EMAIL"
                ? "Any address you control."
                : "10-digit Indian mobile or +91 format. A number ending in 0000 simulates a failed send."
            }
          />
          {placeholders.length > 0 ? (
            <fieldset className="dos-fieldset">
              <legend className="dos-label">Values for the placeholders</legend>
              <div className="dos-form-grid">
                {placeholders.map((p) => (
                  <TextField
                    key={p}
                    label={`{{${p}}}`}
                    value={values[p] ?? ""}
                    onChange={(e) => setOverrides((o) => ({ ...o, [p]: e.target.value }))}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          {preview ? (
            <div>
              <div className="dos-label">Message that will be sent</div>
              <div
                className="dos-card"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                aria-live="polite"
              >
                {preview.text}
              </div>
              {preview.missing.length > 0 ? (
                <p className="dos-hint">
                  Empty values: {preview.missing.map((m) => `{{${m}}}`).join(", ")}. The send job
                  refuses to deliver a half-filled message.
                </p>
              ) : null}
            </div>
          ) : null}
          <div>
            <Button type="submit" loading={send.pending} disabled={!tpl}>
              Send test message
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Result">
        {sent ? (
          <TestResult key={sent.id} id={sent.id} onOpen={() => setOpen(sent.id)} />
        ) : (
          <p className="dos-muted" style={{ margin: 0 }}>
            The queued message and its status appear here.
          </p>
        )}
      </Section>
      <OutboxDrawer
        id={open}
        onClose={() => setOpen(null)}
        onChanged={() => {}}
        onSelect={setOpen}
      />
    </div>
  );
}

/** Polls the outbox row every 2 s until it leaves QUEUED (or MAX_POLLS), as the worker picks it up. */
function TestResult({ id, onOpen }: { id: string; onOpen: () => void }) {
  const [row, setRow] = useState<OutboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce restarts polling
  useEffect(() => {
    let live = true;
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await nApi.outbox.get(id);
        if (!live) return;
        setRow(r);
        setError(null);
        n += 1;
        setPolls(n);
        if (r.status === "QUEUED" && n < MAX_POLLS) timer = setTimeout(tick, 2000);
      } catch (e) {
        if (!live) return;
        setError(asApiError(e).message);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, nonce]);

  const stalled = row?.status === "QUEUED" && polls >= MAX_POLLS;
  return (
    <div className="dos-stack" aria-live="polite">
      {error ? (
        <Alert tone="danger">
          {error}{" "}
          <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
            Try again
          </Button>
        </Alert>
      ) : null}
      {!row && !error ? <p className="dos-muted">Checking status...</p> : null}
      {row ? (
        <>
          <div className="dos-cluster">
            <OutboxStatusChip status={row.status} />
            {row.status === "QUEUED" && !stalled ? (
              <span className="dos-hint">Waiting for the worker...</span>
            ) : null}
          </div>
          {stalled ? (
            <Alert tone="warning">
              Still queued after a minute. Is the worker running?{" "}
              <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
                Keep checking
              </Button>
            </Alert>
          ) : null}
          {row.status === "FAILED" ? (
            <Alert tone="danger">
              Failed:{" "}
              {consentReason(row.lastError) ||
                (row.lastError ?? "unknown error").replace(/_/g, " ")}
            </Alert>
          ) : null}
          <DescriptionList
            columns={1}
            items={[
              { term: "To", detail: <span className="dos-mono">{row.toAddressMasked}</span> },
              { term: "Channel", detail: channelLabel(row.channel) },
              { term: "Template", detail: <span className="dos-mono">{row.templateCode}</span> },
              { term: "Attempts", detail: String(row.attempts) },
              { term: "Provider", detail: row.provider ?? "Not sent yet" },
              { term: "Sent", detail: row.sentAt ? formatDateTime(row.sentAt) : "Not yet" },
            ]}
          />
          <div>
            <Button variant="secondary" onClick={onOpen}>
              View details
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
