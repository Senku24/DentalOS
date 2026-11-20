"use client";
import { Button, DescriptionList, Dialog, Drawer, SelectField, TextField } from "@dentalos/ui";
import {
  IDENTITY_DOCUMENT_TYPES,
  IDENTITY_VERIFICATION_METHODS,
  updatePatientRequest,
  verifyIdentityRequest,
} from "@dentalos/validation";
import { useState } from "react";
import { Section } from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import { useMutation } from "../../../lib/api/hooks";
import { formatDate, formatDateTime, formatPhone, humanize } from "../../../lib/format";
import { changedFields, validate } from "../../../lib/forms";
import { canDo } from "../../../lib/session";
import { useProfile } from "./profile-context";

export function OverviewTab() {
  const { patient: p, readOnly } = useProfile();
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const writable = canDo("patient:write") && !readOnly;
  const address = [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="dos-split">
      <Section
        title="Details"
        actions={
          writable ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          ) : undefined
        }
      >
        <DescriptionList
          items={[
            {
              term: "Full name",
              detail: [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" "),
            },
            { term: "Preferred name", detail: p.preferredName },
            { term: "Date of birth", detail: formatDate(p.dob) },
            { term: "Sex", detail: humanize(p.sex) },
            { term: "Mobile", detail: formatPhone(p.phone) },
            { term: "Alternate number", detail: p.altPhone ? formatPhone(p.altPhone) : null },
            { term: "Email", detail: p.email },
            { term: "Address", detail: address || null },
            { term: "Registered", detail: formatDateTime(p.createdAt) },
            { term: "Last updated", detail: formatDateTime(p.updatedAt) },
          ]}
        />
      </Section>
      <Section
        title="Identity verification"
        actions={
          writable && !p.identityVerifiedAt ? (
            <Button size="sm" variant="secondary" onClick={() => setVerifying(true)}>
              Verify identity
            </Button>
          ) : undefined
        }
      >
        {p.identityVerifiedAt ? (
          <DescriptionList
            columns={1}
            items={[
              { term: "Verified", detail: formatDateTime(p.identityVerifiedAt) },
              { term: "Method", detail: humanize(p.identityVerificationMethod) },
            ]}
          />
        ) : (
          <p className="dos-muted" style={{ margin: 0 }}>
            Not verified yet. Check an identity document in person, or confirm by OTP, before
            treatment consent.
          </p>
        )}
      </Section>
      {editing ? <EditDrawer onClose={() => setEditing(false)} /> : null}
      {verifying ? <VerifyDialog onClose={() => setVerifying(false)} /> : null}
    </div>
  );
}

function EditDrawer({ onClose }: { onClose: () => void }) {
  const { patient: p, reloadPatient, onWriteError } = useProfile();
  const [v, setV] = useState({
    firstName: p.firstName,
    middleName: p.middleName ?? "",
    lastName: p.lastName ?? "",
    preferredName: p.preferredName ?? "",
    dob: p.dob ?? "",
    phone: p.phone ?? "",
    altPhone: p.altPhone ?? "",
    email: p.email ?? "",
    addressLine1: p.addressLine1 ?? "",
    addressLine2: p.addressLine2 ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    postalCode: p.postalCode ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation((b: Record<string, unknown>) => api.patients.update(p.id, b), {
    success: "Patient details saved",
    onSuccess: () => {
      reloadPatient();
      onClose();
    },
    onError: (e) => {
      setErrors(e.fieldErrors);
      onWriteError(e);
    },
  });
  const submit = () => {
    const r = validate(updatePatientRequest, v);
    if (!r.ok) return setErrors(r.errors);
    // Only changed keys: the API applies exactly what it receives.
    const body = changedFields(
      Object.fromEntries(Object.keys(v).map((k) => [k, (r.data as Record<string, unknown>)[k]])),
      p as unknown as Record<string, unknown>,
    );
    if (Object.keys(body).length === 0) return onClose();
    void save.run(body);
  };
  const f = (k: keyof typeof v) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }),
    error: errors[k],
  });
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit patient details"
      description="Changes are audited. Registration branch and intake type cannot be changed."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="dos-form-grid">
        <TextField label="First name" required {...f("firstName")} />
        <TextField label="Middle name" {...f("middleName")} />
        <TextField label="Last name" {...f("lastName")} />
        <TextField label="Preferred name" {...f("preferredName")} />
        <TextField label="Date of birth" type="date" {...f("dob")} />
        <TextField label="Mobile" type="tel" inputMode="tel" {...f("phone")} />
        <TextField label="Alternate number" type="tel" inputMode="tel" {...f("altPhone")} />
        <TextField label="Email" type="email" {...f("email")} />
        <TextField label="Address line 1" {...f("addressLine1")} />
        <TextField label="Address line 2" {...f("addressLine2")} />
        <TextField label="City" {...f("city")} />
        <TextField label="State" {...f("state")} />
        <TextField label="PIN code" inputMode="numeric" {...f("postalCode")} />
      </div>
    </Drawer>
  );
}

function VerifyDialog({ onClose }: { onClose: () => void }) {
  const { patient: p, reloadPatient, onWriteError } = useProfile();
  const [v, setV] = useState({ method: "IN_PERSON_DOCUMENT", documentType: "", documentLast4: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const verify = useMutation(
    (b: ReturnType<typeof verifyIdentityRequest.parse>) => api.patients.verifyIdentity(p.id, b),
    {
      success: "Identity verified",
      onSuccess: () => {
        reloadPatient();
        onClose();
      },
      onError: onWriteError,
    },
  );
  const submit = () => {
    const r = validate(verifyIdentityRequest, v);
    if (!r.ok) return setErrors(r.errors);
    void verify.run(r.data);
  };
  const inPerson = v.method === "IN_PERSON_DOCUMENT";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Verify identity"
      description="Never record a full Aadhaar or other government ID number: only the last 4 characters."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={verify.pending} onClick={submit}>
            Mark verified
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField
          label="Method"
          value={v.method}
          onChange={(e) => setV({ ...v, method: e.target.value })}
        >
          {IDENTITY_VERIFICATION_METHODS.map((m) => (
            <option key={m} value={m}>
              {humanize(m)}
            </option>
          ))}
        </SelectField>
        {inPerson ? (
          <>
            <SelectField
              label="Document type"
              value={v.documentType}
              onChange={(e) => setV({ ...v, documentType: e.target.value })}
              error={errors.documentType}
            >
              <option value="">Select</option>
              {IDENTITY_DOCUMENT_TYPES.map((m) => (
                <option key={m} value={m}>
                  {humanize(m)}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Last 4 characters of the document number"
              maxLength={4}
              autoComplete="off"
              value={v.documentLast4}
              onChange={(e) => setV({ ...v, documentLast4: e.target.value })}
              error={errors.documentLast4}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
