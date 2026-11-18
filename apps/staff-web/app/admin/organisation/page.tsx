import { PageHeader } from "@dentalos/ui";
import { OrganisationClient } from "./organisation-client";

export const metadata = { title: "Organisation" };

export default function OrganisationPage() {
  return (
    <>
      <PageHeader
        title="Organisation"
        description="Settings that apply to every branch, and your onboarding progress"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Organisation" },
        ]}
      />
      <OrganisationClient />
    </>
  );
}
