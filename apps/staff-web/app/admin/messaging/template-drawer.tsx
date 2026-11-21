"use client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  Drawer,
  SelectField,
  Skeleton,
  TextField,
} from "@dentalos/ui";
import {
  type NotificationTemplateResponse,
  type NotificationTemplateVersionResponse,
  publishNotificationTemplateVersionRequest,
  validateTemplateBody,
} from "@dentalos/validation";
import { useEffect, useMemo, useState } from "react";
import { TemplateBodyEditor } from "../../../components/notifications/template-body-editor";
import { diffText } from "../../../components/notifications/text-diff";
import { errorStateFor } from "../../../lib/api/errors";
import type { ApiError } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import { channelLabel, purposeLabel } from "../../../lib/api/notifications-labels";
import { formatDateTime } from "../../../lib/format";
import { validate } from "../../../lib/forms";

export function TemplateDrawer({
  id,
  onClose,
  onChanged,
}: { id: string | null; onClose: () => void; onChanged: () => void }) {
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Template"
      description="Edits never change a published version: they publish the next one."
    >
      {id ? <Body key={id} id={id} onChanged={onChanged} /> : null}
    </Drawer>
  );
}

function Body({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useQuery(() => nApi.templates.get(id), [id]);
  const versions = useQuery(() => nApi.templates.versions(id), [id]);
  const refresh = () => {
    t.reload();
    versions.reload();
    onChanged();
  };
  if (t.error) {
    const e = errorStateFor(t.error);
    return (
      <Alert tone="danger">
        {e.title}: {e.description}{" "}
        <Button size="sm" variant="secondary" onClick={t.reload}>
          Try again
        </Button>
      </Alert>
    );
  }
  if (!t.data)
    return (
      <div className="dos-stack" data-gap="sm" aria-busy="true">
        <span className="dos-sr-only">Loading</span>
        <Skeleton height="1.25em" width="60%" />
        <Skeleton height="8em" />
      </div>
    );
  return (
    <div className="dos-stack" data-gap="lg">
      <Meta t={t.data} onChanged={refresh} />
      <Publish t={t.data} versions={versions.data?.items ?? []} onPublished={refresh} />
      <History t={t.data} versions={versions} />
    </div>
  );
}

function Meta({ t, onChanged }: { t: NotificationTemplateResponse; onChanged: () => void }) {
  const [name, setName] = useState(t.name);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => setName(t.name), [t.name]);
  const update = useMutation(
    (b: { name?: string; active?: boolean }) => nApi.templates.update(t.id, b),
    {
      success: (r) =>
        r.active === t.active
          ? "Template renamed"
          : r.active
            ? "Template activated"
            : "Template deactivated",
      onSuccess: () => {
        setConfirmOff(false);
        onChanged();
      },
      onError: () => setConfirmOff(false),
    },
  );
  const dirty = name.trim() !== t.name && name.trim().length > 0;
  return (
    <section className="dos-stack" aria-label="Template details">
      <div className="dos-cluster">
        <Badge tone={t.active ? "success" : "neutral"}>{t.active ? "Active" : "Inactive"}</Badge>
        <span className="dos-mono">{t.code}</span>
        <span className="dos-muted">
          {channelLabel(t.channel)} · {t.language} · {purposeLabel(t.purpose)} · v{t.currentVersion}
        </span>
      </div>
      <form
        className="dos-cluster"
        style={{ alignItems: "flex-end" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void update.run({ name: name.trim() });
        }}
      >
        <div style={{ flex: "1 1 220px" }}>
          <TextField
            label="Name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!dirty} loading={update.pending}>
          Rename
        </Button>
      </form>
      <Checkbox
        switch
        label={t.active ? "Active: used when this message is sent" : "Inactive: never sent"}
        hint="A deactivated template is skipped: messages with this code on this channel and language stop being queued. Templates are never deleted."
        checked={t.active}
        onChange={(e) => {
          if (e.target.checked) void update.run({ active: true });
          else setConfirmOff(true);
        }}
      />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Deactivate this template?"
        description={`${t.code} messages on ${channelLabel(t.channel)} (${t.language}) will no longer be sent until you activate it again.`}
        confirmLabel="Deactivate"
        tone="danger"
        loading={update.pending}
        onConfirm={() => void update.run({ active: false })}
      />
    </section>
  );
}

