"use client";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Building2, Check, ChevronDown } from "lucide-react";
import type { BranchOption } from "./types";

export const ALL_BRANCHES = "__all__";

/**
 * Switches the working branch. "All branches" is offered only to org-wide principals; the server
 * still enforces scope on every request (this is a view filter, never an authorisation boundary).
 */
export function BranchSwitcher({
  branches,
  value,
  onChange,
  allowAll,
}: { branches: BranchOption[]; value: string; onChange: (id: string) => void; allowAll: boolean }) {
  const label =
    value === ALL_BRANCHES
      ? "All branches"
      : (branches.find((b) => b.id === value)?.name ?? "Select branch");
  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button
          type="button"
          className="dos-btn"
          data-variant="secondary"
          aria-label={`Branch: ${label}. Change branch`}
        >
          <Building2 size={16} aria-hidden="true" />
          <span className="dos-hide-mobile">{label}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className="dos-menu" align="start" sideOffset={6}>
          <DM.Label className="dos-menu-label">Working branch</DM.Label>
          <DM.RadioGroup value={value} onValueChange={onChange}>
            {allowAll ? <Item id={ALL_BRANCHES} name="All branches" /> : null}
            {branches.map((b) => (
              <Item key={b.id} id={b.id} name={b.name} />
            ))}
          </DM.RadioGroup>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function Item({ id, name }: { id: string; name: string }) {
  return (
    <DM.RadioItem value={id} className="dos-menu-item">
      <span style={{ width: 16 }}>
        <DM.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DM.ItemIndicator>
      </span>
      {name}
    </DM.RadioItem>
  );
}
