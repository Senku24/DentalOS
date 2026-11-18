"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  CursorPager,
  DataTable,
  Dialog,
  PageHeader,
  RadioGroup,
  Skeleton,
  Steps,
  Tabs,
  TextareaField,
  useLink,
  useToast,
} from "@dentalos/ui";
import {
  type DuplicateCandidateResponse,
  MERGEABLE_FIELDS,
  type MergeableField,
  type PatientResponse,
  dismissDuplicateRequest,
  mergePatientsRequest,
} from "@dentalos/validation";
import { useEffect, useMemo, useState } from "react";
import { MockNotice, RequirePermission, useBranches } from "../../../components/common";
import { reasonLabel, scoreTone } from "../../../components/patient-bits";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, asApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import {
  formatDate,
  formatDateTime,
  formatPhone,
  humanize,
  patientName,
} from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { userLabel } from "../../../lib/session";
import { useCursorPaging } from "../../../lib/use-cursor";

export function DuplicatesClient() {
  return (
    <RequirePermission permission="patient:merge">
      <Inner />
    </RequirePermission>
  );
}

const FIELD_LABEL: Record<MergeableField, string> = {
  firstName: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  preferredName: "Preferred name",
  dob: "Date of birth",
  sex: "Sex",
  phone: "Mobile",
  altPhone: "Alternate number",
  email: "Email",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "PIN code",
  country: "Country",
};

const display = (f: MergeableField, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  if (f === "dob") return formatDate(String(v));
  if (f === "phone" || f === "altPhone") return formatPhone(String(v));
  if (f === "sex") return humanize(String(v));
  return String(v);
};

