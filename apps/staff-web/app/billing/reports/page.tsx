import { PageHeader } from "@dentalos/ui";
import { ReportsClient } from "./reports-client";

export const metadata = { title: "Billing reports" };

export default function BillingReportsPage() {
  return (
    <>
      <PageHeader
        title="Billing reports"
        description="Revenue, collections and outstanding balances"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Reports" },
        ]}
      />
      <ReportsClient />
    </>
  );
}
