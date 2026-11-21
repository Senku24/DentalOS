import { Suspense } from "react";
import { InventoryClient } from "../../components/inventory/inventory-client";

export const metadata = { title: "Inventory" };

export default function InventoryPage() {
  // useSearchParams (the active tab lives in the URL) needs a Suspense boundary.
  return (
    <Suspense>
      <InventoryClient />
    </Suspense>
  );
}
