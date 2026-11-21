import { Suspense } from "react";
import { CompensationClient } from "../../components/compensation/compensation-client";

export const metadata = { title: "Compensation" };

export default function CompensationPage() {
  // useSearchParams (the active tab lives in the URL) needs a Suspense boundary.
  return (
    <Suspense>
      <CompensationClient />
    </Suspense>
  );
}
