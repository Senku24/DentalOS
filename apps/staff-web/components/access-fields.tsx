"use client";
import { Checkbox, CheckboxGroup } from "@dentalos/ui";
import { type BranchResponse, STAFF_ROLES } from "@dentalos/validation";
import { humanize } from "../lib/format";

const ROLE_HINT: Record<(typeof STAFF_ROLES)[number], string> = {
  OWNER: "Organisation settings, staff, pricing and all reports",
  MANAGER: "Branch operations, staff overview, price overrides",
  DENTIST: "Clinical workspace, charting, treatment plans",
  RECEPTIONIST: "Appointments, check-in, patient registration",
  ACCOUNTANT: "Invoices, collections, refunds, finance reports",
};

export interface AccessValue {
  roles: string[];
  orgWide: boolean;
  branchScope: string[];
}

/**
 * Roles (multi-select) + organisation-wide toggle + branch scope. Staff roles are the five
 * `STAFF_ROLES`; PATIENT is a portal identity and cannot be granted here.
 */
export function AccessFields({
  value,
  onChange,
  branches,
  errors,
}: {
  value: AccessValue;
  onChange: (v: AccessValue) => void;
  branches: BranchResponse[];
  errors: Record<string, string>;
}) {
  return (
    <div className="dos-stack">
      <CheckboxGroup
        legend="Roles"
        required
        hint="A person may hold several roles; permissions are combined."
        options={STAFF_ROLES.map((r) => ({ value: r, label: humanize(r), hint: ROLE_HINT[r] }))}
        value={value.roles}
        onChange={(roles) => onChange({ ...value, roles })}
        error={errors.roles}
        columns={2}
      />
      <Checkbox
        switch
        label="Organisation-wide access"
        hint="Access to every branch, including branches added later. Required for owner-level administration."
        checked={value.orgWide}
        onChange={(e) => onChange({ ...value, orgWide: e.target.checked })}
      />
      {!value.orgWide ? (
        <CheckboxGroup
          legend="Branch scope"
          required
          hint="Branches this person can work in."
          options={branches
            .filter((b) => b.active || value.branchScope.includes(b.id))
            .map((b) => ({ value: b.id, label: `${b.name}${b.active ? "" : " (inactive)"}` }))}
          value={value.branchScope}
          onChange={(branchScope) => onChange({ ...value, branchScope })}
          error={errors.branchScope}
          columns={2}
        />
      ) : null}
    </div>
  );
}
