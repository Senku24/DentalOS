import { PageHeader } from "@dentalos/ui";
import { DesignClient } from "./design-client";

export const metadata = { title: "Design system" };

export default function DesignPage() {
  return (
    <>
      <PageHeader
        title="Design system"
        description="Every shared component in its states. Developer reference; also the target for automated accessibility checks."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Design system" }]}
      />
      <DesignClient />
    </>
  );
}