function Publish({
  t,
  versions,
  onPublished,
}: {
  t: NotificationTemplateResponse;
  versions: NotificationTemplateVersionResponse[];
  onPublished: () => void;
}) {
  const latest = t.latest;
  const [subject, setSubject] = useState(latest?.subject ?? "");
  const [body, setBody] = useState(latest?.body ?? "");
  const [ref, setRef] = useState(latest?.providerTemplateRef ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrs, setFieldErrs] = useState<{ subject?: string; body?: string }>({});
  // Re-seed the editor after a publish (the latest version changed).
  const seed = latest?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the published version changes
  useEffect(() => {
    setSubject(latest?.subject ?? "");
    setBody(latest?.body ?? "");
    setRef(latest?.providerTemplateRef ?? "");
    setError(null);
    setFieldErrs({});
  }, [seed]);

  const changed =
    body.trim() !== (latest?.body ?? "") ||
    (t.channel === "EMAIL" && subject.trim() !== (latest?.subject ?? "")) ||
    ref.trim() !== (latest?.providerTemplateRef ?? "");
  const issues = validateTemplateBody(t.code, t.channel, body.trim());

  const publish = useMutation(
    (b: { subject?: string; body: string; providerTemplateRef?: string }) =>
      nApi.templates.publish(t.id, b),
    {
      success: (r) => `Published version ${r.currentVersion}`,
      onSuccess: onPublished,
      onError: (e: ApiError) => {
        if (e.code === "template_placeholder_unknown" || e.code === "template_body_too_long")
          setFieldErrs({ body: e.message });
        else if (e.fieldErrors.body || e.fieldErrors.subject)
          setFieldErrs({ body: e.fieldErrors.body, subject: e.fieldErrors.subject });
        else setError(e.message);
      },
    },
  );

  const submit = () => {
    setError(null);
    setFieldErrs({});
    const r = validate(publishNotificationTemplateVersionRequest, {
      subject: t.channel === "EMAIL" ? subject : undefined,
      body,
      providerTemplateRef: ref,
    });
    if (!r.ok) {
      setFieldErrs({ body: r.errors.body, subject: r.errors.subject });
      return;
    }
    void publish.run(r.data);
  };

  return (
    <section className="dos-stack" aria-labelledby="tpl-edit-h">
      <h3 className="dos-section-title" id="tpl-edit-h" style={{ marginBottom: 0 }}>
        Edit text
      </h3>
      <p className="dos-hint" style={{ margin: 0 }}>
        Publishing creates version {t.currentVersion + 1}. Messages already queued keep the version
        they were queued with.
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TemplateBodyEditor
        idPrefix={`edit-${t.id}`}
        code={t.code}
        channel={t.channel}
        subject={subject}
        body={body}
        onSubject={setSubject}
        onBody={setBody}
        errors={fieldErrs}
      />
      {t.channel === "WHATSAPP" ? (
        <TextField
          label="Provider template reference"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          hint="Optional"
        />
      ) : null}
      <div className="dos-cluster">
        <Button
          loading={publish.pending}
          disabled={!changed || !body.trim() || issues.length > 0}
          onClick={submit}
        >
          Publish version {t.currentVersion + 1}
        </Button>
        {changed ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSubject(latest?.subject ?? "");
              setBody(latest?.body ?? "");
              setRef(latest?.providerTemplateRef ?? "");
            }}
          >
            Discard changes
          </Button>
        ) : (
          <span className="dos-hint">Change the text to publish a new version.</span>
        )}
      </div>
      {versions.length > 1 ? (
        <RestoreHint
          versions={versions}
          onPick={(v) => {
            setSubject(v.subject ?? "");
            setBody(v.body);
          }}
        />
      ) : null}
    </section>
  );
}

function RestoreHint({
  versions,
  onPick,
}: {
  versions: NotificationTemplateVersionResponse[];
  onPick: (v: NotificationTemplateVersionResponse) => void;
}) {
  const [pick, setPick] = useState("");
  return (
    <div className="dos-cluster" style={{ alignItems: "flex-end" }}>
      <SelectField
        label="Start from an earlier version"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
      >
        <option value="">Choose a version</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            Version {v.version}
          </option>
        ))}
      </SelectField>
      <Button
        variant="secondary"
        disabled={!pick}
        onClick={() => {
          const v = versions.find((x) => x.id === pick);
          if (v) onPick(v);
        }}
      >
        Load into editor
      </Button>
    </div>
  );
}

