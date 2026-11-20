import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
// The shared FDI helpers (packages/validation/src/fdi.ts) — the same ones staff-web passes in.
import * as F from "../../validation/src/fdi";
import { a11yViolations } from "./a11y";
import {
  Odontogram,
  type OdontogramDentition,
  type OdontogramFdi,
  type OdontogramRecord,
  describeTooth,
  odontogramRows,
  surfaceRegions,
} from "./odontogram";

const fdi: OdontogramFdi = {
  permanentTeeth: F.PERMANENT_TEETH,
  primaryTeeth: F.PRIMARY_TEETH,
  validSurfaces: F.validSurfaces,
  toothName: F.toothName,
  surfaceLabels: F.TOOTH_SURFACE_LABELS,
};

const records: OdontogramRecord[] = [
  { toothCode: 36, condition: "CARIES", surfaces: ["M", "O"] },
  { toothCode: 46, condition: "ROOT_CANAL_TREATED", surfaces: [] },
  { toothCode: 18, condition: "MISSING", surfaces: [] },
  { toothCode: 11, condition: "VENEER", surfaces: ["F"] },
];

const grid = () => screen.getByRole("grid");
const tooth = (code: number) =>
  within(grid()).getByRole("button", { name: new RegExp(`tooth ${code}\\b`) });

function Harness(props: {
  onSelect?: (t: number[]) => void;
  onSurface?: (t: number, s: string) => void;
  onDentition?: (d: OdontogramDentition) => void;
  layout?: "auto" | "chart" | "list";
}) {
  const [sel, setSel] = useState<number[]>([]);
  return (
    <Odontogram
      fdi={fdi}
      records={records}
      selected={sel}
      layout={props.layout ?? "chart"}
      onDentitionChange={props.onDentition}
      onSurfaceClick={props.onSurface}
      onSelectionChange={(t) => {
        setSel(t);
        props.onSelect?.(t);
      }}
    />
  );
}

describe("odontogram layout helpers", () => {
  test("rows follow the dentist's view: 18…11 | 21…28 over 48…41 | 31…38", () => {
    const [upper, lower] = odontogramRows(fdi, "PERMANENT");
    expect(upper).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]);
    expect(lower).toEqual([48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]);
    const [pu, pl] = odontogramRows(fdi, "PRIMARY");
    expect(pu).toEqual([55, 54, 53, 52, 51, 61, 62, 63, 64, 65]);
    expect(pl).toEqual([85, 84, 83, 82, 81, 71, 72, 73, 74, 75]);
  });

  test("surfaces come from the shared helpers; mesial faces the midline, buccal faces out", () => {
    // Upper right molar: buccal on top, palatal below, mesial towards the midline (viewer's right).
    expect(surfaceRegions(fdi, 16)).toEqual({
      center: "O",
      top: "B",
      bottom: "P",
      left: "D",
      right: "M",
    });
    // Lower left incisor: incisal/facial/lingual, facial at the bottom, mesial on the left.
    expect(surfaceRegions(fdi, 31)).toEqual({
      center: "I",
      top: "L",
      bottom: "F",
      left: "M",
      right: "D",
    });
    // Primary upper left canine uses I/F/P.
    expect(Object.values(surfaceRegions(fdi, 63)).sort()).toEqual(["D", "F", "I", "M", "P"]);
  });

  test("describeTooth names the tooth (toothName) and its findings", () => {
    expect(describeTooth(fdi, 36, undefined)).toBe("Lower left first molar, tooth 36: no findings");
    expect(
      describeTooth(fdi, 36, [
        { style: { label: "Caries", abbr: "Ca", color: "red" }, surfaces: ["M", "O"] },
      ]),
    ).toBe("Lower left first molar, tooth 36: Caries (Mesial, Occlusal)");
  });
});

