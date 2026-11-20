import { ClinicalWorkspace } from "../../../components/clinical/workspace";

export const metadata = { title: "Clinical workspace" };

export default async function ClinicalPatientPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  return <ClinicalWorkspace patientId={patientId} />;
}
