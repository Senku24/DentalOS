import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Home, Users } from "lucide-react";
import { useState } from "react";
import { a11yViolations } from "./a11y";
import {
  AppShell,
  Checkbox,
  CheckboxGroup,
  type ColumnDef,
  CursorPager,
  DataTable,
  DescriptionList,
  RadioGroup,
  Steps,
  Tabs,
  Timeline,
} from "./index";

describe("Tabs", () => {
  function Harness() {
    const [v, setV] = useState("a");
    return (
      <Tabs
        label="Sections"
        value={v}
        onValueChange={setV}
        items={[
          { id: "a", label: "Overview" },
          { id: "b", label: "Medical", badge: 2 },
          { id: "c", label: "Documents" },
        ]}
      >
        <p>Panel {v}</p>
      </Tabs>
    );
  }

  test("roving tabindex, arrow/Home/End keys select, panel is labelled by the active tab", async () => {
    const { container } = render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Medical/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Medical/ }));
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel b");
    expect(screen.getByRole("tabpanel", { name: /Medical/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel c");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel a"); // wraps
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel c");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("Choices", () => {
  test("CheckboxGroup is a labelled fieldset; toggling adds/removes values; error is described", async () => {
    const onChange = mock((_v: string[]) => {});
    const { container } = render(
      <CheckboxGroup
        legend="Roles"
        required
        hint="Pick one or more"
        error="Select at least one"
        options={[
          { value: "OWNER", label: "Owner" },
          { value: "DENTIST", label: "Dentist", hint: "Clinical workspace" },
        ]}
        value={["OWNER"]}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: /Roles/ });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    const described = group.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Pick one or more",
      "Select at least one",
    ]);
    fireEvent.click(screen.getByLabelText("Dentist"));
    expect(onChange).toHaveBeenLastCalledWith(["OWNER", "DENTIST"]);
    fireEvent.click(screen.getByLabelText("Owner"));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("Checkbox switch exposes role=switch with its hint", async () => {
    const { container } = render(
      <Checkbox switch label="Organisation-wide" hint="All branches" defaultChecked />,
    );
    const sw = screen.getByRole("switch", { name: "Organisation-wide" });
    expect((sw as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById(sw.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "All branches",
    );
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("RadioGroup selects one value; hidden legend still names the group", async () => {
    const onChange = mock((_v: string) => {});
    const { container } = render(
      <RadioGroup
        legend="Phone"
        hideLegend
        name="phone"
        value="survivor"
        onChange={onChange}
        options={[
          { value: "survivor", label: "+91 90000 10037 (survivor)" },
          { value: "merged", label: "+91 90000 77001" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Phone" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("+91 90000 77001"));
    expect(onChange).toHaveBeenCalledWith("merged");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("Display", () => {
  test("DescriptionList, Timeline and Steps render semantic, accessible structures", async () => {
    const { container } = render(
      <>
        <DescriptionList
          items={[
            { term: "Mobile", detail: "+91 90000 10037" },
            { term: "Email", detail: null },
          ]}
        />
        <Timeline
          label="Assignment history"
          items={[
            {
              id: "1",
              title: "Saket",
              meta: "1 Oct 2026 → ongoing",
              tone: "success",
              current: true,
            },
            { id: "2", title: "Gurugram", meta: "1 Jun 2026 → 30 Sep 2026" },
          ]}
        />
        <Steps steps={["Compare", "Choose survivor", "Confirm"]} current={1} />
      </>,
    );
    expect(screen.getByText("Email").nextElementSibling?.textContent).toBe("—");
    const history = screen.getByRole("list", { name: "Assignment history" });
    expect(history.querySelector('[aria-current="true"]')?.textContent).toContain("Saket");
    const steps = screen.getByRole("list", { name: "Progress" });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain("Choose survivor");
    expect(steps.textContent).toContain("(completed)");
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("CursorPager disables at the ends and announces the page", async () => {
    const onNext = mock(() => {});
    const onPrev = mock(() => {});
    const { container, rerender } = render(
      <CursorPager
        page={1}
        hasPrev={false}
        hasNext
        onPrev={onPrev}
        onNext={onNext}
        itemCount={25}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Page 1 · 25 shown");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledTimes(1);
    rerender(
      <CursorPager page={2} hasPrev hasNext={false} onPrev={onPrev} onNext={onNext} loading />,
    );
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("DataTable hidePagination", () => {
  test("server-driven tables can hide the client pager", () => {
    const columns: ColumnDef<{ n: string }, unknown>[] = [{ accessorKey: "n", header: "Name" }];
    render(
      <DataTable
        caption="T"
        columns={columns}
        data={[{ n: "a" }]}
        searchable={false}
        hidePagination
      />,
    );
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});

describe("Sidebar active item", () => {
  test("only the most specific matching nav item is current", () => {
    render(
      <AppShell
        nav={[
          { label: "Patients", href: "/patients", icon: Users },
          { label: "Duplicate review", href: "/patients/duplicates", icon: Home },
        ]}
        currentPath="/patients/duplicates"
        onNavigate={() => {}}
        branches={[]}
        branchId=""
        onBranchChange={() => {}}
        allowAllBranches={false}
        user={{ name: "A B", roleLabel: "Manager" }}
        onSignOut={() => {}}
        commands={[]}
      >
        <p>x</p>
      </AppShell>,
    );
    const current = document.querySelectorAll('.dos-sidebar [aria-current="page"]');
    expect([...current].map((a) => a.textContent)).toEqual(["Duplicate review"]);
  });
});
