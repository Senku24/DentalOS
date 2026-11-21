"use client";
import { Button, PageHeader, type TabItem, Tabs } from "@dentalos/ui";
import { ArrowDownToLine, PackageMinus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useCallback, useState } from "react";
import { canDo } from "../../lib/session";
import { MockNotice, RequirePermission } from "../common";
import { type DialogRequest, type TabProps } from "./bits";
import { ItemsTab } from "./items-tab";
import { ExpiryTab, MovementsTab, ReceiptsTab, ValuationTab } from "./ledger-tabs";
import { ReceiveDialog } from "./receive-stock";
import { AdjustDialog, ConsumeDialog, WasteDialog } from "./stock-actions";
import { StockTab } from "./stock-tab";
import { SuppliersTab } from "./suppliers-tab";
import { TransfersTab } from "./transfers-tab";

interface TabDef {
  id: string;
  label: string;
  render: (p: TabProps) => ReactNode;
  visible: () => boolean;
}

const TABS: TabDef[] = [
  { id: "stock", label: "Stock", render: (p) => <StockTab {...p} />, visible: () => true },
  { id: "items", label: "Items", render: (p) => <ItemsTab {...p} />, visible: () => true },
  {
    id: "suppliers",
    label: "Suppliers",
    render: (p) => <SuppliersTab {...p} />,
    visible: () => true,
  },
  { id: "receipts", label: "Receipts", render: (p) => <ReceiptsTab {...p} />, visible: () => true },
  {
    id: "transfers",
    label: "Transfers",
    render: (p) => <TransfersTab {...p} />,
    visible: () => canDo("inventory:transfer"),
  },
  { id: "movements", label: "Ledger", render: (p) => <MovementsTab {...p} />, visible: () => true },
  { id: "expiry", label: "Expiry", render: (p) => <ExpiryTab {...p} />, visible: () => true },
  {
    id: "valuation",
    label: "Valuation",
    render: (p) => <ValuationTab {...p} />,
    visible: () => true,
  },
];

export function InventoryClient() {
  return (
    <RequirePermission permission="inventory:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabs = TABS.filter((t) => t.visible());
  const requested = params.get("tab");
  const current = tabs.find((t) => t.id === requested) ?? (tabs[0] as TabDef);
  const [rev, setRev] = useState(0);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  const setTab = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const openDialog = useCallback((d: DialogRequest) => setDialog(d), []);
  const close = () => setDialog(null);
  const done = () => {
    setDialog(null);
    setRev((n) => n + 1);
  };

  const items: TabItem[] = tabs.map((t) => ({ id: t.id, label: t.label }));
  return (
    <>
      <PageHeader
        title="Inventory"
        description="Stock on hand per branch, receipts, usage, transfers and valuation."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Inventory" }]}
        actions={
          canDo("inventory:write") ? (
            <>
              <Button variant="secondary" onClick={() => openDialog({ kind: "consume" })}>
                <PackageMinus size={16} aria-hidden="true" /> Record usage
              </Button>
              <Button onClick={() => openDialog({ kind: "receive" })}>
                <ArrowDownToLine size={16} aria-hidden="true" /> Receive stock
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <Tabs label="Inventory sections" items={items} value={current.id} onValueChange={setTab}>
          {current.render({ rev, openDialog })}
        </Tabs>
      </div>
      {dialog?.kind === "receive" ? (
        <ReceiveDialog branchId={dialog.preset?.branchId} onClose={close} onDone={done} />
      ) : null}
      {dialog?.kind === "consume" ? (
        <ConsumeDialog preset={dialog.preset} onClose={close} onDone={done} />
      ) : null}
      {dialog?.kind === "adjust" ? (
        <AdjustDialog preset={dialog.preset} onClose={close} onDone={done} />
      ) : null}
      {dialog?.kind === "waste" ? (
        <WasteDialog preset={dialog.preset} onClose={close} onDone={done} />
      ) : null}
    </>
  );
}
