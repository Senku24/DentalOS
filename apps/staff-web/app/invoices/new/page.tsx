import { PageHeader } from "@dentalos/ui";
import { Suspense } from "react";
import { NewInvoiceClient } from "./new-invoice-client";

export const metadata = { title: "New invoice" };

export default function NewInvoicePage() {
  // useSearchParams (?patientId= / ?planId= prefill) needs a Suspense boundary.
  return (
    <>
      <PageHeader
        title="New invoice"
        description="Bill catalogue services or items from an approved treatment plan. Saved as a draft until you issue it."
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Invoices", href: "/invoices" },
          { label: "New" },
        ]}
      />
      <Suspense>
        <NewInvoiceClient />
      </Suspense>
    </>
  );
}
