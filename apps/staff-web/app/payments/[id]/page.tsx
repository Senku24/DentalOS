import { PaymentPage } from "./payment-client";

export const metadata = { title: "Payment receipt" };

export default async function PaymentRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentPage id={id} />;
}
