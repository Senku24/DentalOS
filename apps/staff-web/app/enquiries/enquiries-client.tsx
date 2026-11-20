"use client";
import {
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Dialog,
  Input,
  PageHeader,
  SelectField,
  Spinner,
  TextField,
  TextareaField,
  useLink,
} from "@dentalos/ui";
import {
  ENQUIRY_SOURCES,
  ENQUIRY_STATUSES,
  type EnquiryResponse,
  type PatientSummary,
  createEnquiryRequest,
} from "@dentalos/validation";
import { Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BranchOptions, MockNotice, RequirePermission, useBranches } from "../../components/common";
import { api } from "../../lib/api/endpoints";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { ageFrom, formatDate, formatPhone, humanize, patientName } from "../../lib/format";
import { validate } from "../../lib/forms";
import { canDo, scopedBranchIds } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";

const statusTone = (s: string) =>
  s === "NEW" ? "info" : s === "CONTACTED" ? "warning" : s === "CONVERTED" ? "success" : "neutral";

export function EnquiriesClient() {
  return (
    <RequirePermission permission="patient:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const router = useRouter();
  const writable = canDo("patient:write");
  const { branches, name: branchName } = useBranches();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const dq = useDebounced(q.trim());
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter change restarts paging
  useEffect(() => paging.reset(), [dq, status, branchId]);
  const list = useQuery(
    () =>
      api.enquiries.list({
        q: dq || undefined,
        status: status || undefined,
        branchId: branchId || undefined,
        cursor: paging.cursor,
      }),
    [dq, status, branchId, paging.cursor],
  );
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState<EnquiryResponse | null>(null);
  const update = useMutation(
    (e: EnquiryResponse, s: "CONTACTED" | "LOST" | "NEW") =>
      api.enquiries.update(e.id, { status: s }),
    {
      success: (r) => `${r.name} marked ${humanize(r.status).toLowerCase()}`,
      onSuccess: list.reload,
    },
  );

  const columns: ColumnDef<EnquiryResponse, unknown>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
            {[formatPhone(row.original.phone), row.original.email]
              .filter((x) => x && x !== "—")
              .join(" · ")}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "areaOfInterest",
      header: "Interested in",
      cell: ({ getValue }) => (getValue() as string) ?? "—",
    },
    {
      accessorKey: "source",
      header: "Source",
      cell: ({ getValue }) => humanize(getValue() as string),
    },
    { id: "branch", header: "Branch", accessorFn: (e) => branchName(e.branchId) },
    {
      accessorKey: "createdAt",
      header: "Received",
      cell: ({ getValue }) => formatDate(getValue() as string),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <div className="dos-cluster">
          <Badge tone={statusTone(row.original.status)}>{humanize(row.original.status)}</Badge>
          {row.original.convertedPatientId ? (
            <Link href={`/patients/${row.original.convertedPatientId}`} className="dos-link">
              View patient
            </Link>
          ) : null}
        </div>
      ),
    },
    ...(writable
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: EnquiryResponse } }) => {
              const e = row.original;
              if (e.status === "CONVERTED") return null;
              return (
                <div className="dos-cluster">
                  <Button size="sm" onClick={() => router.push(`/patients/new?enquiryId=${e.id}`)}>
                    Register<span className="dos-sr-only"> {e.name} as a patient</span>
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setLinking(e)}>
                    Link existing<span className="dos-sr-only"> patient to {e.name}</span>
                  </Button>
                  {e.status === "NEW" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void update.run(e, "CONTACTED")}
                    >
                      Contacted<span className="dos-sr-only"> {e.name}</span>
                    </Button>
                  ) : null}
                  {e.status !== "LOST" ? (
                    <Button size="sm" variant="ghost" onClick={() => void update.run(e, "LOST")}>
                      Lost<span className="dos-sr-only"> {e.name}</span>
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void update.run(e, "NEW")}>
                      Reopen<span className="dos-sr-only"> {e.name}</span>
                    </Button>
                  )}
                </div>
              );
            },
          } satisfies ColumnDef<EnquiryResponse, unknown>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Enquiries"
        description="Leads from calls, walk-ins, WhatsApp and the website. Convert them to patients when they register."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Enquiries" }]}
        actions={
          writable ? (
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" /> Quick add
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <search className="dos-toolbar" aria-label="Filter enquiries">
          <div className="dos-field">
            <label className="dos-label" htmlFor="enq-search">
              Search
            </label>
            <div className="dos-input-wrap">
              <Search size={16} aria-hidden="true" />
              <Input
                id="enq-search"
                type="search"
                placeholder="Name or phone"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {ENQUIRY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">All branches</option>
            <BranchOptions branches={branches} />
          </SelectField>
        </search>
        <div>
          <DataTable
            caption="Enquiries"
            columns={columns}
            data={list.data?.items ?? []}
            getRowId={(e) => e.id}
            loading={list.loading}
            error={list.error ? errorStateFor(list.error) : undefined}
            searchable={false}
            hidePagination
            pageSize={100}
            emptyTitle="No enquiries"
            emptyDescription="Add one when someone calls or messages about treatment."
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
        </div>
      </div>
      {adding ? (
        <QuickAddDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            list.reload();
          }}
        />
      ) : null}
      {linking ? (
        <LinkDialog
          enquiry={linking}
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function QuickAddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { branches } = useBranches();
  const allowed = scopedBranchIds(branches);
  const [v, setV] = useState({
    name: "",
    phone: "",
    email: "",
    source: "PHONE",
    areaOfInterest: "",
    notes: "",
    branchId: "",
  });
  useEffect(() => {
    if (!v.branchId && allowed[0]) setV((cur) => ({ ...cur, branchId: allowed[0] ?? "" }));
  }, [allowed, v.branchId]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(api.enquiries.create, {
    success: "Enquiry added",
    onSuccess: onSaved,
    onError: (e) => setErrors(e.fieldErrors),
  });
  const submit = () => {
    const r = validate(createEnquiryRequest, v);
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  const f = (k: keyof typeof v) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }),
    error: errors[k],
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Quick add enquiry"
      description="Phone or email is required so the team can follow up."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Add enquiry
          </Button>
        </>
      }
    >
      <form
        className="dos-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField label="Name" required autoComplete="off" {...f("name")} />
        <div className="dos-form-grid">
          <TextField label="Phone" type="tel" inputMode="tel" autoComplete="off" {...f("phone")} />
          <TextField label="Email" type="email" autoComplete="off" {...f("email")} />
          <SelectField label="Source" {...f("source")}>
            {ENQUIRY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
          <SelectField label="Branch" {...f("branchId")}>
            <BranchOptions branches={branches} ids={allowed} />
          </SelectField>
        </div>
        <TextField
          label="Interested in"
          hint="e.g. braces, implants, whitening"
          {...f("areaOfInterest")}
        />
        <TextareaField label="Notes" {...f("notes")} />
      </form>
    </Dialog>
  );
}

function LinkDialog({
  enquiry,
  onClose,
  onDone,
}: { enquiry: EnquiryResponse; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState(enquiry.phone?.replace("+91", "") ?? enquiry.name);
  const dq = useDebounced(q.trim());
  const results = useQuery(() => api.patients.search({ q: dq, limit: 8 }), [dq], dq.length >= 2);
  const [picked, setPicked] = useState<PatientSummary | null>(null);
  const convert = useMutation(
    (id: string) => api.enquiries.convert(enquiry.id, { existingPatientId: id }),
    {
      success: "Enquiry linked to patient",
      onSuccess: onDone,
    },
  );
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={`Link ${enquiry.name} to an existing patient`}
      description="Use this when the person is already registered. The enquiry is marked converted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!picked}
            loading={convert.pending}
            onClick={() => picked && void convert.run(picked.id)}
          >
            Link patient
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <TextField
          label="Find patient"
          hint="Name, phone or MRN"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div aria-live="polite">
          {results.loading ? (
            <Spinner label="Searching" />
          ) : results.data?.items.length ? (
            <fieldset className="dos-fieldset">
              <legend className="dos-sr-only">Matching patients</legend>
              {results.data.items.map((p) => (
                <div className="dos-check" key={p.id}>
                  <input
                    id={`pick-${p.id}`}
                    type="radio"
                    name="pick-patient"
                    className="dos-check__input"
                    checked={picked?.id === p.id}
                    onChange={() => setPicked(p)}
                  />
                  <label htmlFor={`pick-${p.id}`} className="dos-check__label">
                    {patientName(p)} · {p.mrn ?? "No MRN"} · {formatPhone(p.phone)}
                    {p.dob ? ` · ${ageFrom(p.dob)} y` : ""}
                  </label>
                </div>
              ))}
            </fieldset>
          ) : dq.length >= 2 ? (
            <p className="dos-muted">No patients found.</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
