"use client";
import { Alert, Button, Dialog, EmptyState, SelectField, TextField, useToast } from "@dentalos/ui";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CONTENT_TYPES,
  type DocumentResponse,
  type EncounterDetailResponse,
  MAX_DOCUMENT_BYTES,
} from "@dentalos/validation";
import { Paperclip, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { collectPages } from "../../lib/api/clinical-client";
import { api } from "../../lib/api/endpoints";
import { asApiError } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { uploadDocument } from "../../lib/api/upload";
import { formatBytes, formatDateTime, humanize } from "../../lib/format";
import { canDo, userLabel } from "../../lib/session";
import { Loadable, Section } from "../common";

/**
 * Documents attached to the encounter (X-rays, photos, reports). Only AVAILABLE documents of the same
 * patient can be attached, and only while the encounter is OPEN. X-ray upload reuses the presigned
 * documents flow (lib/api/upload.ts) and then attaches the new document.
 */
export function AttachmentsPanel({
  encounter,
  onChanged,
}: {
  encounter: EncounterDetailResponse;
  onChanged?: () => void;
}) {
  const docs = useQuery(() => clinicalApi.encounters.documents(encounter.id), [encounter.id]);
  const writable =
    encounter.status === "OPEN" && canDo("clinical:write", { branchId: encounter.branchId });
  const canUpload = writable && canDo("document:write", { branchId: encounter.branchId });
  const [attaching, setAttaching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const refresh = () => {
    docs.reload();
    onChanged?.();
  };
  const detach = useMutation(
    (d: DocumentResponse) => clinicalApi.encounters.detachDocument(encounter.id, d.id),
    { success: "Document detached", onSuccess: refresh },
  );

  return (
    <Section
      title="Attachments"
      description="X-rays, photos and reports linked to this visit."
      actions={
        writable ? (
          <>
            {canUpload ? (
              <Button size="sm" onClick={() => setUploading(true)}>
                <Upload size={16} aria-hidden="true" /> Upload X-ray
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setAttaching(true)}>
              <Paperclip size={16} aria-hidden="true" /> Attach document
            </Button>
          </>
        ) : undefined
      }
    >
      <Loadable state={docs}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState
              title="No attachments"
              description={
                writable ? "Upload an X-ray or attach an existing patient document." : undefined
              }
            />
          ) : (
            <ul className="cw-list">
              {d.items.map((doc) => (
                <li key={doc.id} className="cw-item">
                  <div className="cw-row">
                    <strong style={{ overflowWrap: "anywhere" }}>{doc.fileName}</strong>
                    <span className="dos-badge" data-tone="neutral">
                      {humanize(doc.category)}
                    </span>
                  </div>
                  {doc.description ? <span>{doc.description}</span> : null}
                  <span className="cw-meta">
                    {formatBytes(doc.sizeBytes)} · {formatDateTime(doc.createdAt)} ·{" "}
                    {userLabel(doc.uploadedBy)}
                  </span>
                  {writable ? (
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={detach.pending}
                        onClick={() => void detach.run(doc)}
                      >
                        Detach<span className="dos-sr-only"> {doc.fileName}</span>
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {attaching ? (
        <AttachDialog
          encounter={encounter}
          attached={docs.data?.items ?? []}
          onClose={() => setAttaching(false)}
          onDone={() => {
            setAttaching(false);
            refresh();
          }}
        />
      ) : null}
      {uploading ? (
        <UploadXrayDialog
          encounter={encounter}
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false);
            refresh();
          }}
        />
      ) : null}
    </Section>
  );
}

function AttachDialog({
  encounter,
  attached,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  attached: DocumentResponse[];
  onClose: () => void;
  onDone: () => void;
}) {
  // Every page of the patient's documents (GET /documents is 25 per page by default).
  const list = useQuery(
    () =>
      collectPages((cursor) =>
        api.documents.list(encounter.patientId, cursor ? { cursor } : {}),
      ).then((items) => ({ items })),
    [encounter.patientId],
  );
  const [documentId, setDocumentId] = useState("");
  const [error, setError] = useState<string>();
  // GET /documents does not return `encounterId` yet, so documents attached to another encounter
  // can still be listed; the API answers 409 document_already_attached, shown inline, and the
  // document is dropped from the picker.
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const save = useMutation(() => clinicalApi.encounters.attachDocument(encounter.id, documentId), {
    success: "Document attached",
    onSuccess: onDone,
    onError: (e) => {
      setError(e.fieldErrors.documentId ?? e.message);
      if (e.code === "document_already_attached") {
        setRefused((s) => new Set(s).add(documentId));
        setDocumentId("");
      }
    },
  });
  const taken = new Set(attached.map((d) => d.id));
  const candidates = (list.data?.items ?? []).filter(
    (d) =>
      d.patientId === encounter.patientId &&
      d.status === "AVAILABLE" &&
      !taken.has(d.id) &&
      !refused.has(d.id) &&
      !d.encounterId,
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Attach patient document"
      description="Uploaded documents of this patient. A document already attached to another encounter can't be attached again; you'll be told if you pick one."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!documentId} loading={save.pending} onClick={() => void save.run()}>
            Attach
          </Button>
        </>
      }
    >
      <Loadable state={list} rows={2}>
        {() =>
          candidates.length === 0 ? (
            <div className="dos-stack" data-gap="sm">
              {error ? <Alert tone="danger">{error}</Alert> : null}
              <Alert tone="info">
                No unattached documents. Upload one from the patient record or here.
              </Alert>
            </div>
          ) : (
            <SelectField
              label="Document"
              required
              value={documentId}
              error={error}
              onChange={(e) => setDocumentId(e.target.value)}
            >
              <option value="">Select a document</option>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName} · {humanize(d.category)} · {formatDateTime(d.createdAt)}
                </option>
              ))}
            </SelectField>
          )
        }
      </Loadable>
    </Dialog>
  );
}

