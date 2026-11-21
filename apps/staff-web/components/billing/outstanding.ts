"use client";
import type { InvoiceSummary } from "@dentalos/validation";
import { billingApi } from "../../lib/api/billing";
import { useQuery } from "../../lib/api/hooks";

const MAX_PAGES = 20;

/** Follows `nextCursor` up to `maxPages`; `truncated` says whether more existed. */
export async function collectAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages = MAX_PAGES,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.nextCursor) return { items, truncated: false };
    cursor = page.nextCursor;
  }
  return { items, truncated: true };
}

/** Every invoice with an amount still to collect (ISSUED + PARTIALLY_PAID), optionally for one branch. */
export function useOutstandingAll(branchId: string) {
  return useQuery(async () => {
    const [a, b] = await Promise.all(
      (["ISSUED", "PARTIALLY_PAID"] as const).map((status) =>
        collectAll<InvoiceSummary>((cursor) =>
          billingApi.invoices.list({ status, branchId: branchId || undefined, cursor, limit: 100 }),
        ),
      ),
    );
    return {
      items: [...(a?.items ?? []), ...(b?.items ?? [])].filter((i) => i.balancePaise > 0),
      truncated: Boolean(a?.truncated || b?.truncated),
    };
  }, [branchId]);
}
