"use client";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  DescriptionList,
  SelectField,
  TextField,
} from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PURPOSES,
  type NotificationChannel,
  type NotificationPurpose,
  type NotificationSettings,
  updateNotificationSettingsRequest,
} from "@dentalos/validation";
import { useState } from "react";
import { Loadable, Section } from "../../../components/common";
import { TIME_ZONES } from "../../../components/timezones";
import type { ApiError } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import {
  type NotificationSettingsResponse,
  notificationsApi as nApi,
} from "../../../lib/api/notifications";
import { channelLabel, offsetLabel, purposeLabel } from "../../../lib/api/notifications-labels";
import { type FieldErrors, validate } from "../../../lib/forms";

export function SettingsTab() {
  const q = useQuery(() => nApi.settings.get(), []);
  return (
    <Loadable state={q} rows={6}>
      {(data) => <Form data={data} onSaved={q.reload} />}
    </Loadable>
  );
}

const DEFAULT_OFFSETS = [1440, 120];

function Form({ data, onSaved }: { data: NotificationSettingsResponse; onSaved: () => void }) {
  const raw = data.settings;
  const eff = data.effective;
  const [channels, setChannels] = useState<string[]>(eff.enabledChannels);
  const [offsets, setOffsets] = useState<string[]>(eff.reminderOffsetsMinutes.map(String));
  const [qhOn, setQhOn] = useState(Boolean(eff.quietHours));
  const [qhStart, setQhStart] = useState(raw.quietHours?.start ?? "21:00");
  const [qhEnd, setQhEnd] = useState(raw.quietHours?.end ?? "08:00");
  const [qhZone, setQhZone] = useState(raw.quietHours?.timeZone ?? "Asia/Kolkata");
  const [exempt, setExempt] = useState<string[]>(
    eff.quietHours?.exemptPurposes ?? ["TRANSACTIONAL"],
  );
  const [implicitT, setImplicitT] = useState(eff.consent.implicitTransactional);
  const [implicitR, setImplicitR] = useState(eff.consent.implicitReminder);
  const [lead, setLead] = useState(String(eff.recallLeadDays));
  const [sender, setSender] = useState(raw.senderName ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const offsetOptions = [...new Set([...DEFAULT_OFFSETS, ...eff.reminderOffsetsMinutes])]
    .sort((a, b) => b - a)
    .map((m) => ({
      value: String(m),
      label: offsetLabel(m),
      hint:
        m === 1440
          ? "The day before (APPT_REMINDER_24H)"
          : m === 120
            ? "Two hours before (APPT_REMINDER_2H)"
            : "Custom offset: kept as saved, no template of its own",
    }));

  const save = useMutation(nApi.settings.update, {
    success: "Messaging settings saved",
    onSuccess: onSaved,
    onError: (e: ApiError) => {
      const mapped: FieldErrors = {};
      for (const [k, v] of Object.entries(e.fieldErrors))
        mapped[k.replace(/^notifications\./, "")] = v;
      if (Object.keys(mapped).length) setErrors(mapped);
      else setFormError(e.message);
    },
  });

  const submit = () => {
    setFormError(null);
    // PATCH replaces the whole `notifications` section: start from what is stored so nothing
    // (e.g. reminderChannelOrder) is lost, then apply this form.
    const body: NotificationSettings = {
      ...raw,
      enabledChannels: channels as NotificationChannel[],
      reminderOffsetsMinutes: offsets.map(Number).sort((a, b) => b - a),
      quietHours: {
        enabled: qhOn,
        start: qhStart,
        end: qhEnd,
        timeZone: qhZone,
        exemptPurposes: exempt as NotificationPurpose[],
      },
      implicitConsent: { transactional: implicitT, reminder: implicitR },
      recallLeadDays: lead.trim() === "" ? (undefined as unknown as number) : Number(lead),
      senderName: sender,
    };
    const r = validate(updateNotificationSettingsRequest, body);
    if (!r.ok) {
      const e = { ...r.errors };
      if (e.enabledChannels) e.enabledChannels = "Keep at least one channel on";
      if (e.reminderOffsetsMinutes) e.reminderOffsetsMinutes = "Choose at least one reminder time";
      return setErrors(e);
    }
    setErrors({});
    void save.run(r.data);
  };

  return (
    <form
      className="dos-split"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="dos-stack" data-gap="lg">
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <Section title="Channels" description="Messages are only queued on channels that are on.">
          <CheckboxGroup
            legend="Channels in use"
            options={NOTIFICATION_CHANNELS.map((c) => ({ value: c, label: channelLabel(c) }))}
            value={channels}
            onChange={setChannels}
            error={errors.enabledChannels}
            columns={3}
          />
          <TextField
            label="Email sender name"
            maxLength={60}
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            error={errors.senderName}
            hint="Shown as the sender of emails. Optional."
          />
        </Section>
        <Section
          title="Appointment reminders"
          description="When reminders go out before an appointment. A booking made closer than an offset only gets the later reminders."
        >
          <CheckboxGroup
            legend="Send a reminder"
            options={offsetOptions}
            value={offsets}
            onChange={setOffsets}
            error={errors.reminderOffsetsMinutes}
          />
          {raw.reminderChannelOrder ? (
            <p className="dos-hint" style={{ margin: 0 }}>
              Reminder channel order (kept as saved):{" "}
              {raw.reminderChannelOrder.map(channelLabel).join(", then ")}.
            </p>
          ) : (
            <p className="dos-hint" style={{ margin: 0 }}>
              Reminder channel order: WhatsApp, then SMS, then email (default), using the first
              channel the patient consented to and has an address for.
            </p>
          )}
          <TextField
            label="Recall reminder lead time (days)"
            type="number"
            inputMode="numeric"
            min={0}
            max={90}
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            error={errors.recallLeadDays}
            hint="Send the recall reminder this many days before the due date (0 to 90)."
          />
        </Section>
        <Section
          title="Quiet hours"
          description="Messages that fall inside the window wait until it ends. Exempt purposes ignore it."
        >
          <Checkbox
            switch
            label="Hold messages during quiet hours"
            checked={qhOn}
            onChange={(e) => setQhOn(e.target.checked)}
          />
          <div className="dos-form-grid">
            <TextField
              label="From"
              type="time"
              value={qhStart}
              disabled={!qhOn}
              onChange={(e) => setQhStart(e.target.value)}
              error={errors["quietHours.start"]}
            />
            <TextField
              label="Until"
              type="time"
              value={qhEnd}
              disabled={!qhOn}
              onChange={(e) => setQhEnd(e.target.value)}
              error={errors["quietHours.end"]}
              hint="The window may cross midnight, e.g. 21:00 to 08:00."
            />
            <SelectField
              label="Time zone"
              value={qhZone}
              disabled={!qhOn}
              onChange={(e) => setQhZone(e.target.value)}
              error={errors["quietHours.timeZone"]}
            >
              {!TIME_ZONES.some((z) => z.value === qhZone) ? (
                <option value={qhZone}>{qhZone}</option>
              ) : null}
              {TIME_ZONES.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </SelectField>
          </div>
          <CheckboxGroup
            legend="Exempt from quiet hours"
            options={NOTIFICATION_PURPOSES.map((p) => ({ value: p, label: purposeLabel(p) }))}
            value={exempt}
            onChange={setExempt}
            error={errors["quietHours.exemptPurposes"]}
            hint="Receipts and confirmations are normally exempt."
            columns={3}
          />
        </Section>
        <Section
          title="Consent"
          description="What to assume when a patient has no saved preference. An explicit opt-out always wins, and marketing is never implied."
        >
          <Checkbox
            switch
            label="Treat patients with no preference as opted in to transactional messages"
            hint="Confirmations, receipts and invoices."
            checked={implicitT}
            onChange={(e) => setImplicitT(e.target.checked)}
          />
          <Checkbox
            switch
            label="Treat patients with no preference as opted in to reminders"
            hint="Appointment and recall reminders. Off means a reminder needs recorded consent."
            checked={implicitR}
            onChange={(e) => setImplicitR(e.target.checked)}
          />
        </Section>
        <div>
          <Button type="submit" loading={save.pending}>
            Save settings
          </Button>
        </div>
      </div>
      <Section title="Provider">
        <DescriptionList
          columns={1}
          items={[
            { term: "Provider", detail: "Console" },
            {
              term: "What it does",
              detail:
                "Writes each message to the server log. Nothing reaches a phone or inbox, and no external account is needed.",
            },
            {
              term: "Delivery receipts",
              detail:
                "Not applicable: the console provider has no webhooks, so messages stop at Sent.",
            },
          ]}
        />
        <p className="dos-hint" style={{ margin: 0 }}>
          Real WhatsApp, SMS and email providers come later; templates and settings here will carry
          over.
        </p>
      </Section>
    </form>
  );
}
