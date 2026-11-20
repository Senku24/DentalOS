import { Suspense } from "react";
import { IntakeClient } from "./intake-client";

export const metadata = { title: "New patient" };

export default function NewPatientPage() {
  // useSearchParams (enquiry conversion prefill) needs a Suspense boundary for static rendering.
  return (
    <Suspense>
      <IntakeClient />
    </Suspense>
  );
}
