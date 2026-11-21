"use client";
import { Button, ErrorState, Skeleton } from "@dentalos/ui";
import type { InvoicePrintResponse } from "@dentalos/validation";
import { Printer } from "lucide-react";
import { LinkButton } from "../../../../components/billing/bits";
import { InvoiceSheet } from "../../../../components/billing/print-sheets";
import { RequirePermission } from "../../../../components/common";
import { billingApi } from "../../../../lib/api/billing";
import { errorStateFor } from "../../../../lib/api/errors";
import { useQuery } from "../../../../lib/api/hooks";

// The API counts every print fetch (the 2nd is a DUPLICATE copy), so fetch once per page load, not per render.
const fetched = new Map<string, Promise<InvoicePrintResponse>>();

export function PrintInvoice({ id }: { id: string }) {
  return (
    <RequirePermission permission="billing:read">
      <Inner id={id} />
    </RequirePermission>
  );
}

function Inner({ id }: { id: string }) {
  const q = useQuery(() => {
    let p = fetched.get(id);
    if (!p) {
      p = billingApi.invoices.print(id);
      fetched.set(id, p);
      p.catch(() => fetched.delete(id));
      // A later visit is a reprint: drop the entry once the page is left.
      setTimeout(() => fetched.delete(id), 5000);
    }
    return p;
  }, [id]);

  if (q.error) {
    const e = errorStateFor(q.error);
    return (
      <ErrorState
        title={q.error.code === "invoice_not_issued" ? "Not issued yet" : e.title}
        description={e.description}
        action={<LinkButton href={`/invoices/${id}`}>Back to the invoice</LinkButton>}
      />
    );
  }
  if (!q.data)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading invoice</span>
        <Skeleton height="2rem" width="40%" />
        <Skeleton height="12rem" />
      </div>
    );
  return (
    <div className="dos-stack" data-gap="lg">
      <div className="bil-actions bil-no-print">
        <Button onClick={() => window.print()}>
          <Printer size={16} aria-hidden="true" /> Print or save as PDF
        </Button>
        <LinkButton href={`/invoices/${id}`}>Back to the invoice</LinkButton>
      </div>
      <InvoiceSheet data={q.data} />
    </div>
  );
}
