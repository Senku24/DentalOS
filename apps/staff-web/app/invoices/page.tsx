import { PageHeader } from "@dentalos/ui";
import { Suspense } from "react";
import { InvoicesClient } from "./invoices-client";

export const metadata = { title: "Invoices" };

export default function InvoicesPage() {
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Drafts, issued invoices and their payment status"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Invoices" },
        ]}
      />
      <Suspense>
        <InvoicesClient />
      </Suspense>
    </>
  );
}
