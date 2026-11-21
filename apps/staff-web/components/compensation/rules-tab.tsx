"use client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  type ColumnDef,
  CursorPager,
  DataTable,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  COMMISSION_RULE_TYPES,
  type CommissionRuleResponse,
  type CommissionRuleType,
  closeCommissionRuleRequest,
  createCommissionRuleRequest,
  ruleInForce,
  supersedeCommissionRuleRequest,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { commissionsApi } from "../../lib/api/commissions";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDate, formatPaise, todayISO } from "../../lib/format";
import { type FieldErrors, rupeesToPaise, validate } from "../../lib/forms";
import { useCursorPaging } from "../../lib/use-cursor";
import {
  DentistField,
  RULE_TYPE_HELP,
  RULE_TYPE_LABEL,
  describeRule,
  percentToBp,
  useCategories,
  useCompensationScope,
  useDentists,
} from "./bits";

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Earliest allowed date: today, and strictly after the start of the rule being changed. */
const earliestAfter = (ruleFrom: string, today: string) => {
  const next = addDays(ruleFrom, 1);
  return next > today ? next : today;
};

/** Commission rules: effective-dated and never edited. A change closes the open rule and inserts the new one. */
export function RulesTab({ rev, onChanged }: { rev: number; onChanged: () => void }) {
  const { all, manage } = useCompensationScope();
  const { dentists, name: dentistName } = useDentists();
  const cats = useCategories();
  const [dentist, setDentist] = useState("");
  const [defaultsOnly, setDefaultsOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [dentist, defaultsOnly, openOnly]);
  const [local, setLocal] = useState(0);
  const list = useQuery(
    () =>
      commissionsApi.rules.list({
        dentistUserId: all ? dentist || undefined : undefined,
        defaultsOnly: defaultsOnly || undefined,
        open: openOnly || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [all, dentist, defaultsOnly, openOnly, paging.cursor, rev, local],
  );
  const [creating, setCreating] = useState(false);
  const [superseding, setSuperseding] = useState<CommissionRuleResponse | null>(null);
  const [closing, setClosing] = useState<CommissionRuleResponse | null>(null);
  const today = todayISO();
  const changed = () => {
    setLocal((n) => n + 1);
    onChanged();
  };

  const columns: ColumnDef<CommissionRuleResponse, unknown>[] = [
    { id: "who", header: "Applies to", accessorFn: (r) => dentistName(r.dentistUserId) },
    { id: "cat", header: "Service category", accessorFn: (r) => cats.name(r.serviceCategoryId) },
    {
      id: "basis",
      header: "Commission",
      accessorFn: (r) => describeRule(r),
      cell: ({ row }) => (
        <div>
          <div>{describeRule(row.original)}</div>
          <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
            {RULE_TYPE_LABEL[row.original.type]}
          </div>
        </div>
      ),
    },
    {
      id: "from",
      header: "From",
      accessorFn: (r) => r.effectiveFrom,
      cell: ({ row }) => formatDate(row.original.effectiveFrom),
    },
    {
      id: "to",
      header: "Until (excl.)",
      accessorFn: (r) => r.effectiveTo ?? "9999",
      cell: ({ row }) => (row.original.effectiveTo ? formatDate(row.original.effectiveTo) : "Open"),
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (r) => r.effectiveTo ?? "open",
      cell: ({ row }) => {
        const r = row.original;
        if (r.effectiveTo && r.effectiveTo <= today) return <Badge tone="neutral">Ended</Badge>;
        if (r.effectiveFrom > today) return <Badge tone="info">Scheduled</Badge>;
        return ruleInForce(r, today) ? (
          <Badge tone="success">{r.effectiveTo ? "In force, ending" : "In force"}</Badge>
        ) : (
          <Badge tone="neutral">Ended</Badge>
        );
      },
    },
    {
      id: "note",
      header: "Note",
      enableSorting: false,
      cell: ({ row }) => row.original.note ?? "—",
    },
    ...(manage
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: CommissionRuleResponse } }) =>
              row.original.effectiveTo === null ? (
                <div className="dos-cluster">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setSuperseding(row.original)}
                  >
                    Replace
                    <span className="dos-sr-only">
                      {" "}
                      rule for {dentistName(row.original.dentistUserId)}
                    </span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setClosing(row.original)}>
                    End
                    <span className="dos-sr-only">
                      {" "}
                      rule for {dentistName(row.original.dentistUserId)}
                    </span>
                  </Button>
                </div>
              ) : null,
          } satisfies ColumnDef<CommissionRuleResponse, unknown>,
        ]
      : []),
  ];

  return (
    <div className="dos-stack">
      <Alert tone="info">
        Rules are effective-dated and never edited or back-dated; the rule in force on the invoice's
        issue date decides the commission. Order of precedence: dentist and category, then dentist,
        then default and category, then default. With no matching rule a line earns no commission.
      </Alert>
      <search className="dos-toolbar" aria-label="Filter rules">
        {all ? (
          <DentistField
            value={dentist}
            onChange={setDentist}
            dentists={dentists}
            allLabel="All dentists"
          />
        ) : null}
        <div className="dos-field">
          <span className="dos-label">Show</span>
          <div className="dos-cluster">
            <Checkbox
              label="Defaults only"
              checked={defaultsOnly}
              onChange={(e) => setDefaultsOnly(e.target.checked)}
            />
            <Checkbox
              label="Open rules only"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
            />
          </div>
        </div>
        {manage ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> New rule
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Commission rules"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No commission rules"
          emptyDescription="Until a rule exists, nothing accrues. Add a default rule for everyone, then exceptions per dentist or category."
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
      {creating ? (
        <RuleDialog
          dentists={dentists}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            changed();
          }}
        />
      ) : null}
      {superseding ? (
        <RuleDialog
          replacing={superseding}
          dentists={dentists}
          onClose={() => setSuperseding(null)}
          onDone={() => {
            setSuperseding(null);
            changed();
          }}
        />
      ) : null}
      {closing ? (
        <CloseDialog
          rule={closing}
          who={dentistName(closing.dentistUserId)}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            changed();
          }}
        />
      ) : null}
    </div>
  );
}

