import { ProfileClient } from "./profile-client";

export const metadata = { title: "Patient" };

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProfileClient id={id} />;
}