function History({
  t,
  versions,
}: {
  t: NotificationTemplateResponse;
  versions: ReturnType<typeof useQuery<{ items: NotificationTemplateVersionResponse[] }>>;
}) {
  const items = versions.data?.items ?? [];
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const newest = items[0]?.version;
  const previous = items[1]?.version;
  // Default compare: previous -> newest.
  const from = a ?? previous ?? newest;
  const to = b ?? newest;
  const va = items.find((v) => v.version === from);
  const vb = items.find((v) => v.version === to);
  const diff = useMemo(() => (va && vb ? diffText(va.body, vb.body) : []), [va, vb]);
  const subjectChanged = va && vb && (va.subject ?? "") !== (vb.subject ?? "");

  return (
    <section className="dos-stack" aria-labelledby="tpl-hist-h">
      <h3 className="dos-section-title" id="tpl-hist-h" style={{ marginBottom: 0 }}>
        Version history
      </h3>
      {versions.error ? (
        <Alert tone="danger">
          {errorStateFor(versions.error).description}{" "}
          <Button size="sm" variant="secondary" onClick={versions.reload}>
            Try again
          </Button>
        </Alert>
      ) : !versions.data ? (
        <Skeleton height="4em" />
      ) : (
        <>
          {items.length > 1 && va && vb ? (
            <div className="dos-stack" data-gap="sm">
              <div className="dos-form-grid">
                <SelectField
                  label="Compare"
                  value={String(from)}
                  onChange={(e) => setA(Number(e.target.value))}
                >
                  {items.map((v) => (
                    <option key={v.id} value={v.version}>
                      Version {v.version}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="With"
                  value={String(to)}
                  onChange={(e) => setB(Number(e.target.value))}
                >
                  {items.map((v) => (
                    <option key={v.id} value={v.version}>
                      Version {v.version}
                    </option>
                  ))}
                </SelectField>
              </div>
              {va.version === vb.version ? (
                <p className="dos-hint">Choose two different versions to see what changed.</p>
              ) : (
                <section
                  aria-label={`Changes from version ${va.version} to version ${vb.version}`}
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  className="dos-card"
                >
                  {subjectChanged ? (
                    <p>
                      <strong>Subject:</strong> <del>{va.subject || "(none)"}</del>{" "}
                      <ins>{vb.subject || "(none)"}</ins>
                    </p>
                  ) : null}
                  {diff.map((s) =>
                    s.kind === "same" ? (
                      <span key={s.id}>{s.text}</span>
                    ) : s.kind === "add" ? (
                      <ins
                        key={s.id}
                        style={{
                          background: "var(--color-success-subtle)",
                          color: "var(--color-success)",
                          textDecoration: "none",
                        }}
                      >
                        <span className="dos-sr-only">[added: </span>
                        {s.text}
                        <span className="dos-sr-only">]</span>
                      </ins>
                    ) : (
                      <del
                        key={s.id}
                        style={{
                          background: "var(--color-danger-subtle)",
                          color: "var(--color-danger)",
                        }}
                      >
                        <span className="dos-sr-only">[removed: </span>
                        {s.text}
                        <span className="dos-sr-only">]</span>
                      </del>
                    ),
                  )}
                </section>
              )}
            </div>
          ) : null}
          <ol
            className="dos-stack"
            data-gap="sm"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {items.map((v) => (
              <li key={v.id} className="dos-card dos-stack" data-gap="sm">
                <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
                  <strong>
                    Version {v.version}
                    {v.version === t.currentVersion ? (
                      <>
                        {" "}
                        <Badge tone="brand">Current</Badge>
                      </>
                    ) : null}
                  </strong>
                  <span className="dos-muted">{formatDateTime(v.createdAt)}</span>
                </div>
                <DescriptionList
                  columns={1}
                  items={[
                    ...(v.subject ? [{ term: "Subject", detail: v.subject }] : []),
                    {
                      term: "Text",
                      detail: (
                        <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                          {v.body}
                        </span>
                      ),
                    },
                    {
                      term: "Placeholders",
                      detail: v.placeholders.length
                        ? v.placeholders.map((p) => `{{${p}}}`).join(", ")
                        : "None",
                    },
                  ]}
                />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
