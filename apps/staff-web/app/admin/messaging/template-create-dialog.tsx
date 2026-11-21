"use client";
import { Alert, Button, Dialog, SelectField, TextField } from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PURPOSES,
  type NotificationChannel,
  type NotificationTemplateResponse,
  SYSTEM_TEMPLATE_CODES,
  createNotificationTemplateRequest,
} from "@dentalos/validation";
import { useState } from "react";
import { TemplateBodyEditor } from "../../../components/notifications/template-body-editor";
import type { ApiError } from "../../../lib/api/errors";
import { useMutation } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import {
  channelLabel,
  isSystemCode,
  purposeLabel,
  systemPurpose,
} from "../../../lib/api/notifications-labels";
import { type FieldErrors, validate } from "../../../lib/forms";

const EMPTY = {
  code: "",
  channel: "WHATSAPP" as NotificationChannel,
  language: "en",
  purpose: "TRANSACTIONAL",
  name: "",
  subject: "",
  body: "",
  providerTemplateRef: "",
};

/** Creates a template and its version 1. System codes fix the purpose and the allowed placeholders. */
export function TemplateCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: NotificationTemplateResponse) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New template"
      description="One template per code, channel and language. Its text is versioned: later edits publish a new version."
      size="lg"
    >
      {open ? <Form onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function Form({
  onClose,
  onCreated,
}: { onClose: () => void; onCreated: (t: NotificationTemplateResponse) => void }) {
  const [v, setV] = useState(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof typeof EMPTY>(k: K, val: (typeof EMPTY)[K]) => {
    setV((x) => ({ ...x, [k]: val }));
    setErrors((e) => {
      if (!(k in e)) return e;
      const { [k]: _, ...rest } = e;
      return rest;
    });
  };
  const sys = isSystemCode(v.code);
  const purpose = systemPurpose(v.code) ?? v.purpose;

  const create = useMutation(
    (b: Parameters<typeof nApi.templates.create>[0]) => nApi.templates.create(b),
    {
      success: "Template created",
      onSuccess: onCreated,
      onError: (e: ApiError) => {
        setErrors(e.fieldErrors);
        if (e.code === "template_placeholder_unknown" || e.code === "template_body_too_long")
          setErrors((x) => ({ ...x, body: e.message }));
        else if (e.code === "template_exists") setErrors((x) => ({ ...x, code: e.message }));
        else if (!Object.keys(e.fieldErrors).length) setFormError(e.message);
      },
    },
  );

  const submit = () => {
    setFormError(null);
    const r = validate(createNotificationTemplateRequest, {
      ...v,
      purpose: sys ? undefined : v.purpose,
      subject: v.channel === "EMAIL" ? v.subject : undefined,
    });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    void create.run(r.data);
  };

  return (
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
        <TextField
          label="Code"
          required
          list="tpl-codes"
          autoCapitalize="characters"
          value={v.code}
          onChange={(e) => set("code", e.target.value.toUpperCase())}
          error={errors.code}
          hint="Pick a system code the app sends (e.g. APPT_REMINDER_24H) or type your own."
        />
        <datalist id="tpl-codes">
          {SYSTEM_TEMPLATE_CODES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <TextField
          label="Name"
          required
          value={v.name}
          onChange={(e) => set("name", e.target.value)}
          error={errors.name}
          hint="Shown to staff only"
        />
        <SelectField
          label="Channel"
          value={v.channel}
          onChange={(e) => set("channel", e.target.value as NotificationChannel)}
        >
          {NOTIFICATION_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {channelLabel(c)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Language"
          required
          value={v.language}
          onChange={(e) => set("language", e.target.value)}
          error={errors.language}
          hint="Language tag, e.g. en or hi"
        />
        <SelectField
          label="Purpose"
          value={purpose}
          disabled={sys}
          onChange={(e) => set("purpose", e.target.value)}
          error={errors.purpose}
          hint={
            sys
              ? `${v.code.trim()} is always ${purposeLabel(purpose).toLowerCase()}`
              : "Decides which consent applies: marketing is never implied."
          }
        >
          {NOTIFICATION_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {purposeLabel(p)}
            </option>
          ))}
        </SelectField>
        {v.channel === "WHATSAPP" ? (
          <TextField
            label="Provider template reference"
            value={v.providerTemplateRef}
            onChange={(e) => set("providerTemplateRef", e.target.value)}
            error={errors.providerTemplateRef}
            hint="Optional. Needed by real WhatsApp providers; the console provider ignores it."
          />
        ) : null}
      </div>
      <TemplateBodyEditor
        idPrefix="create"
        code={v.code}
        channel={v.channel}
        subject={v.subject}
        body={v.body}
        onSubject={(s) => set("subject", s)}
        onBody={(b) => set("body", b)}
        errors={{ subject: errors.subject, body: errors.body }}
      />
      <div className="dos-cluster" style={{ justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={create.pending}>
          Create template
        </Button>
      </div>
    </form>
  );
}
