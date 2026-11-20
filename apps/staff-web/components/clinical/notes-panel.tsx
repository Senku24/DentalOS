"use client";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  SelectField,
  TextareaField,
} from "@dentalos/ui";
import {
  CLINICAL_NOTE_KINDS,
  type EncounterDetailResponse,
  type NoteResponse,
  createAmendmentRequest,
  createNoteRequest,
  updateNoteRequest,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { useMutation } from "../../lib/api/hooks";
import { formatDateTime, humanize } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { canDo } from "../../lib/session";
import { Section } from "../common";
import { isMe, personLabel } from "./bits";

const KIND_LABEL: Record<string, string> = {
  SUBJECTIVE: "S · Subjective",
  OBJECTIVE: "O · Objective",
  ASSESSMENT: "A · Assessment",
  PLAN: "P · Plan",
  GENERAL: "General",
};
const kindOrder = (k: string) =>
  CLINICAL_NOTE_KINDS.indexOf(k as (typeof CLINICAL_NOTE_KINDS)[number]);

/**
 * SOAP notes. OPEN encounters: add, edit (author) and delete (author or treating dentist).
 * SIGNED encounters: read-only notes with their amendments; "Add amendment" (clinical:amend) is the
 * only way to correct them. Edit is never offered on a signed record.
 */
export function NotesPanel({
  encounter,
  onChanged,
}: {
  encounter: EncounterDetailResponse;
  onChanged: () => void;
}) {
  const open = encounter.status === "OPEN";
  const scope = { branchId: encounter.branchId };
  const writable = open && canDo("clinical:write", scope);
  const amendable = !open && canDo("clinical:amend", scope);
  const [editing, setEditing] = useState<NoteResponse | null>(null);
  const [deleting, setDeleting] = useState<NoteResponse | null>(null);
  const [amending, setAmending] = useState<{ noteId?: string } | null>(null);
  const notes = [...encounter.notes].sort(
    (a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.createdAt.localeCompare(b.createdAt),
  );

  const remove = useMutation(
    (n: NoteResponse) => clinicalApi.encounters.deleteNote(encounter.id, n.id),
    {
      success: "Note deleted",
      onSuccess: () => {
        setDeleting(null);
        onChanged();
      },
    },
  );

  return (
    <Section
      title="Clinical notes"
      description={
        open ? "SOAP notes for this visit. Editable until the encounter is signed." : undefined
      }
      actions={
        amendable ? (
          <Button size="sm" variant="secondary" onClick={() => setAmending({})}>
            <Plus size={16} aria-hidden="true" /> Add amendment
          </Button>
        ) : undefined
      }
    >
      {notes.length === 0 ? (
        <p className="dos-muted" style={{ margin: 0 }}>
          No notes recorded{open ? " yet" : ""}.
        </p>
      ) : (
        <ul className="cw-list" aria-label="Notes">
          {notes.map((n) => (
            <li key={n.id} className="cw-item">
              <div className="cw-row">
                <Badge tone="brand">{KIND_LABEL[n.kind] ?? humanize(n.kind)}</Badge>
                <span className="cw-meta">
                  {personLabel(n.authorId)} · {formatDateTime(n.createdAt)}
                  {n.updatedAt !== n.createdAt ? ` · edited ${formatDateTime(n.updatedAt)}` : ""}
                </span>
              </div>
              <p className="cw-body">{n.body}</p>
              {writable ? (
                <div className="dos-cluster">
                  {isMe(n.authorId) ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(n)}>
                      Edit<span className="dos-sr-only"> {humanize(n.kind)} note</span>
                    </Button>
                  ) : null}
                  {isMe(n.authorId) || isMe(encounter.treatingDentistUserId) ? (
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(n)}>
                      Delete<span className="dos-sr-only"> {humanize(n.kind)} note</span>
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {(n.amendments ?? []).length ? (
                <ul className="cw-list" aria-label="Amendments to this note">
                  {(n.amendments ?? []).map((a) => (
                    <Amendment key={a.id} a={a} />
                  ))}
                </ul>
              ) : null}
              {amendable ? (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setAmending({ noteId: n.id })}>
                    Amend<span className="dos-sr-only"> {humanize(n.kind)} note</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!open && encounter.amendments.length ? (
        <div className="dos-stack" data-gap="sm">
          <h3 style={{ fontSize: "var(--text-md)", margin: 0 }}>Encounter amendments</h3>
          <ul className="cw-list">
            {encounter.amendments.map((a) => (
              <Amendment key={a.id} a={a} />
            ))}
          </ul>
        </div>
      ) : null}

      {writable ? <AddNoteForm encounterId={encounter.id} onSaved={onChanged} /> : null}

      {editing ? (
        <EditNoteDialog
          encounterId={encounter.id}
          note={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this note?"
        description="The draft note is removed from this open encounter. This is audited."
        confirmLabel="Delete note"
        tone="danger"
        loading={remove.pending}
        onConfirm={() => deleting && void remove.run(deleting)}
      />
      {amending ? (
        <AmendDialog
          encounter={encounter}
          noteId={amending.noteId}
          onClose={() => setAmending(null)}
          onDone={() => {
            setAmending(null);
            onChanged();
          }}
        />
      ) : null}
    </Section>
  );
}

function Amendment({
  a,
}: { a: { id: string; body: string; reason: string; authorId: string; createdAt: string } }) {
  return (
    <li className="cw-item" data-tone="amend">
      <div className="cw-row">
        <Badge tone="info">Amendment</Badge>
        <span className="cw-meta">
          {personLabel(a.authorId)} · {formatDateTime(a.createdAt)}
        </span>
      </div>
      <p className="cw-body">{a.body}</p>
      <span className="cw-meta">Reason: {a.reason}</span>
    </li>
  );
}

function AddNoteForm({ encounterId, onSaved }: { encounterId: string; onSaved: () => void }) {
  const [kind, setKind] = useState<string>("SUBJECTIVE");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: { kind: (typeof CLINICAL_NOTE_KINDS)[number]; body: string }) =>
      clinicalApi.encounters.addNote(encounterId, b),
    {
      success: "Note added",
      onSuccess: () => {
        setBody("");
        setErrors({});
        onSaved();
      },
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const submit = () => {
    const r = validate(createNoteRequest, { kind, body });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <form
      className="dos-stack"
      data-gap="sm"
      aria-label="Add note"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <SelectField label="Note type" value={kind} onChange={(e) => setKind(e.target.value)}>
        {CLINICAL_NOTE_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </SelectField>
      <TextareaField
        label="Note"
        required
        rows={4}
        value={body}
        error={errors.body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div>
        <Button type="submit" loading={save.pending}>
          Add note
        </Button>
      </div>
    </form>
  );
}

function EditNoteDialog({
  encounterId,
  note,
  onClose,
  onDone,
}: {
  encounterId: string;
  note: NoteResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<string>(note.kind);
  const [body, setBody] = useState(note.body);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: { kind?: NoteResponse["kind"]; body?: string }) =>
      clinicalApi.encounters.updateNote(encounterId, note.id, b),
    { success: "Note updated", onSuccess: onDone, onError: (e) => setErrors(e.fieldErrors) },
  );
  const submit = () => {
    const r = validate(updateNoteRequest, { kind, body });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit note"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Save note
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField label="Note type" value={kind} onChange={(e) => setKind(e.target.value)}>
          {CLINICAL_NOTE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </SelectField>
        <TextareaField
          label="Note"
          required
          rows={6}
          value={body}
          error={errors.body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

function AmendDialog({
  encounter,
  noteId: initialNote,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  noteId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [noteId, setNoteId] = useState(initialNote ?? "");
  const [body, setBody] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: { noteId?: string; body: string; reason: string }) =>
      clinicalApi.encounters.addAmendment(encounter.id, b),
    {
      success: "Amendment added",
      onSuccess: onDone,
      onError: (e) => setErrors({ ...e.fieldErrors, _form: e.message }),
    },
  );
  const submit = () => {
    const r = validate(createAmendmentRequest, { noteId, body, reason });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add amendment"
      description="The signed record stays unchanged. The amendment is appended with your name, the time and the reason, and cannot be edited or deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Add amendment
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField label="Amends" value={noteId} onChange={(e) => setNoteId(e.target.value)}>
          <option value="">The whole encounter (e.g. a wrong diagnosis)</option>
          {encounter.notes.map((n) => (
            <option key={n.id} value={n.id}>
              {KIND_LABEL[n.kind] ?? n.kind} note — {n.body.slice(0, 40)}
              {n.body.length > 40 ? "…" : ""}
            </option>
          ))}
        </SelectField>
        <TextareaField
          label="Correction"
          required
          rows={4}
          value={body}
          error={errors.body}
          onChange={(e) => setBody(e.target.value)}
        />
        <TextareaField
          label="Reason for amendment"
          required
          rows={2}
          value={reason}
          error={errors.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {errors._form && !errors.body && !errors.reason ? (
          <Alert tone="danger">{errors._form}</Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
