"use client";
import "../../../components/clinical/clinical.css";
import { Breadcrumbs } from "@dentalos/ui";
import { PlanDetailView } from "../../../components/clinical/plans/plan-detail";
import { MockNotice, RequirePermission } from "../../../components/common";

/** Standalone treatment plan (shareable link; front desk can quote and collect consent here). */
export function PlanPage({ id }: { id: string }) {
  return (
    <RequirePermission permission="plan:read">
      <div className="dos-stack cw" data-gap="lg">
        <div className="dos-stack" data-gap="sm">
          <Breadcrumbs
            items={[
              { label: "Home", href: "/" },
              { label: "Clinical", href: "/clinical" },
              { label: "Treatment plan" },
            ]}
          />
          <MockNotice />
        </div>
        <PlanDetailView planId={id} showPatientLink />
      </div>
    </RequirePermission>
  );
}
