import { Suspense } from "react";
import { AppointmentsClient } from "./appointments-client";

export const metadata = { title: "Appointments" };

export default function AppointmentsPage() {
  // useSearchParams (view, date and filters live in the URL) needs a Suspense boundary.
  return (
    <Suspense>
      <AppointmentsClient />
    </Suspense>
  );
}