// ---- New rule / replace rule -------------------------------------------------------------------------------
function RuleDialog({
  replacing,
  dentists,
  onClose,
  onDone,
}: {
  /** Set = supersede this rule (scope fixed); unset = create a new rule. */
  replacing?: CommissionRuleResponse;
  dentists: { userId: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const cats = useCategories();
  const today = todayISO();
  const earliest = replacing ? earliestAfter(replacing.effectiveFrom, today) : today;
  const [dentistUserId, setDentist] = useState("");
  const [serviceCategoryId, setCategory] = useState("");
  const [type, setType] = useState<CommissionRuleType>(replacing?.type ?? "PERCENT_OF_COLLECTED");
  const [percent, setPercent] = useState(
    replacing?.percentBp != null ? String(replacing.percentBp / 100) : "",
  );
  const [fixed, setFixed] = useState(
    replacing?.fixedPaise != null ? String(replacing.fixedPaise / 100) : "",
  );
  const [effectiveFrom, setFrom] = useState(earliest);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const save = useMutation(
    (body: unknown) =>
      replacing
        ? commissionsApi.rules.supersede(replacing.id, body as never)
        : commissionsApi.rules.create(body as never),
    {
      success: replacing ? "Rule replaced" : "Rule added",
      onSuccess: onDone,
      onError: (e) => {
        setErrors(e.fieldErrors);
        setFormError(Object.keys(e.fieldErrors).length === 0 ? e.message : undefined);
      },
    },
  );

  const submit = () => {
    const isFixed = type === "FIXED_PER_PROCEDURE";
    const bp = percentToBp(percent);
    const paise = fixed.trim() === "" ? undefined : rupeesToPaise(fixed);
    const base = {
      type,
      ...(isFixed ? { fixedPaise: paise ?? undefined } : { percentBp: bp }),
      effectiveFrom,
      note,
    };
    const r = replacing
      ? validate(supersedeCommissionRuleRequest, base)
      : validate(createCommissionRuleRequest, { ...base, dentistUserId, serviceCategoryId });
    if (!r.ok) {
      const { _form, ...e } = r.errors;
      if (_form) e[isFixed ? "fixedPaise" : "percentBp"] = _form;
      if (!isFixed && percent.trim() !== "" && Number.isNaN(bp))
        e.percentBp = "Enter a percentage like 27.5";
      if (isFixed && fixed.trim() !== "" && paise === null)
        e.fixedPaise = "Enter an amount like 1,500";
      if (!isFixed && bp !== undefined && !Number.isNaN(bp) && bp > 10_000)
        e.percentBp = "At most 100%";
      return setErrors(e);
    }
    if (effectiveFrom < today) return setErrors({ effectiveFrom: "Rules are never back-dated" });
    if (replacing && effectiveFrom <= replacing.effectiveFrom)
      return setErrors({ effectiveFrom: "Must be after the start of the rule being replaced" });
    setErrors({});
    setFormError(undefined);
    void save.run(r.data);
  };

  const preview =
    type === "FIXED_PER_PROCEDURE"
      ? fixed.trim() !== "" && rupeesToPaise(fixed) !== null
        ? `${formatPaise(rupeesToPaise(fixed) ?? 0)} per procedure`
        : null
      : percent.trim() !== "" &&
          percentToBp(percent) !== undefined &&
          !Number.isNaN(percentToBp(percent))
        ? describeRule({ type, percentBp: percentToBp(percent) ?? 0, fixedPaise: null })
        : null;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={replacing ? "Replace commission rule" : "New commission rule"}
      description={
        replacing
          ? "The current rule ends on the new start date and the new rule begins that day. Entries already booked keep the rule they were calculated under."
          : "Applies from the start date onwards. Rules are never back-dated."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            {replacing ? "Replace rule" : "Add rule"}
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
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {replacing ? (
          <Alert tone="info">
            Replacing: {describeRule(replacing)} for{" "}
            {replacing.dentistUserId
              ? (dentists.find((d) => d.userId === replacing.dentistUserId)?.name ?? "this dentist")
              : "everyone"}
            , from {formatDate(replacing.effectiveFrom)}.
          </Alert>
        ) : (
          <div className="dos-form-grid">
            <DentistField
              dentists={dentists}
              value={dentistUserId}
              onChange={setDentist}
              allLabel="Everyone (default rule)"
              error={errors.dentistUserId}
            />
            <SelectField
              label="Service category"
              value={serviceCategoryId}
              error={errors.serviceCategoryId}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {cats.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          </div>
        )}
        <SelectField
          label="Commission basis"
          value={type}
          hint={RULE_TYPE_HELP[type]}
          onChange={(e) => setType(e.target.value as CommissionRuleType)}
        >
          {COMMISSION_RULE_TYPES.map((t) => (
            <option key={t} value={t}>
              {RULE_TYPE_LABEL[t]}
            </option>
          ))}
        </SelectField>
        <div className="dos-form-grid">
          {type === "FIXED_PER_PROCEDURE" ? (
            <TextField
              label="Amount per procedure (₹)"
              required
              inputMode="decimal"
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
              error={errors.fixedPaise}
            />
          ) : (
            <TextField
              label="Percentage (%)"
              required
              inputMode="decimal"
              hint="Up to two decimals, for example 27.5"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              error={errors.percentBp}
            />
          )}
          <TextField
            label="Starts on"
            type="date"
            required
            min={earliest}
            value={effectiveFrom}
            onChange={(e) => setFrom(e.target.value)}
            error={errors.effectiveFrom}
          />
        </div>
        {preview ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            From {formatDate(effectiveFrom)}: {preview}.
          </p>
        ) : null}
        <TextareaField
          label="Note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />
      </form>
    </Dialog>
  );
}

// ---- End a rule ---------------------------------------------------------------------------------------------
function CloseDialog({
  rule,
  who,
  onClose,
  onDone,
}: { rule: CommissionRuleResponse; who: string; onClose: () => void; onDone: () => void }) {
  const today = todayISO();
  const earliest = earliestAfter(rule.effectiveFrom, today);
  const [effectiveTo, setTo] = useState(earliest);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (body: { effectiveTo: string }) => commissionsApi.rules.close(rule.id, body),
    {
      success: "Rule ended",
      onSuccess: onDone,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const submit = () => {
    const r = validate(closeCommissionRuleRequest, { effectiveTo });
    if (!r.ok) return setErrors(r.errors);
    if (effectiveTo < today) return setErrors({ effectiveTo: "Rules are never back-dated" });
    if (effectiveTo <= rule.effectiveFrom)
      return setErrors({ effectiveTo: "Must be after the start of the rule" });
    setErrors({});
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="End commission rule"
      description={`${describeRule(rule)} for ${who}, from ${formatDate(rule.effectiveFrom)}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" loading={save.pending} onClick={submit}>
            End rule
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
        <TextField
          label="Last day is the day before"
          type="date"
          required
          min={earliest}
          value={effectiveTo}
          onChange={(e) => setTo(e.target.value)}
          error={errors.effectiveTo}
          hint="The rule stops applying on this date. Invoices issued from then on fall back to a broader rule, or earn no commission if none applies."
        />
      </form>
    </Dialog>
  );
}
