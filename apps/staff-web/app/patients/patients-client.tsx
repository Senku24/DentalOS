"use client";
import {
  Badge,
  Button,
  Checkbox,
  type ColumnDef,
  CursorPager,
  DataTable,
  Input,
  PageHeader,
  SelectField,
  useLink,
} from "@dentalos/ui";
import { INTAKE_TYPES, PATIENT_LIFECYCLE_STAGES, type PatientSummary } from "@dentalos/validation";
import { CopyCheck, Search, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BranchOptions, MockNotice, RequirePermission, useBranches } from "../../components/common";
import { api } from "../../lib/api/endpoints";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { ageFrom, formatPhone, humanize, lifecycleTone, patientName } from "../../lib/format";
import { canDo } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";

export function PatientsClient() {
  return (
    <RequirePermission permission="patient:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const router = useRouter();
  const { branches, name: branchName } = useBranches();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [intake, setIntake] = useState("");
  const [branch, setBranch] = useState("");
  const [includeMerged, setIncludeMerged] = useState(false);
  const dq = useDebounced(q.trim());
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: any filter change restarts paging
  useEffect(() => paging.reset(), [dq, stage, intake, branch, includeMerged]);

  const list = useQuery(
    () =>
      api.patients.search({
        q: dq || undefined,
        lifecycleStage: stage || undefined,
        intakeType: intake || undefined,
        originBranchId: branch || undefined,
        includeMerged: includeMerged || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [dq, stage, intake, branch, includeMerged, paging.cursor],
  );

  const columns: ColumnDef<PatientSummary, unknown>[] = [
    {
      id: "name",
      header: "Patient",
      accessorFn: (p) => patientName(p),
      cell: ({ row }) => {
        const p = row.original;
        return (
          <div>
            <Link href={`/patients/${p.id}`} className="dos-link">
              {patientName(p)}
            </Link>
            {p.mergedIntoId ? (
              <>
                {" "}
                <Badge tone="neutral">Merged</Badge>
              </>
            ) : null}
            <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
              {p.mrn ?? "No MRN"}
            </div>
          </div>
        );
      },
    },
    {
      id: "age",
      header: "Age / sex",
      accessorFn: (p) => ageFrom(p.dob) ?? -1,
      cell: ({ row }) => {
        const a = ageFrom(row.original.dob);
        return `${a === null ? "—" : `${a} y`} · ${humanize(row.original.sex)}`;
      },
    },
    {
      accessorKey: "phone",
      header: "Phone",
      enableSorting: false,
      cell: ({ getValue }) => formatPhone(getValue() as string | null),
    },
    { id: "branch", header: "Registered at", accessorFn: (p) => branchName(p.originBranchId) },
    {
      accessorKey: "lifecycleStage",
      header: "Stage",
      cell: ({ getValue }) => {
        const s = getValue() as string;
        return <Badge tone={lifecycleTone(s)}>{humanize(s)}</Badge>;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Patients"
        description="One shared profile per patient across every branch of your organisation"
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Patients" }]}
        actions={
          <>
            {canDo("patient:merge") ? (
              <Button variant="secondary" onClick={() => router.push("/patients/duplicates")}>
                <CopyCheck size={16} aria-hidden="true" /> Review duplicates
              </Button>
            ) : null}
            {canDo("patient:write") ? (
              <Button onClick={() => router.push("/patients/new")}>
                <UserPlus size={16} aria-hidden="true" /> New patient
              </Button>
            ) : null}
          </>
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <search className="dos-toolbar" aria-label="Filter patients">
          <div className="dos-field">
            <label className="dos-label" htmlFor="patient-search">
              Search
            </label>
            <div className="dos-input-wrap">
              <Search size={16} aria-hidden="true" />
              <Input
                id="patient-search"
                type="search"
                placeholder="Name, phone, MRN or email"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <SelectField label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">All stages</option>
            {PATIENT_LIFECYCLE_STAGES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
          <SelectField label="Intake" value={intake} onChange={(e) => setIntake(e.target.value)}>
            <option value="">All intake types</option>
            {INTAKE_TYPES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Registered at"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">All branches</option>
            <BranchOptions branches={branches} includeInactive />
          </SelectField>
          <div style={{ paddingBottom: 8 }}>
            <Checkbox
              label="Include merged records"
              checked={includeMerged}
              onChange={(e) => setIncludeMerged(e.target.checked)}
            />
          </div>
        </search>
        <div>
          <DataTable
            caption="Patients"
            columns={columns}
            data={list.data?.items ?? []}
            getRowId={(p) => p.id}
            loading={list.loading}
            error={
              list.error
                ? {
                    ...errorStateFor(list.error),
                    action: (
                      <Button variant="secondary" onClick={list.reload}>
                        Try again
                      </Button>
                    ),
                  }
                : undefined
            }
            searchable={false}
            hidePagination
            pageSize={100}
            emptyTitle={dq || stage || intake || branch ? "No patients match" : "No patients yet"}
            emptyDescription={
              dq
                ? "Check the spelling or search by phone number instead."
                : "Register a patient to get started."
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
        </div>
      </div>
    </>
  );
}
