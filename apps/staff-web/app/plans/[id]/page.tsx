import { PlanPage } from "./plan-client";

export const metadata = { title: "Treatment plan" };

export default async function TreatmentPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanPage id={id} />;
}
