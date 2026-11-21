import { PageHeader } from "@dentalos/ui";
import { Suspense } from "react";
import { PaymentsClient } from "./payments-client";

export const metadata = { title: "Payments" };

export default function PaymentsPage() {
  return (
    <>
      <PageHeader
        title="Payments"
        description="Money received, how it was applied, and any advance still held"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Payments" },
        ]}
      />
      <Suspense>
        <PaymentsClient />
      </Suspense>
    </>
  );
}
