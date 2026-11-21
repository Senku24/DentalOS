import { PageHeader } from "@dentalos/ui";
import { BillingDashboard } from "./billing-client";

export const metadata = { title: "Billing" };

export default function BillingPage() {
  return (
    <>
      <PageHeader
        title="Billing"
        description="Today's collections, what is still owed, and recent invoices"
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Billing" }]}
      />
      <BillingDashboard />
    </>
  );
}
