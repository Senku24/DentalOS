"use client";
import {
  Alert,
  Button,
  PageHeader,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from "@dentalos/ui";
import {
  type CreatePatientRequest,
  SEXES,
  createPatientRequest,
  duplicateCheckRequest,
} from "@dentalos/validation";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  BranchOptions,
  MockNotice,
  RequirePermission,
  Section,
  useBranches,
} from "../../../components/common";
import { type DuplicateMatch, DuplicateMatchList } from "../../../components/patient-bits";
import { api } from "../../../lib/api/endpoints";
import { asApiError } from "../../../lib/api/errors";
import { humanize } from "../../../lib/format";
import { cleanEmpty, validate } from "../../../lib/forms";
import { scopedBranchIds } from "../../../lib/session";
import { useDebounced } from "../../../lib/use-debounced";

type Intake = "APPOINTMENT" | "WALK_IN" | "URGENT";

const INTAKE_OPTIONS: { value: Intake; label: string; hint: string }[] = [
  { value: "APPOINTMENT", label: "Appointment", hint: "Booking ahead: capture full details" },
  { value: "WALK_IN", label: "Walk-in", hint: "Patient is at the front desk now" },
  {
    value: "URGENT",
    label: "Urgent / emergency",
    hint: "Minimal details now, complete the profile later",
  },
];

const EMPTY = {
  firstName: "",
  middleName: "",
  lastName: "",
  preferredName: "",
  dob: "",
  sex: "UNKNOWN",
  phone: "",
  altPhone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
};
type Values = typeof EMPTY;

