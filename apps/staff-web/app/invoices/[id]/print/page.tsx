import { PrintInvoice } from "./print-client";

export const metadata = { title: "Print invoice" };

export default async function PrintInvoiceRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PrintInvoice id={id} />;
}
