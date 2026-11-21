import { PageHeader } from "@dentalos/ui";
import { BillingSettingsClient } from "./settings-client";

export const metadata = { title: "Billing settings" };

export default function BillingSettingsPage() {
  return (
    <>
      <PageHeader
        title="Billing settings"
        description="GST, discounts, refunds and payment methods"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Billing", href: "/billing" },
          { label: "Settings" },
        ]}
      />
      <BillingSettingsClient />
    </>
  );
}