export function IntakeClient() {
  return (
    <RequirePermission permission="patient:write">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const enquiryId = params.get("enquiryId") ?? undefined;
  const { toast } = useToast();
  const { branches, name: branchName } = useBranches();
  const allowed = scopedBranchIds(branches);
  const [intake, setIntake] = useState<Intake>("WALK_IN");
  const [originBranchId, setOriginBranchId] = useState("");
  const [v, setV] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState<DuplicateMatch[] | null>(null);
  const urgent = intake === "URGENT";

  useEffect(() => {
    if (!originBranchId && allowed[0]) setOriginBranchId(allowed[0]);
  }, [allowed, originBranchId]);

  // Converting an enquiry: prefill name/phone/email from it.
  useEffect(() => {
    if (!enquiryId) return;
    api.enquiries.get(enquiryId).then(
      (e) => {
        const [first, ...rest] = e.name.split(" ");
        setV((cur) => ({
          ...cur,
          firstName: first ?? "",
          lastName: rest.join(" "),
          phone: e.phone ?? "",
          email: e.email ?? "",
        }));
        if (e.branchId) setOriginBranchId(e.branchId);
        setIntake("APPOINTMENT");
      },
      () => toast({ tone: "danger", title: "Couldn't load the enquiry" }),
    );
  }, [enquiryId, toast]);

  const set = (k: keyof Values) => (e: { target: { value: string } }) => {
    setV((cur) => ({ ...cur, [k]: e.target.value }));
    setErrors(({ [k]: _, ...rest }) => rest);
  };
  const field = (k: keyof Values) => ({ value: v[k], onChange: set(k), error: errors[k], name: k });

  // ---- Live duplicate pre-check (debounced; only fields that are already valid are sent) ----
  const probe = useDebounced(
    useMemo(
      () => ({
        firstName: v.firstName,
        lastName: v.lastName,
        dob: v.dob,
        phone: v.phone,
        email: v.email,
      }),
      [v.firstName, v.lastName, v.dob, v.phone, v.email],
    ),
    450,
  );
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const raw = cleanEmpty(probe) as Record<string, string | undefined>;
    if (
      !raw.firstName ||
      raw.firstName.length < 2 ||
      !(raw.phone || raw.lastName || raw.dob || raw.email)
    ) {
      setMatches([]);
      return;
    }
    // Drop fields that do not validate yet (e.g. a half-typed phone) rather than skipping the check.
    const body: Record<string, string> = {};
    for (const [k, val] of Object.entries(raw)) {
      if (val === undefined) continue;
      const one = duplicateCheckRequest.safeParse({ firstName: raw.firstName, [k]: val });
      if (one.success) body[k] = val;
    }
    const parsed = duplicateCheckRequest.safeParse(body);
    if (!parsed.success) return;
    let live = true;
    setChecking(true);
    api.patients
      .duplicateCheck(parsed.data)
      .then(
        (r) => live && setMatches(r.matches),
        () => live && setMatches([]),
      )
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [probe]);

  const submit = async (acknowledgeDuplicates: boolean) => {
    const raw = urgent
      ? { firstName: v.firstName, lastName: v.lastName, phone: v.phone, sex: v.sex }
      : { ...v };
    const r = validate(createPatientRequest, {
      ...raw,
      originBranchId,
      intakeType: enquiryId && intake === "APPOINTMENT" ? "APPOINTMENT" : intake,
      enquiryId,
      acknowledgeDuplicates,
    });
    if (!r.ok) {
      setErrors(r.errors);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('#intake-form [aria-invalid="true"]')?.focus(),
      );
      return;
    }
    setPending(true);
    try {
      const created = await api.patients.create(r.data as CreatePatientRequest);
      toast({
        tone: "success",
        title: `${created.firstName} registered`,
        description: created.possibleDuplicates?.length
          ? "Possible duplicates were flagged for review."
          : undefined,
      });
      router.push(`/patients/${created.id}`);
    } catch (e) {
      const err = asApiError(e);
      if (err.isPossibleDuplicates) {
        setBlocked((err.body.matches as DuplicateMatch[] | undefined) ?? matches);
        requestAnimationFrame(() => document.getElementById("dup-blocked")?.focus());
      } else if (Object.keys(err.fieldErrors).length) {
        setErrors(err.fieldErrors);
      } else {
        toast({ tone: "danger", title: "Couldn't register patient", description: err.message });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={enquiryId ? "Convert enquiry to patient" : "New patient"}
        description="Check the duplicate panel before creating: the same person may already be registered at another branch."
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Patients", href: "/patients" },
          { label: "New patient" },
        ]}
      />
      <div className="dos-stack">
        <MockNotice />
        <div className="dos-split">
          <form
            id="intake-form"
            noValidate
            className="dos-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            <Section title="Intake">
              <RadioGroup
                legend="Intake type"
                name="intake"
                value={intake}
                onChange={(x) => setIntake(x as Intake)}
                options={INTAKE_OPTIONS}
              />
              <SelectField
                label="Registering branch"
                required
                hint="Recorded as the patient's origin branch. It cannot be changed later."
                value={originBranchId}
                onChange={(e) => setOriginBranchId(e.target.value)}
                error={errors.originBranchId}
              >
                <option value="">Select a branch</option>
                <BranchOptions branches={branches} ids={allowed} />
              </SelectField>
              {urgent ? (
                <Alert tone="warning">
                  Urgent intake records only the essentials so care is not delayed. It is never
                  blocked by the duplicate check; complete the profile and review duplicates once
                  the patient is stable.
                </Alert>
              ) : null}
            </Section>

            <Section title="Identity">
              <div className="dos-form-grid">
                <TextField label="First name" required autoComplete="off" {...field("firstName")} />
                <TextField label="Last name" autoComplete="off" {...field("lastName")} />
                {!urgent ? (
                  <>
                    <TextField label="Middle name" autoComplete="off" {...field("middleName")} />
                    <TextField
                      label="Preferred name"
                      autoComplete="off"
                      {...field("preferredName")}
                    />
                    <TextField
                      label="Date of birth"
                      type="date"
                      max={new Date().toISOString().slice(0, 10)}
                      {...field("dob")}
                    />
                  </>
                ) : null}
                <SelectField label="Sex" {...field("sex")}>
                  {SEXES.map((s) => (
                    <option key={s} value={s}>
                      {humanize(s)}
                    </option>
                  ))}
                </SelectField>
              </div>
            </Section>

            <Section title="Contact">
              <div className="dos-form-grid">
                <TextField
                  label="Mobile number"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  hint="10-digit Indian mobile, or +country code"
                  {...field("phone")}
                />
                {!urgent ? (
                  <>
                    <TextField
                      label="Alternate number"
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      {...field("altPhone")}
                    />
                    <TextField
                      label="Email"
                      type="email"
                      autoComplete="off"
                      className=""
                      {...field("email")}
                    />
                  </>
                ) : null}
              </div>
            </Section>

            {!urgent ? (
              <Section title="Address">
                <div className="dos-form-grid">
                  <TextField label="Address line 1" autoComplete="off" {...field("addressLine1")} />
                  <TextField label="Address line 2" autoComplete="off" {...field("addressLine2")} />
                  <TextField label="City" autoComplete="off" {...field("city")} />
                  <TextField label="State" autoComplete="off" {...field("state")} />
                  <TextField
                    label="PIN code"
                    inputMode="numeric"
                    autoComplete="off"
                    {...field("postalCode")}
                  />
                </div>
              </Section>
            ) : null}

            {blocked ? (
              <section
                id="dup-blocked"
                tabIndex={-1}
                className="dos-card dos-stack"
                aria-labelledby="dup-blocked-title"
              >
                <h2 id="dup-blocked-title" className="dos-section-title">
                  Possible duplicates found
                </h2>
                <p className="dos-muted" style={{ margin: 0 }}>
                  The server found existing patients that may be the same person. Open a match to
                  use that record, or create a new record if you are sure this is a different
                  person. Your decision is audited.
                </p>
                <DuplicateMatchList matches={blocked} branchName={branchName} />
                <div className="dos-cluster">
                  <Button variant="secondary" onClick={() => setBlocked(null)}>
                    Back to form
                  </Button>
                  <Button loading={pending} onClick={() => void submit(true)}>
                    Create new patient anyway
                  </Button>
                </div>
              </section>
            ) : (
              <div className="dos-cluster">
                <Button variant="secondary" onClick={() => router.push("/patients")}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending}>
                  {urgent ? "Register urgent patient" : "Register patient"}
                </Button>
              </div>
            )}
          </form>

          <aside aria-labelledby="dup-panel-title" style={{ position: "sticky", top: 72 }}>
            <section className="dos-card dos-stack" aria-live="polite">
              <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
                <h2 id="dup-panel-title" className="dos-section-title" style={{ margin: 0 }}>
                  Duplicate check
                </h2>
                {checking ? <Spinner label="Checking for duplicates" /> : null}
              </div>
              {matches.length === 0 ? (
                <p className="dos-muted" style={{ margin: 0 }}>
                  {v.firstName.trim().length < 2
                    ? "Enter a name plus a phone, surname or date of birth to check for existing records."
                    : checking
                      ? "Checking…"
                      : "No likely duplicates found."}
                </p>
              ) : (
                <>
                  <Alert tone="warning">
                    {matches.length} existing patient{matches.length === 1 ? "" : "s"} may be the
                    same person. Open the record instead of creating a new one if it matches.
                  </Alert>
                  <DuplicateMatchList matches={matches} branchName={branchName} />
                </>
              )}
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
