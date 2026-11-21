"use client";
import { Alert, Button, TextField, TextareaField } from "@dentalos/ui";
import {
  type NotificationChannel,
  TEMPLATE_BODY_LIMITS,
  extractPlaceholders,
  renderTemplate,
  unknownPlaceholders,
} from "@dentalos/validation";
import { useMemo, useRef, useState } from "react";
import { SAMPLE_VALUES, allowedFor, sampleFor } from "../../lib/api/notifications-labels";

/**
 * Message text editor shared by "new template" and "new version": placeholder helper (inserts
 * {{name}} at the cursor), length counter against the channel limit, and a live preview rendered
 * with the same pure `renderTemplate` the send job uses, filled with editable sample data.
 */
export function TemplateBodyEditor({
  code,
  channel,
  subject,
  body,
  onSubject,
  onBody,
  errors = {},
  idPrefix,
}: {
  code: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  errors?: { subject?: string; body?: string };
  idPrefix: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const allowed = allowedFor(code);
  const helper = allowed ? [...allowed] : Object.keys(SAMPLE_VALUES);
  const used = useMemo(() => extractPlaceholders(body), [body]);
  const unknown = unknownPlaceholders(body, allowed);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const values = useMemo(
    () => Object.fromEntries(used.map((u) => [u, overrides[u] ?? sampleFor(u)])),
    [used, overrides],
  );
  const preview = useMemo(() => renderTemplate(body, values), [body, values]);
  const limit = TEMPLATE_BODY_LIMITS[channel];
  const over = body.length > limit;

  const insert = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    onBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="dos-stack">
      {channel === "EMAIL" ? (
        <TextField
          label="Subject"
          maxLength={200}
          value={subject}
          onChange={(e) => onSubject(e.target.value)}
          error={errors.subject}
        />
      ) : null}
      <TextareaField
        ref={ref}
        label={channel === "EMAIL" ? "Email text" : "Message text"}
        rows={6}
        required
        value={body}
        onChange={(e) => onBody(e.target.value)}
        error={errors.body}
        hint={`${body.length} / ${limit} characters for ${channel === "SMS" ? "SMS" : channel === "EMAIL" ? "email" : "WhatsApp"}`}
      />
      {over ? (
        <Alert tone="danger">
          This text is {body.length - limit} characters over the {limit} limit for the channel.
        </Alert>
      ) : null}
      <div id={`${idPrefix}-ph`}>
        <div className="dos-label">
          Placeholders{allowed ? "" : " (custom code: any name is accepted)"}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a row of buttons, not a form group */}
        <div className="dos-cluster" role="group" aria-label="Insert a placeholder">
          {helper.map((name) => (
            <Button key={name} size="sm" variant="secondary" onClick={() => insert(name)}>
              {`{{${name}}}`}
            </Button>
          ))}
        </div>
      </div>
      {unknown.length > 0 ? (
        <Alert tone="warning">
          Not allowed for {code.trim().toUpperCase() || "this code"}:{" "}
          {unknown.map((u) => `{{${u}}}`).join(", ")}. Remove them before publishing.
        </Alert>
      ) : null}
      <section aria-label="Live preview" className="dos-card dos-stack" data-gap="sm">
        <h3 className="dos-label" style={{ margin: 0 }}>
          Live preview (sample data)
        </h3>
        {channel === "EMAIL" && subject ? (
          <strong>{renderTemplate(subject, values).text}</strong>
        ) : null}
        <div
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            padding: "var(--space-3)",
            minHeight: "3em",
            border: "1px dashed var(--color-border)",
            borderRadius: "var(--radius-md, 8px)",
          }}
          aria-live="polite"
        >
          {body.trim() ? (
            preview.text
          ) : (
            <span className="dos-muted">Type a message to preview it.</span>
          )}
        </div>
        {preview.missing.length > 0 ? (
          <div className="dos-hint">
            Empty in the preview: {preview.missing.map((m) => `{{${m}}}`).join(", ")}. A message
            with a missing value is not sent.
          </div>
        ) : null}
        {used.length > 0 ? (
          <details>
            <summary>Edit sample values</summary>
            <div className="dos-form-grid" style={{ marginTop: "var(--space-3)" }}>
              {used.map((u) => (
                <TextField
                  key={u}
                  label={`{{${u}}}`}
                  value={overrides[u] ?? sampleFor(u)}
                  onChange={(e) => setOverrides((o) => ({ ...o, [u]: e.target.value }))}
                />
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
