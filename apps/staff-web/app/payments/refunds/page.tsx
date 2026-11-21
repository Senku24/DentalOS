import { PageHeader } from "@dentalos/ui";
import { Suspense } from "react";
import { RefundsClient } from "./refunds-client";

export const metadata = { title: "Refunds" };

export default function RefundsPage() {
  return (
    <>
      <PageHeader
        title="Refunds"
        description="Requests, approvals above the threshold, and processing"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Payments", href: "/payments" },
          { label: "Refunds" },
        ]}
      />
      <Suspense>
        <RefundsClient />
      </Suspense>
    </>
  );
}
