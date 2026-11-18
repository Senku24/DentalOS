import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Home, Users } from "lucide-react";
import { useState } from "react";
import { a11yViolations } from "./a11y";
import {
  AppShell,
  Breadcrumbs,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  SelectField,
  TextField,
  ToastProvider,
  useToast,
} from "./index";

describe("Button", () => {
  test("loading blocks activation, stays focusable, announces busy", () => {
    const onClick = mock(() => {});
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Save" });
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect((b as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Fields", () => {
  test("label, hint and error are programmatically associated", async () => {
    const { container } = render(
      <>
        <TextField label="Phone" hint="10 digits" error="Enter a valid number" defaultValue="12" />
        <SelectField label="Source">
          <option>Walk-in</option>
        </SelectField>
      </>,
    );
    const input = screen.getByLabelText("Phone");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described).toHaveLength(2);
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "10 digits",
      "Enter a valid number",
    ]);
    expect(screen.getByLabelText("Source")).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });
});

interface Row {
  name: string;
  visits: number;
}
const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "visits", header: "Visits" },
];
const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
  name: `Patient ${String(i + 1).padStart(2, "0")}`,
  visits: 25 - i,
}));

describe("DataTable", () => {
  test("sorts with aria-sort, filters, paginates", async () => {
    const { container } = render(
      <DataTable caption="Patients" columns={columns} data={rows} pageSize={10} />,
    );
    expect(screen.getByRole("table", { name: "Patients" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Showing 1–10 of 25");

    const visitsHeader = screen.getByRole("columnheader", { name: /Visits/ });
    fireEvent.click(within(visitsHeader).getByRole("button"));
    expect(visitsHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getAllByRole("row")[1]?.textContent).toContain("Patient 25"); // visits=1 first
    fireEvent.click(within(visitsHeader).getByRole("button"));
    expect(visitsHeader.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("status").textContent).toBe("Showing 11–20 of 25");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search table" }), {
      target: { value: "Patient 07" },
    });
    expect(screen.getByRole("status").textContent).toBe("Showing 1–1 of 1");
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("empty, filtered-empty, loading and error states", () => {
    const { rerender } = render(
      <DataTable caption="Patients" columns={columns} data={[]} emptyTitle="No patients yet" />,
    );
    expect(screen.getByText("No patients yet")).toBeTruthy();
    rerender(<DataTable caption="Patients" columns={columns} data={rows} loading />);
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
    rerender(
      <DataTable
        caption="Patients"
        columns={columns}
        data={rows}
        error={{ title: "Could not load patients" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Could not load patients");
  });

  test("no matches shows a distinct message", () => {
    render(<DataTable caption="Patients" columns={columns} data={rows} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("No matching results")).toBeTruthy();
  });
});

describe("Dialog", () => {
  test("is an accessible modal with title and close, Esc dismisses", async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} title="Edit branch" description="Change details">
          <TextField label="Branch name" />
        </Dialog>
      );
    }
    render(<Host />);
    const dlg = await screen.findByRole("dialog", { name: "Edit branch" });
    expect(within(dlg).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(await a11yViolations(dlg)).toEqual([]);
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("ConfirmDialog calls onConfirm and offers cancel", async () => {
    const onConfirm = mock(() => {});
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Deactivate branch?"
        description="Staff lose access."
        confirmLabel="Deactivate"
        tone="danger"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("Toast", () => {
  test("errors use role=alert and persist; success uses status", () => {
    function Trigger() {
      const { toast } = useToast();
      return (
        <>
          <button type="button" onClick={() => toast({ tone: "danger", title: "Payment failed" })}>
            fail
          </button>
          <button type="button" onClick={() => toast({ tone: "success", title: "Saved" })}>
            ok
          </button>
        </>
      );
    }
    render(
      <ToastProvider durationMs={10}>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fail"));
    fireEvent.click(screen.getByText("ok"));
    expect(screen.getByRole("alert").textContent).toContain("Payment failed");
    expect(screen.getAllByRole("status").some((e) => e.textContent?.includes("Saved"))).toBe(true);
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
  });
});

describe("Breadcrumbs", () => {
  test("last item is the current page", () => {
    render(<Breadcrumbs items={[{ label: "Patients", href: "/patients" }, { label: "A. Rao" }]} />);
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByText("A. Rao").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Patients" }).getAttribute("href")).toBe("/patients");
  });
});

describe("AppShell", () => {
  const base = {
    nav: [
      { label: "Dashboard", href: "/", icon: Home },
      { label: "Patients", href: "/patients", icon: Users, section: "Clinic" },
    ],
    onNavigate: () => {},
    branches: [
      { id: "b1", name: "Saket" },
      { id: "b2", name: "Gurugram" },
    ],
    branchId: "b1",
    onBranchChange: () => {},
    allowAllBranches: true,
    user: { name: "Asha Verma", roleLabel: "Manager" },
    onSignOut: () => {},
    unreadCount: 3,
    commands: [{ id: "p", label: "Go to Patients", group: "Navigate", href: "/patients" }],
  };

  test("landmarks, skip link, current page, notifications label", async () => {
    const { container } = render(
      <AppShell {...base} currentPath="/patients/123">
        <h1>Patients</h1>
      </AppShell>,
    );
    expect(screen.getByText("Skip to main content").getAttribute("href")).toBe("#main-content");
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("main-content");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Patients" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(nav).getByRole("link", { name: "Dashboard" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("sidebar collapse toggles aria-expanded and state", () => {
    const { container } = render(
      <AppShell {...base} currentPath="/">
        x
      </AppShell>,
    );
    const btn = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(
      screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.querySelector(".dos-shell")?.getAttribute("data-collapsed")).toBe("true");
  });

  test("Ctrl+K opens the command palette; selecting navigates", async () => {
    const onNavigate = mock((_h: string) => {});
    render(
      <AppShell {...base} onNavigate={onNavigate} currentPath="/">
        x
      </AppShell>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const item = await screen.findByText("Go to Patients");
    fireEvent.click(item);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/patients"));
  });
});
