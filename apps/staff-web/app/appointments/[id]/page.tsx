import { AppointmentDetailClient } from "./appointment-detail-client";

export const metadata = { title: "Appointment" };

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppointmentDetailClient id={id} />;
}
