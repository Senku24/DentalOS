"use client";
import type { RefundResponse } from "@dentalos/validation";
import { methodLabel } from "../../lib/api/billing-rules";
import { formatDateTime } from "../../lib/format";
import { Money, RefundStatusBadge } from "./bits";

export function RefundMiniTable({ refunds }: { refunds: RefundResponse[] }) {
  return (
    <div className="dos-table-scroll">
      <table className="dos-table">
        <caption className="dos-sr-only">Refunds</caption>
        <thead>
          <tr>
            <th scope="col">Requested</th>
            <th scope="col">Reason</th>
            <th scope="col">Method</th>
            <th scope="col" className="bil-money">
              Amount
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {refunds.map((r) => (
            <tr key={r.id}>
              <td>{formatDateTime(r.requestedAt)}</td>
              <td>{r.reason}</td>
              <td>{methodLabel(r.method)}</td>
              <td>
                <Money paise={r.amountPaise} />
              </td>
              <td>
                <RefundStatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
