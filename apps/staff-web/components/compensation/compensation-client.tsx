"use client";
import { ErrorState, PageHeader, type TabItem, Tabs } from "@dentalos/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { MockNotice } from "../common";
import { canOpenCompensation, useCompensationScope } from "./bits";
import { LedgerTab } from "./ledger-tab";
import { RulesTab } from "./rules-tab";
import { SettlementsTab } from "./settlements-tab";
import { StatementTab } from "./statement-tab";

interface TabProps {
  rev: number;
  onChanged: () => void;
}
interface TabDef {
  id: string;
  label: string;
  render: (p: TabProps) => ReactNode;
}

const TABS: TabDef[] = [
  { id: "statement", label: "Statement", render: (p) => <StatementTab rev={p.rev} /> },
  { id: "ledger", label: "Ledger", render: (p) => <LedgerTab {...p} /> },
  { id: "rules", label: "Commission rules", render: (p) => <RulesTab {...p} /> },
  { id: "settlements", label: "Settlements", render: (p) => <SettlementsTab {...p} /> },
];

export function CompensationClient() {
  if (!canOpenCompensation())
    return (
      <ErrorState
        title="You don't have access to this page"
        description={
          'Your role does not include "compensation:read". Ask an organisation owner if you need it.'
        }
      />
    );
  return <Inner />;
}

function Inner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { all } = useCompensationScope();
  const requested = params.get("tab");
  const current = TABS.find((t) => t.id === requested) ?? (TABS[0] as TabDef);
  const [rev, setRev] = useState(0);
  const setTab = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const items: TabItem[] = TABS.map((t) => ({ id: t.id, label: t.label }));
  return (
    <>
      <PageHeader
        title="Compensation"
        description={
          all
            ? "Dentist commission rules, the commission ledger, statements and settlements."
            : "Your commission statement, ledger and settlements."
        }
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Compensation" }]}
      />
      <div className="dos-stack">
        <MockNotice />
        <Tabs label="Compensation sections" items={items} value={current.id} onValueChange={setTab}>
          {current.render({ rev, onChanged: () => setRev((n) => n + 1) })}
        </Tabs>
      </div>
    </>
  );
}
