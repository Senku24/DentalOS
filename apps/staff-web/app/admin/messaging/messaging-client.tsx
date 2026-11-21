"use client";
import { PageHeader, Tabs } from "@dentalos/ui";
import { useState } from "react";
import { MockNotice, RequirePermission } from "../../../components/common";
import { PreferencesTab } from "./preferences-tab";
import { RecallTab } from "./recall-tab";
import { SendTestTab } from "./send-test-tab";
import { SettingsTab } from "./settings-tab";
import { TemplatesTab } from "./templates-tab";

const TABS = [
  { id: "templates", label: "Templates" },
  { id: "test", label: "Send test" },
  { id: "preferences", label: "Preferences check" },
  { id: "recall", label: "Recall" },
  { id: "settings", label: "Settings" },
];

export function MessagingClient() {
  return (
    <RequirePermission permission="comms:templates">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const [tab, setTab] = useState("templates");
  return (
    <>
      <PageHeader
        title="Messaging"
        description="Message templates, test sends, consent checks, recall intervals and delivery rules."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Admin" }, { label: "Messaging" }]}
      />
      <div className="dos-stack">
        <MockNotice />
        <Tabs label="Messaging sections" items={TABS} value={tab} onValueChange={setTab}>
          {tab === "templates" ? <TemplatesTab /> : null}
          {tab === "test" ? <SendTestTab /> : null}
          {tab === "preferences" ? <PreferencesTab /> : null}
          {tab === "recall" ? <RecallTab /> : null}
          {tab === "settings" ? <SettingsTab /> : null}
        </Tabs>
      </div>
    </>
  );
}
