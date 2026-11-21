"use client";
import {
  type InvoicePrintResponse,
  type PaymentDetailResponse,
  amountInWordsINR,
  isInterStateSupply,
} from "@dentalos/validation";
import { methodLabel } from "../../lib/api/billing-rules";
import { formatDate, formatDateTime, formatPaise, humanize } from "../../lib/format";

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

/** Printable tax invoice (HTML + print CSS; no PDF in M3). Reprints are marked by the API as DUPLICATE. */
export function InvoiceSheet({ data }: { data: InvoicePrintResponse }) {
  const { invoice: inv, supplier, patient } = data;
  const inter = isInterStateSupply(inv.supplierStateCode, inv.placeOfSupplyStateCode);
  const titled = supplier.gstin ? "TAX INVOICE" : "INVOICE";
  const adjusted = inv.totalPaise + inv.adjustmentPaise;
  return (
    <article className="bil-sheet" aria-label={`Invoice ${inv.number ?? ""}`}>
      <header className="bil-sheet__head">
        <div className="bil-sheet__meta">
          <h1>{supplier.name}</h1>
          <strong>{supplier.branchName}</strong>
          {supplier.addressLines.map((l) => (
            <span key={l}>{l}</span>
          ))}
          {supplier.phone ? <span>Phone {supplier.phone}</span> : null}
          {supplier.gstin ? <span>GSTIN {supplier.gstin}</span> : null}
        </div>
        <div className="bil-sheet__meta" style={{ textAlign: "end" }}>
          <h2>{titled}</h2>
          <span>
            No. <strong>{inv.number}</strong>
          </span>
          <span>Date {formatDate(inv.issuedAt)}</span>
          {inv.dueDate ? <span>Due {formatDate(inv.dueDate)}</span> : null}
          <span className="bil-sheet__copy">{data.copy}</span>
        </div>
      </header>
      {inv.status === "VOID" ? <div className="bil-sheet__void">VOID</div> : null}
      <section className="bil-sheet__meta" aria-label="Billed to">
        <strong>Billed to</strong>
        <span>{patient.name}</span>
        {patient.mrn ? <span>MRN {patient.mrn}</span> : null}
        {patient.phone ? <span>Phone {patient.phone}</span> : null}
        <span>
          Place of supply: state {inv.placeOfSupplyStateCode ?? inv.supplierStateCode ?? "—"}
          {inter ? " (inter-state: IGST)" : ""}
        </span>
      </section>
      <table>
        <caption className="dos-sr-only">Invoice lines</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Description</th>
            <th scope="col">HSN/SAC</th>
            <th scope="col" className="num">
              Qty
            </th>
            <th scope="col" className="num">
              Rate
            </th>
            <th scope="col" className="num">
              Discount
            </th>
            <th scope="col" className="num">
              Taxable
            </th>
            <th scope="col" className="num">
              GST
            </th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.lineNo}</td>
              <td>
                {l.description}
                {l.toothCode ? ` (tooth ${l.toothCode})` : ""}
              </td>
              <td>{l.hsnSac ?? "—"}</td>
              <td className="num">{l.quantity}</td>
              <td className="num">{formatPaise(l.unitPricePaise)}</td>
              <td className="num">{formatPaise(l.discountPaise + l.allocatedDiscountPaise)}</td>
              <td className="num">{formatPaise(l.taxableValuePaise)}</td>
              <td className="num">
                {pct(l.taxRateBp)}
                <br />
                {formatPaise(l.cgstPaise + l.sgstPaise + l.igstPaise)}
              </td>
              <td className="num">{formatPaise(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="bil-sheet__head" style={{ alignItems: "start" }}>
        <table style={{ maxWidth: 420 }}>
          <caption style={{ textAlign: "start", fontWeight: 600 }}>GST summary</caption>
          <thead>
            <tr>
              <th scope="col">HSN/SAC</th>
              <th scope="col" className="num">
                Rate
              </th>
              <th scope="col" className="num">
                Taxable
              </th>
              <th scope="col" className="num">
                {inter ? "IGST" : "CGST + SGST"}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.taxSummary.map((r) => (
              <tr key={`${r.hsnSac}-${r.taxRateBp}`}>
                <td>{r.hsnSac ?? "—"}</td>
                <td className="num">{pct(r.taxRateBp)}</td>
                <td className="num">{formatPaise(r.taxableValuePaise)}</td>
                <td className="num">
                  {inter
                    ? formatPaise(r.igstPaise)
                    : `${formatPaise(r.cgstPaise)} + ${formatPaise(r.sgstPaise)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table style={{ maxWidth: 320 }}>
          <caption className="dos-sr-only">Totals</caption>
          <tbody>
            <tr>
              <th scope="row">Subtotal</th>
              <td className="num">{formatPaise(inv.subtotalPaise)}</td>
            </tr>
            {inv.discountPaise > 0 ? (
              <tr>
                <th scope="row">Discount</th>
                <td className="num">−{formatPaise(inv.discountPaise)}</td>
              </tr>
            ) : null}
            {inv.taxPaise > 0 ? (
              <tr>
                <th scope="row">{inv.taxInclusive ? "GST (included)" : "GST"}</th>
                <td className="num">{formatPaise(inv.taxPaise)}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Invoice total</th>
              <td className="num">
                <strong>{formatPaise(inv.totalPaise)}</strong>
              </td>
            </tr>
            {inv.adjustmentPaise !== 0 ? (
              <tr>
                <th scope="row">Credit / debit notes</th>
                <td className="num">{formatPaise(inv.adjustmentPaise)}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row">Received</th>
              <td className="num">{formatPaise(inv.paidPaise)}</td>
            </tr>
            <tr>
              <th scope="row">Balance due</th>
              <td className="num">
                <strong>{formatPaise(inv.balancePaise)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0 }}>
        <strong>Amount in words:</strong> {data.amountInWords}
        {adjusted !== inv.totalPaise
          ? ` (before notes; adjusted total ${formatPaise(adjusted)})`
          : ""}
      </p>
      {inv.adjustments.length > 0 ? (
        <table>
          <caption style={{ textAlign: "start", fontWeight: 600 }}>Credit and debit notes</caption>
          <tbody>
            {inv.adjustments.map((a) => (
              <tr key={a.id}>
                <td>{a.number}</td>
                <td>{a.kind === "CREDIT" ? "Credit note" : "Debit note"}</td>
                <td>{formatDate(a.issuedAt)}</td>
                <td>{a.reason}</td>
                <td className="num">
                  {a.kind === "CREDIT" ? "−" : ""}
                  {formatPaise(a.amountPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {inv.notes ? (
        <p style={{ margin: 0 }}>
          <strong>Notes:</strong> {inv.notes}
        </p>
      ) : null}
      <footer style={{ fontSize: "0.8rem", color: "#555" }}>
        This is a computer-generated invoice. {inv.taxInclusive ? "Prices include GST. " : ""}
        {supplier.gstin ? `GSTIN ${supplier.gstin}.` : ""}
      </footer>
    </article>
  );
}

/** Payment receipt: the print view of a payment with its allocations and refunds. */
export function ReceiptSheet({
  payment,
  patientName,
  branchName,
  invoiceNumbers,
}: {
  payment: PaymentDetailResponse;
  patientName: string;
  branchName: string;
  /** invoiceId → number for the allocations. */
  invoiceNumbers: Record<string, string | null>;
}) {
  const applied = payment.allocations.filter((a) => a.amountPaise > 0);
  return (
    <article className="bil-sheet" aria-label={`Receipt ${payment.receiptNumber ?? ""}`}>
      <header className="bil-sheet__head">
        <div className="bil-sheet__meta">
          <h1>Payment receipt</h1>
          <span>{branchName}</span>
        </div>
        <div className="bil-sheet__meta" style={{ textAlign: "end" }}>
          <span>
            Receipt no. <strong>{payment.receiptNumber ?? "pending"}</strong>
          </span>
          <span>{formatDateTime(payment.receivedAt)}</span>
        </div>
      </header>
      {payment.status !== "RECORDED" ? (
        <div className="bil-sheet__void">
          {payment.status === "PENDING" ? "NOT YET PAID" : "FAILED"}
        </div>
      ) : null}
      <section className="bil-sheet__meta">
        <span>
          Received from <strong>{patientName}</strong>
        </span>
        <span>
          Amount <strong>{formatPaise(payment.amountPaise)}</strong>
        </span>
        <span>{amountInWordsINR(payment.amountPaise)}</span>
        <span>
          Paid by {methodLabel(payment.method)}
          {payment.reference ? ` · ref ${payment.reference}` : ""}
        </span>
        {payment.notes ? <span>Notes: {payment.notes}</span> : null}
      </section>
      <table>
        <caption style={{ textAlign: "start", fontWeight: 600 }}>Applied to</caption>
        <tbody>
          {applied.map((a) => (
            <tr key={a.id}>
              <td>Invoice {invoiceNumbers[a.invoiceId] ?? ""}</td>
              <td>{formatDate(a.createdAt)}</td>
              <td className="num">{formatPaise(a.amountPaise)}</td>
            </tr>
          ))}
          {payment.unallocatedPaise > 0 ? (
            <tr>
              <td>Patient advance (unapplied)</td>
              <td />
              <td className="num">{formatPaise(payment.unallocatedPaise)}</td>
            </tr>
          ) : null}
          {applied.length === 0 && payment.unallocatedPaise <= 0 ? (
            <tr>
              <td colSpan={3}>Nothing applied.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {payment.refunds.filter((r) => r.status !== "REJECTED").length > 0 ? (
        <table>
          <caption style={{ textAlign: "start", fontWeight: 600 }}>Refunds</caption>
          <tbody>
            {payment.refunds
              .filter((r) => r.status !== "REJECTED")
              .map((r) => (
                <tr key={r.id}>
                  <td>{humanize(r.status)}</td>
                  <td>{r.reason}</td>
                  <td className="num">{formatPaise(r.amountPaise)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
      <footer style={{ fontSize: "0.8rem", color: "#555" }}>Computer-generated receipt.</footer>
    </article>
  );
}
