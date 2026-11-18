"use client";
import {
  Alert,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
  useToast,
} from "@dentalos/ui";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CONTENT_TYPES,
  type DocumentResponse,
  MAX_DOCUMENT_BYTES,
  deleteDocumentRequest,
} from "@dentalos/validation";
import { Download, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BranchOptions, Section, useBranches } from "../../../components/common";
import { MOCK_MODE } from "../../../lib/api/client";
import { api } from "../../../lib/api/endpoints";
import { asApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { uploadDocument } from "../../../lib/api/upload";
import { formatBytes, formatDateTime, humanize } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, scopedBranchIds, userLabel } from "../../../lib/session";
import { useCursorPaging } from "../../../lib/use-cursor";
import { useProfile } from "./profile-context";

const ACCEPT = DOCUMENT_CONTENT_TYPES.join(",");

export function DocumentsTab() {
  const { patient, readOnly, branchName } = useProfile();
  const { toast } = useToast();
  const [category, setCategory] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter change restarts paging
  useEffect(() => paging.reset(), [category]);
  const q = useQuery(
    () =>
      api.documents.list(patient.id, { category: category || undefined, cursor: paging.cursor }),
    [patient.id, category, paging.cursor],
  );
  const writable = canDo("document:write") && !readOnly;
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<DocumentResponse | null>(null);

  const download = async (d: DocumentResponse) => {
    try {
      const r = await api.documents.downloadUrl(d.id);
      if (MOCK_MODE) {
        toast({
          tone: "info",
          title: "Demo mode",
          description: "A short-lived download link was issued (no file in mock mode).",
        });
        return;
      }
      // Short-lived presigned URL; opened directly so the file never transits the app server.
      window.open(r.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast({ tone: "danger", title: "Couldn't download", description: asApiError(e).message });
    }
  };

  const columns: ColumnDef<DocumentResponse, unknown>[] = [
    {
      accessorKey: "fileName",
      header: "File",
      cell: ({ row }) => (
        <div>
          <div>{row.original.fileName}</div>
          {row.original.description ? (
            <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
              {row.original.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ getValue }) => humanize(getValue() as string),
    },
    {
      accessorKey: "sizeBytes",
      header: "Size",
      cell: ({ getValue }) => formatBytes(getValue() as number),
    },
    { id: "branch", header: "Branch", accessorFn: (d) => branchName(d.branchId) },
    {
      accessorKey: "createdAt",
      header: "Uploaded",
      cell: ({ row }) =>
        `${formatDateTime(row.original.createdAt)} · ${userLabel(row.original.uploadedBy)}`,
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="dos-cluster">
          <Button size="sm" variant="secondary" onClick={() => void download(row.original)}>
            <Download size={14} aria-hidden="true" /> Download
            <span className="dos-sr-only"> {row.original.fileName}</span>
          </Button>
          {writable && canDo("document:write", { branchId: row.original.branchId }) ? (
            <Button size="sm" variant="ghost" onClick={() => setDeleting(row.original)}>
              Delete<span className="dos-sr-only"> {row.original.fileName}</span>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Section
      title="Documents"
      description="X-rays, reports, ID proofs and signed forms. Files go straight to secure storage."
      actions={
        writable ? (
          <Button size="sm" onClick={() => setUploading(true)}>
            <Upload size={16} aria-hidden="true" /> Upload
          </Button>
        ) : undefined
      }
    >
      <div className="dos-toolbar">
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">All categories</option>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </SelectField>
      </div>
      <div>
        <DataTable
          caption="Patient documents"
          columns={columns}
          data={q.data?.items ?? []}
          getRowId={(d) => d.id}
          loading={q.loading}
          error={q.error ? errorStateFor(q.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No documents"
          emptyDescription={writable ? "Upload X-rays, reports or signed forms." : undefined}
        />
        <CursorPager
          page={paging.page}
          hasPrev={paging.hasPrev}
          hasNext={Boolean(q.data?.nextCursor)}
          onPrev={paging.prev}
          onNext={() => paging.next(q.data?.nextCursor)}
          loading={q.loading}
          itemCount={q.data?.items.length}
        />
      </div>
      {uploading ? (
        <UploadDialog
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false);
            q.reload();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          doc={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            q.reload();
          }}
        />
      ) : null}
    </Section>
  );
}

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { patient, onWriteError } = useProfile();
  const { toast } = useToast();
  const { branches } = useBranches();
  const allowed = scopedBranchIds(branches);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [branchId, setBranchId] = useState(
    allowed.includes(patient.originBranchId) ? patient.originBranchId : (allowed[0] ?? ""),
  );
  const [category, setCategory] = useState("OTHER");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!branchId && allowed[0]) setBranchId(allowed[0]);
  }, [allowed, branchId]);

  const submit = async () => {
    if (!file) return setError("Choose a file to upload");
    if (!(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(file.type))
      return setError("Allowed: PDF, JPEG, PNG, WebP, HEIC or DICOM");
    if (file.size > MAX_DOCUMENT_BYTES)
      return setError(`Files must be ${formatBytes(MAX_DOCUMENT_BYTES)} or smaller`);
    setError(undefined);
    try {
      await uploadDocument(
        file,
        {
          patientId: patient.id,
          branchId,
          category: category as DocumentResponse["category"],
          description: description.trim() || undefined,
        },
        setStage,
      );
      toast({ tone: "success", title: "Document uploaded" });
      onDone();
    } catch (e) {
      const err = asApiError(e);
      onWriteError(err);
      setError(
        err.fieldErrors.fileName ??
          err.fieldErrors.contentType ??
          err.fieldErrors.sizeBytes ??
          err.message,
      );
    } finally {
      setStage(null);
    }
  };
  const busy = stage !== null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Upload document"
      description={`PDF or image, up to ${formatBytes(MAX_DOCUMENT_BYTES)}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Upload
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <div className="dos-field">
          <label className="dos-label" htmlFor="doc-file">
            File <span aria-hidden="true">*</span>
          </label>
          <input
            ref={fileRef}
            id="doc-file"
            type="file"
            accept={ACCEPT}
            className="dos-input"
            style={{ paddingTop: 8 }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "doc-file-error" : undefined}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <div className="dos-hint">{`${file.name} · ${formatBytes(file.size)}`}</div>
          ) : null}
          {error ? (
            <div className="dos-error" id="doc-file-error">
              {error}
            </div>
          ) : null}
        </div>
        <SelectField
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {humanize(c)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="File under branch"
          required
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <BranchOptions branches={branches} ids={allowed} />
        </SelectField>
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {busy ? (
          <Alert tone="info">
            {stage === "requesting"
              ? "Preparing secure upload…"
              : stage === "uploading"
                ? "Uploading file…"
                : "Finishing…"}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}

function DeleteDialog({
  doc,
  onClose,
  onDone,
}: { doc: DocumentResponse; onClose: () => void; onDone: () => void }) {
  const { onWriteError } = useProfile();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const remove = useMutation((r: string) => api.documents.remove(doc.id, r), {
    success: "Document deleted",
    onSuccess: onDone,
    onError: (e) => {
      setError(e.fieldErrors.reason);
      onWriteError(e);
    },
  });
  const submit = () => {
    const r = validate(deleteDocumentRequest, { reason });
    if (!r.ok) return setError(r.errors.reason);
    void remove.run(r.data.reason);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${doc.fileName}?`}
      description="The document is removed from the patient record. A copy is retained per the retention policy and the deletion is audited."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.pending} onClick={submit}>
            Delete document
          </Button>
        </>
      }
    >
      <TextareaField
        label="Reason"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={error}
      />
    </Dialog>
  );
}
