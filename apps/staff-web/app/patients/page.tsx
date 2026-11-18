import { PageHeader } from "@dentalos/ui";
import { PatientsDemo } from "./patients-demo";

export const metadata = { title: "Patients" };

export default function Patients() {
  return (
    <>
      <PageHeader
        title="Patients"
        description="Shared profile across all branches of your organisation"
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Patients" }]}
      />
      <PatientsDemo />
    </>
  );
}