function UploadXrayDialog({
  encounter,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<DocumentResponse["category"]>("XRAY");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!file) return setError("Choose a file to upload");
    if (!(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(file.type))
      return setError("Allowed: PDF, JPEG, PNG, WebP, HEIC or DICOM");
    if (file.size > MAX_DOCUMENT_BYTES)
      return setError(`Files must be ${formatBytes(MAX_DOCUMENT_BYTES)} or smaller`);
    setError(undefined);
    try {
      const doc = await uploadDocument(
        file,
        {
          patientId: encounter.patientId,
          branchId: encounter.branchId,
          category,
          description: description.trim() || undefined,
        },
        setStage,
      );
      setStage("attaching");
      await clinicalApi.encounters.attachDocument(encounter.id, doc.id);
      toast({ tone: "success", title: "Uploaded and attached" });
      onDone();
    } catch (e) {
      const err = asApiError(e);
      setError(err.fieldErrors.fileName ?? err.fieldErrors.contentType ?? err.message);
    } finally {
      setStage(null);
    }
  };
  const busy = stage !== null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Upload X-ray"
      description={`Image, DICOM or PDF up to ${formatBytes(MAX_DOCUMENT_BYTES)}. It is filed on the patient record and attached to this encounter.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Upload and attach
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <div className="dos-field">
          <label className="dos-label" htmlFor="cw-xray-file">
            File <span aria-hidden="true">*</span>
          </label>
          <input
            ref={fileRef}
            id="cw-xray-file"
            type="file"
            accept={DOCUMENT_CONTENT_TYPES.join(",")}
            className="dos-input"
            style={{ paddingTop: 8 }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "cw-xray-error" : undefined}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="dos-hint">{`${file.name} · ${formatBytes(file.size)}`}</div>
          ) : null}
          {error ? (
            <div className="dos-error" id="cw-xray-error">
              {error}
            </div>
          ) : null}
        </div>
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as DocumentResponse["category"])}
        >
          {DOCUMENT_CATEGORIES.filter((c) =>
            ["XRAY", "PHOTO", "LAB_REPORT", "OTHER"].includes(c),
          ).map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Description"
          hint="e.g. IOPA 46, OPG"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {busy ? (
          <Alert tone="info">
            {stage === "requesting"
              ? "Preparing secure upload…"
              : stage === "uploading"
                ? "Uploading file…"
                : stage === "attaching"
                  ? "Attaching to the encounter…"
                  : "Finishing…"}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
