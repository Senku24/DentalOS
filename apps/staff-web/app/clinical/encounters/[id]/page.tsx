import { EncounterWorkspace } from "./encounter-client";

export const metadata = { title: "Encounter" };

export default async function EncounterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EncounterWorkspace id={id} />;
}