function Inner() {
  const Link = useLink();
  const [status, setStatus] = useState("PENDING");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: status change restarts paging
  useEffect(() => paging.reset(), [status]);
  const list = useQuery(
    () => api.duplicates.list({ status, cursor: paging.cursor }),
    [status, paging.cursor],
  );
  const [reviewing, setReviewing] = useState<DuplicateCandidateResponse | null>(null);

  const columns: ColumnDef<DuplicateCandidateResponse, unknown>[] = [
    {
      id: "pair",
      header: "Possible duplicate pair",
      accessorFn: (c) => `${patientName(c.patientA)} / ${patientName(c.patientB)}`,
      cell: ({ row }) => (
        <div className="dos-stack" data-gap="sm">
          {[row.original.patientA, row.original.patientB].map((p) => (
            <div key={p.id}>
              <Link href={`/patients/${p.id}`} className="dos-link">
                {patientName(p)}
              </Link>{" "}
              <span className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
                {p.mrn ?? "No MRN"} · {formatPhone(p.phone)}
              </span>
            </div>
          ))}
        </div>
      ),
    },
    {
      accessorKey: "score",
      header: "Score",
      cell: ({ getValue }) => (
        <Badge tone={scoreTone(getValue() as number)}>{String(getValue())}%</Badge>
      ),
    },
    {
      id: "reasons",
      header: "Why",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="dos-cluster">
          {row.original.reasons.map((r) => (
            <Badge key={r}>{reasonLabel(r)}</Badge>
          ))}
        </div>
      ),
    },
    {
      id: "when",
      header: status === "PENDING" ? "Detected" : "Reviewed",
      accessorFn: (c) => c.reviewedAt ?? c.createdAt,
      cell: ({ row }) =>
        row.original.reviewedAt
          ? `${formatDateTime(row.original.reviewedAt)} · ${userLabel(row.original.reviewedBy ?? "")}`
          : formatDateTime(row.original.createdAt),
    },
    ...(status === "PENDING"
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: DuplicateCandidateResponse } }) => (
              <Button size="sm" variant="secondary" onClick={() => setReviewing(row.original)}>
                Review
                <span className="dos-sr-only"> {patientName(row.original.patientA)} pair</span>
              </Button>
            ),
          } satisfies ColumnDef<DuplicateCandidateResponse, unknown>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Duplicate review"
        description="Likely duplicate patients. Nothing is merged automatically: compare, then dismiss or merge with a recorded reason."
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Patients", href: "/patients" },
          { label: "Duplicate review" },
        ]}
      />
      <div className="dos-stack">
        <MockNotice />
        <Tabs
          label="Candidate status"
          value={status}
          onValueChange={setStatus}
          items={[
            { id: "PENDING", label: "To review" },
            { id: "DISMISSED", label: "Dismissed" },
            { id: "MERGED", label: "Merged" },
          ]}
        >
          <DataTable
            caption="Duplicate candidates"
            columns={columns}
            data={list.data?.items ?? []}
            getRowId={(c) => c.id}
            loading={list.loading}
            error={list.error ? errorStateFor(list.error) : undefined}
            searchable={false}
            hidePagination
            pageSize={100}
            emptyTitle={status === "PENDING" ? "Nothing to review" : "No candidates here"}
            emptyDescription={
              status === "PENDING"
                ? "New likely duplicates appear here as patients are registered."
                : undefined
            }
          />
          <CursorPager
            page={paging.page}
            hasPrev={paging.hasPrev}
            hasNext={Boolean(list.data?.nextCursor)}
            onPrev={paging.prev}
            onNext={() => paging.next(list.data?.nextCursor)}
            loading={list.loading}
            itemCount={list.data?.items.length}
          />
        </Tabs>
      </div>
      {reviewing ? (
        <ReviewDialog
          candidate={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

const STEPS = ["Compare", "Choose survivor", "Resolve differences", "Confirm"];

function ReviewDialog({
  candidate,
  onClose,
  onDone,
}: {
  candidate: DuplicateCandidateResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const { name: branchName } = useBranches();
  const a = useQuery(() => api.patients.get(candidate.patientA.id), [candidate.patientA.id]);
  const b = useQuery(() => api.patients.get(candidate.patientB.id), [candidate.patientB.id]);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"review" | "dismiss">("review");
  const [survivorId, setSurvivorId] = useState<string>(candidate.patientA.id);
  const [choices, setChoices] = useState<Partial<Record<MergeableField, "survivor" | "merged">>>(
    {},
  );
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reauth, setReauth] = useState(false);

  const pa = a.data;
  const pb = b.data;
  const survivor = pa && pb ? (survivorId === pa.id ? pa : pb) : undefined;
  const merged = pa && pb ? (survivorId === pa.id ? pb : pa) : undefined;
  const conflicts = useMemo(
    () =>
      survivor && merged
        ? MERGEABLE_FIELDS.filter(
            (f) => (survivor[f] ?? null) !== (merged[f] ?? null) && merged[f] != null,
          )
        : [],
    [survivor, merged],
  );

  const dismiss = useMutation((r: string) => api.duplicates.dismiss(candidate.id, r), {
    success: "Marked as not a duplicate",
    onSuccess: onDone,
  });

  const doMerge = async () => {
    if (!survivor || !merged) return;
    const r = validate(mergePatientsRequest, {
      survivorId: survivor.id,
      mergedId: merged.id,
      duplicateCandidateId: candidate.id,
      reason,
      fieldChoices: choices,
    });
    if (!r.ok) {
      setConfirming(false);
      setErrors(r.errors);
      return;
    }
    setMerging(true);
    try {
      await api.patients.merge(r.data);
      toast({
        tone: "success",
        title: "Patients merged",
        description: `${patientName(merged)} now points to ${patientName(survivor)}.`,
      });
      onDone();
    } catch (e) {
      const err: ApiError = asApiError(e);
      setConfirming(false);
      if (err.needsReauth) setReauth(true);
      else toast({ tone: "danger", title: "Merge failed", description: err.message });
    } finally {
      setMerging(false);
    }
  };

  const loading = !pa || !pb;
  const fieldRows = (pa && pb ? MERGEABLE_FIELDS : []).map((f) => ({
    f,
    a: display(f, pa?.[f]),
    b: display(f, pb?.[f]),
    differs: (pa?.[f] ?? null) !== (pb?.[f] ?? null),
  }));

  const next = () => {
    if (step === 2 && conflicts.length === 0) return setStep(3);
    setStep(step + 1);
  };
  const back = () => {
    if (step === 3 && conflicts.length === 0) return setStep(1);
    setStep(Math.max(0, step - 1));
  };

  const footer =
    mode === "dismiss" ? (
      <>
        <Button variant="secondary" onClick={() => setMode("review")}>
          Back
        </Button>
        <Button
          loading={dismiss.pending}
          onClick={() => {
            const r = validate(dismissDuplicateRequest, { reason });
            if (!r.ok) return setErrors(r.errors);
            void dismiss.run(r.data.reason);
          }}
        >
          Not a duplicate
        </Button>
      </>
    ) : (
      <>
        {step === 0 ? (
          <Button variant="secondary" onClick={() => setMode("dismiss")} disabled={loading}>
            Not a duplicate…
          </Button>
        ) : (
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button onClick={next} disabled={loading}>
            {step === 0 ? "Merge these records…" : "Next"}
          </Button>
        ) : (
          <Button
            variant="danger"
            onClick={() => {
              const r = validate(mergePatientsRequest, {
                survivorId: survivor?.id,
                mergedId: merged?.id,
                reason,
              });
              if (!r.ok) return setErrors(r.errors);
              setErrors({});
              setConfirming(true);
            }}
          >
            Merge patients
          </Button>
        )}
      </>
    );

  return (
    <>
      <Dialog
        open
        size="lg"
        onOpenChange={(o) => !o && onClose()}
        title={mode === "dismiss" ? "Dismiss duplicate candidate" : "Review possible duplicate"}
        description={`${candidate.score}% match · ${candidate.reasons.map(reasonLabel).join(", ")}`}
        footer={footer}
      >
        {mode === "dismiss" ? (
          <div className="dos-stack">
            <p style={{ margin: 0 }}>
              Both records stay as they are and this pair leaves the review queue. Explain why they
              are different people (e.g. siblings sharing a family phone).
            </p>
            <TextareaField
              label="Reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              error={errors.reason}
            />
          </div>
        ) : (
          <div className="dos-stack">
            <Steps steps={STEPS} current={step} />
            {reauth ? (
              <Alert tone="warning">
                <div>
                  <strong>Sign in again to merge.</strong> Merging is irreversible, so it needs a
                  recent sign-in. Sign out and back in, then retry; your choices here are kept until
                  you close this dialog.
                </div>
              </Alert>
            ) : null}
            {loading ? (
              a.error || b.error ? (
                <Alert tone="danger">{errorStateFor(a.error ?? b.error).description}</Alert>
              ) : (
                <Skeleton height="10rem" />
              )
            ) : step === 0 ? (
              <CompareTable pa={pa} pb={pb} rows={fieldRows} branchName={branchName} />
            ) : step === 1 ? (
              <RadioGroup
                legend="Which record should survive?"
                name="survivor"
                value={survivorId}
                onChange={(v) => {
                  setSurvivorId(v);
                  setChoices({});
                }}
                options={[pa, pb].map((p) => ({
                  value: p.id,
                  label: `${patientName(p)} · ${p.mrn ?? "No MRN"} · registered ${formatDate(p.createdAt)} at ${branchName(p.originBranchId)}`,
                  hint: "Keeps its MRN, origin branch, lifecycle and identity verification.",
                }))}
              />
            ) : step === 2 && survivor && merged ? (
              <div className="dos-stack">
                <p className="dos-muted" style={{ margin: 0 }}>
                  For each difference, choose the value the surviving record should keep. Unchanged
                  fields keep the survivor's value.
                </p>
                {conflicts.map((f) => (
                  <RadioGroup
                    key={f}
                    legend={FIELD_LABEL[f]}
                    name={`field-${f}`}
                    value={choices[f] ?? "survivor"}
                    onChange={(v) => setChoices({ ...choices, [f]: v as "survivor" | "merged" })}
                    options={[
                      { value: "survivor", label: `${display(f, survivor[f])} (survivor)` },
                      {
                        value: "merged",
                        label: `${display(f, merged[f])} (from ${patientName(merged)})`,
                      },
                    ]}
                  />
                ))}
              </div>
            ) : survivor && merged ? (
              <div className="dos-stack">
                <Alert tone="danger">
                  <div>
                    <strong>This cannot be undone.</strong> {patientName(merged)} (
                    {merged.mrn ?? "no MRN"}) will be merged into {patientName(survivor)} (
                    {survivor.mrn ?? "no MRN"}). Appointments, documents, consents, allergies and
                    alerts move to the survivor. The merged record becomes read-only and its medical
                    history versions are shown on the survivor. The merge is audited.
                  </div>
                </Alert>
                {conflicts.length ? (
                  <ul style={{ margin: 0 }}>
                    {conflicts.map((f) => (
                      <li key={f}>
                        {FIELD_LABEL[f]}:{" "}
                        <strong>
                          {display(f, (choices[f] === "merged" ? merged : survivor)[f])}
                        </strong>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <TextareaField
                  label="Reason for merge"
                  required
                  hint="At least 5 characters, e.g. 'Same person: confirmed by phone and DOB with patient at desk'."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  error={errors.reason}
                />
              </div>
            ) : null}
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Merge these patients permanently?"
        description={`${merged ? patientName(merged) : ""} will be merged into ${survivor ? patientName(survivor) : ""}. This is irreversible.`}
        confirmLabel="Yes, merge permanently"
        tone="danger"
        loading={merging}
        onConfirm={() => void doMerge()}
      />
    </>
  );
}

function CompareTable({
  pa,
  pb,
  rows,
  branchName,
}: {
  pa: PatientResponse;
  pb: PatientResponse;
  rows: { f: MergeableField; a: string; b: string; differs: boolean }[];
  branchName: (id: string) => string;
}) {
  return (
    <div className="dos-table-scroll">
      <table className="dos-table">
        <caption className="dos-sr-only">
          Side-by-side comparison; differing fields are marked
        </caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">{patientName(pa)}</th>
            <th scope="col">{patientName(pb)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">MRN</th>
            <td>{pa.mrn ?? "—"}</td>
            <td>{pb.mrn ?? "—"}</td>
          </tr>
          <tr>
            <th scope="row">Registered</th>
            <td>
              {formatDate(pa.createdAt)} · {branchName(pa.originBranchId)}
            </td>
            <td>
              {formatDate(pb.createdAt)} · {branchName(pb.originBranchId)}
            </td>
          </tr>
          <tr>
            <th scope="row">Stage</th>
            <td>{humanize(pa.lifecycleStage)}</td>
            <td>{humanize(pb.lifecycleStage)}</td>
          </tr>
          {rows.map((r) => (
            <tr
              key={r.f}
              style={r.differs ? { background: "var(--color-warning-subtle)" } : undefined}
            >
              <th scope="row">
                {FIELD_LABEL[r.f]}
                {r.differs ? <span className="dos-sr-only"> (differs)</span> : null}
              </th>
              <td>{r.a}</td>
              <td>{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
