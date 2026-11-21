import { InvoicePage } from "./invoice-client";

export const metadata = { title: "Invoice" };

export default async function InvoiceRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoicePage id={id} />;
}
