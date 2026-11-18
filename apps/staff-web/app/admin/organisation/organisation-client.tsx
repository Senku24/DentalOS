"use client";
import { type TenantResponse, updateTenantRequest } from "@dentalos/validation";
import { Badge, Button, SelectField, TextField, useLink } from "@dentalos/ui";
import { CheckCircle, Circle } from "lucide-react";
import { Loadable, MockNotice, RequirePermission, Section } from "../../../components/common";
import { TIME_ZONES } from "../../../components/timezones";
import { api } from "../../../lib/api/endpoints";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import type { OnboardingResponse } from "../../../lib/api/types";
import { formatDate, humanize } from "../../../lib/format";
import { canDo } from "../../../lib/session";
import { useForm } from "../../../lib/use-form";

export function OrganisationClient() {
  return (
    <RequirePermission permission="org:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const org = useQuery(() => api.org.get(), []);
  const onboarding = useQuery(() => api.org.onboarding(), []);
  return (
    <div className="dos-stack" data-gap="lg">
      <MockNotice />
      <div className="dos-split">
        <Section title="Settings">
          <Loadable state={org}>
            {(t) => (
              <SettingsForm
                tenant={t}
                onSaved={() => {
                  org.reload();
                  onboarding.reload();
                }}
              />
            )}
          </Loadable>
        </Section>
        <Section title="Onboarding checklist">
          <Loadable state={onboarding}>
            {(o) => <Checklist data={o} onChanged={onboarding.reload} />}
          </Loadable>
        </Section>
      </div>
    </div>
  );
}

function SettingsForm({ tenant, onSaved }: { tenant: TenantResponse; onSaved: () => void }) {
  const editable = canDo("org:manage");
  const f = useForm(
    updateTenantRequest,
    {
      name: tenant.name,
      displayName: tenant.settings.displayName ?? "",
      defaultTimeZone: tenant.settings.defaultTimeZone ?? "Asia/Kolkata",
      gstin: tenant.settings.gstin ?? "",
    },
    (v) => ({
      name: v.name,
      settings: {
        displayName: v.displayName,
        defaultTimeZone: v.defaultTimeZone,
        currency: "INR",
        gstin: v.gstin.toUpperCase(),
      },
    }),
  );
  const save = useMutation(api.org.update, {
    success: "Organisation settings saved",
    onSuccess: onSaved,
    onError: f.applyServerErrors,
  });
  const errs = {
    name: f.errors.name,
    displayName: f.errors["settings.displayName"],
    gstin: f.errors["settings.gstin"],
    defaultTimeZone: f.errors["settings.defaultTimeZone"],
  };

  return (
    <form ref={f.formRef} className="dos-stack" onSubmit={f.handleSubmit((d) => void save.run(d))} noValidate>
      <TextField label="Legal name" required disabled={!editable} {...f.field("name")} error={errs.name} />
      <TextField
        label="Display name"
        hint="Shown to patients on messages and the portal"
        disabled={!editable}
        {...f.field("displayName")}
        error={errs.displayName}
      />
      <SelectField
        label="Default time zone"
        disabled={!editable}
        {...f.field("defaultTimeZone")}
        error={errs.defaultTimeZone}
      >
        {TIME_ZONES.map((z) => (
          <option key={z.value} value={z.value}>
            {z.label}
          </option>
        ))}
      </SelectField>
      <TextField
        label="GSTIN"
        hint="15 characters, e.g. 07AAAAA0000A1Z5. Optional."
        autoCapitalize="characters"
        disabled={!editable}
        {...f.field("gstin")}
        error={errs.gstin}
      />
      <TextField label="Currency" value="Indian rupee (INR)" disabled readOnly />
      {editable ? (
        <div>
          <Button type="submit" loading={save.pending}>
            Save settings
          </Button>
        </div>
      ) : (
        <p className="dos-muted">Only organisation owners can change these settings.</p>
      )}
    </form>
  );
}

const STEPS: { key: keyof OnboardingResponse["steps"]; label: string; href: string }[] = [
  { key: "settings", label: "Add display name and time zone", href: "/admin/organisation" },
  { key: "branches", label: "Create at least one active branch", href: "/admin/branches" },
  { key: "services", label: "Add services to the catalogue", href: "/admin/catalogue" },
  { key: "staff", label: "Invite your team", href: "/admin/staff" },
];

function Checklist({ data, onChanged }: { data: OnboardingResponse; onChanged: () => void }) {
  const Link = useLink();
  const done = STEPS.filter((s) => data.steps[s.key]).length;
  const complete = useMutation(() => api.org.update({ onboardingStatus: "COMPLETED" }), {
    success: "Onboarding marked complete",
    onSuccess: onChanged,
  });
  return (
    <div className="dos-stack">
      <div className="dos-cluster">
        <Badge tone={data.status === "COMPLETED" ? "success" : "warning"}>{humanize(data.status)}</Badge>
        <span className="dos-muted">
          {done} of {STEPS.length} steps done
          {data.onboardedAt ? ` · completed ${formatDate(data.onboardedAt)}` : ""}
        </span>
      </div>
      <ul className="dos-stack" data-gap="sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {STEPS.map((s) => {
          const ok = data.steps[s.key];
          return (
            <li key={s.key} className="dos-cluster">
              {ok ? (
                <CheckCircle size={18} aria-hidden="true" color="var(--color-success)" />
              ) : (
                <Circle size={18} aria-hidden="true" color="var(--color-text-muted)" />
              )}
              <span className="dos-sr-only">{ok ? "Done:" : "To do:"}</span>
              {ok ? (
                <span>{s.label}</span>
              ) : (
                <Link href={s.href} className="dos-link">
                  {s.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {data.status !== "COMPLETED" && canDo("org:manage") ? (
        <div>
          <Button
            variant="secondary"
            disabled={!data.complete}
            loading={complete.pending}
            onClick={() => void complete.run()}
          >
            Mark onboarding complete
          </Button>
          {!data.complete ? (
            <p className="dos-hint" style={{ marginTop: 8 }}>
              Finish every step to complete onboarding.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