describe("Odontogram", () => {
  test("renders 32 permanent teeth with accessible names and charted findings", async () => {
    const { container } = render(<Harness />);
    expect(grid().getAttribute("aria-label")).toBe("Odontogram (permanent dentition)");
    expect(within(grid()).getAllByRole("gridcell")).toHaveLength(32);
    expect(within(grid()).getAllByRole("row")).toHaveLength(2);
    expect(tooth(36).getAttribute("aria-label")).toBe(
      "Lower left first molar, tooth 36: Caries (Mesial, Occlusal)",
    );
    expect(tooth(46).getAttribute("aria-label")).toMatch(/Root canal treated$/);
    expect(tooth(11).getAttribute("aria-label")).toMatch(/Veneer \(Facial \(labial\)\)/);
    // Surface regions carry the tooth's valid surfaces (I/F/P on an upper incisor).
    const s11 = [...tooth(11).querySelectorAll("polygon")].map((p) =>
      p.getAttribute("data-surface"),
    );
    expect(s11.sort()).toEqual(["D", "F", "I", "M", "P"]);
    // Missing tooth is crossed out; status also in text (abbreviation), not only colour.
    expect(tooth(18).querySelector("svg")?.getAttribute("data-absent")).toBe("true");
    expect(tooth(18).textContent).toContain("Mi");
    expect(screen.getByRole("list", { name: "Condition legend" })).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("dentition toggle switches to the 20 primary teeth (uncontrolled) and emits the change", async () => {
    const onDentition = mock((_d: OdontogramDentition) => {});
    const { container } = render(<Harness onDentition={onDentition} />);
    const primary = screen.getByRole("button", { name: "Primary" });
    expect(primary.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(primary);
    expect(onDentition).toHaveBeenCalledWith("PRIMARY");
    expect(primary.getAttribute("aria-pressed")).toBe("true");
    expect(within(grid()).getAllByRole("gridcell")).toHaveLength(20);
    expect(tooth(55).getAttribute("aria-label")).toMatch(/^Primary upper right second molar/);
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("one tab stop; arrows, Home/End and Ctrl+Home/End move focus across the grid", () => {
    render(<Harness />);
    const tabbable = within(grid())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(tooth(18));

    act(() => tooth(18).focus());
    fireEvent.keyDown(tooth(18), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tooth(17));
    fireEvent.keyDown(tooth(17), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tooth(47));
    fireEvent.keyDown(tooth(47), { key: "ArrowDown" }); // clamps at the last row
    expect(document.activeElement).toBe(tooth(47));
    fireEvent.keyDown(tooth(47), { key: "End" });
    expect(document.activeElement).toBe(tooth(38));
    fireEvent.keyDown(tooth(38), { key: "ArrowRight" }); // clamps at the row end
    expect(document.activeElement).toBe(tooth(38));
    fireEvent.keyDown(tooth(38), { key: "Home" });
    expect(document.activeElement).toBe(tooth(48));
    fireEvent.keyDown(tooth(48), { key: "ArrowUp" });
    expect(document.activeElement).toBe(tooth(18));
    fireEvent.keyDown(tooth(18), { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(tooth(38));
    fireEvent.keyDown(tooth(38), { key: "Home", ctrlKey: true });
    expect(document.activeElement).toBe(tooth(18));
    // The roving tab stop follows focus.
    expect(tooth(18).getAttribute("tabindex")).toBe("0");
    expect(tooth(38).getAttribute("tabindex")).toBe("-1");
  });

  test("Enter/Space select; modifier adds and removes; Escape clears (selection events out)", () => {
    const onSelect = mock((_t: number[]) => {});
    render(<Harness onSelect={onSelect} />);
    fireEvent.keyDown(tooth(36), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith([36]);
    expect(tooth(36).parentElement?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tooth(37), { key: " ", shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith([36, 37]);
    fireEvent.keyDown(tooth(36), { key: "Enter", ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith([37]);
    fireEvent.keyDown(tooth(46), { key: "Enter" }); // plain select replaces
    expect(onSelect).toHaveBeenLastCalledWith([46]);
    fireEvent.keyDown(tooth(46), { key: "Escape" });
    expect(onSelect).toHaveBeenLastCalledWith([]);
    expect(grid().getAttribute("aria-multiselectable")).toBe("true");
  });

  test("clicking a surface emits the surface and selects the tooth", () => {
    const onSelect = mock((_t: number[]) => {});
    const onSurface = mock((_t: number, _s: string) => {});
    render(<Harness onSelect={onSelect} onSurface={onSurface} />);
    const occlusal = tooth(26).querySelector('polygon[data-surface="O"]') as Element;
    fireEvent.click(occlusal);
    expect(onSurface).toHaveBeenCalledWith(26, "O");
    expect(onSelect).toHaveBeenLastCalledWith([26]);
    fireEvent.click(tooth(27).querySelector('polygon[data-surface="P"]') as Element, {
      shiftKey: true,
    });
    expect(onSurface).toHaveBeenLastCalledWith(27, "P");
    expect(onSelect).toHaveBeenLastCalledWith([26, 27]);
  });

  test("pending surfaces are outlined; read-only charts expose no selection state", () => {
    render(
      <Odontogram
        fdi={fdi}
        records={records}
        layout="chart"
        pendingSurfaces={{ 36: ["D"] }}
        legend="present"
      />,
    );
    expect(tooth(36).querySelector('polygon[data-surface="D"]')?.getAttribute("data-pending")).toBe(
      "true",
    );
    expect(tooth(36).parentElement?.getAttribute("aria-selected")).toBeNull();
    const legend = screen.getByRole("list", { name: "Condition legend" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(4);
  });

  test("phone fallback: a tooth list with the same names and selection", async () => {
    const onSelect = mock((_t: number[]) => {});
    const { container } = render(<Harness layout="list" onSelect={onSelect} />);
    expect(screen.queryByRole("grid")).toBeNull();
    const list = screen.getByRole("list", { name: "Odontogram tooth list" });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(32);
    const t36 = within(list).getByRole("button", { name: /tooth 36: Caries/ });
    fireEvent.click(t36);
    expect(onSelect).toHaveBeenLastCalledWith([36]);
    expect(t36.getAttribute("aria-pressed")).toBe("true");
    expect(await a11yViolations(container)).toEqual([]);
  });

  test("findings on the hidden dentition are counted on the toggle and announced, never silent", async () => {
    const mixed: OdontogramRecord[] = [
      { toothCode: 36, condition: "CARIES", surfaces: ["O"] },
      { toothCode: 55, condition: "MISSING", surfaces: [] },
      { toothCode: 84, condition: "FILLING", surfaces: ["O"] },
    ];
    const { container } = render(
      <Odontogram fdi={fdi} records={mixed} layout="chart" legend="present" />,
    );
    expect(screen.getByRole("button", { name: "Permanent · 1 finding" })).toBeTruthy();
    const primary = screen.getByRole("button", { name: "Primary · 2 findings" });
    expect(primary.getAttribute("aria-pressed")).toBe("false");
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("2 findings on primary teeth are not shown.");
    // The "present" legend lists only what the shown teeth carry (no Missing / Filling yet).
    const legend = () => screen.getByRole("list", { name: "Condition legend" });
    expect(
      within(legend())
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("Caries")]);
    expect(await a11yViolations(container)).toEqual([]);

    fireEvent.click(within(note).getByRole("button", { name: "Show primary teeth" }));
    expect(primary.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("note").textContent).toContain(
      "1 finding on permanent teeth is not shown.",
    );
    expect(within(legend()).getAllByRole("listitem")).toHaveLength(2);
  });
});
