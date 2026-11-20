"use client";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";

/**
 * Interactive FDI odontogram (PRD 3.4 / 4.4). Pure presentational: records and selection come in as
 * props, user intent goes out as events. Tooth numbering, surfaces and accessible names come from
 * the shared FDI helpers in `@dentalos/validation` (`fdi.ts`), passed in as `fdi` so this package
 * stays free of domain dependencies:
 *
 *   import * as F from "@dentalos/validation";
 *   const fdi = { permanentTeeth: F.PERMANENT_TEETH, primaryTeeth: F.PRIMARY_TEETH,
 *                 validSurfaces: F.validSurfaces, toothName: F.toothName,
 *                 surfaceLabels: F.TOOTH_SURFACE_LABELS };
 *
 * Layout: the chart is drawn from the dentist's view (patient's right on the viewer's left), upper
 * arch on top: 18…11 | 21…28 over 48…41 | 31…38 (primary 55…51 | 61…65 over 85…81 | 71…75).
 * Each tooth shows its five surfaces (mesial, occlusal/incisal, distal, buccal/facial,
 * lingual/palatal) — mesial always faces the midline, buccal/facial always faces outwards.
 *
 * Keyboard (WAI-ARIA grid): one tab stop; arrows move, Home/End go to the row ends,
 * Ctrl+Home/End to the first/last tooth; Enter/Space selects; Shift/Ctrl/Cmd+Enter/Space (or
 * click) adds/removes a tooth from the selection; Escape clears it.
 * Narrow containers (≤ 520px, container query) get an equivalent tooth list instead of the chart.
 */

export type OdontogramDentition = "PERMANENT" | "PRIMARY";

/** The subset of `@dentalos/validation` fdi.ts the chart needs. */
export interface OdontogramFdi {
  permanentTeeth: readonly number[];
  primaryTeeth: readonly number[];
  /** Five surfaces in chart order: mesial, occlusal/incisal, distal, buccal/facial, lingual/palatal. */
  validSurfaces: (code: number) => readonly string[];
  toothName: (code: number) => string;
  surfaceLabels: Readonly<Record<string, string>>;
}

/** A charted finding (CURRENT tooth record). Empty `surfaces` = whole-tooth condition. */
export interface OdontogramRecord {
  toothCode: number;
  condition: string;
  surfaces: readonly string[];
}

export interface OdontogramConditionStyle {
  label: string;
  /** Short text shown on the tooth so meaning never depends on colour alone. */
  abbr: string;
  /** CSS colour (token-backed custom property). */
  color: string;
  /** Tooth is absent: drawn crossed out. */
  absent?: boolean;
}

const c = (name: string, fallback: string) => `var(--dos-odo-${name}, ${fallback})`;

/** Default legend for `TOOTH_CONDITIONS` (unknown conditions fall back to OTHER). */
export const ODONTOGRAM_CONDITIONS: Readonly<Record<string, OdontogramConditionStyle>> = {
  SOUND: { label: "Sound", abbr: "S", color: c("sound", "#0a704f") },
  CARIES: { label: "Caries", abbr: "Ca", color: c("caries", "#b42318") },
  FILLED: { label: "Filled", abbr: "F", color: c("filled", "#1d5fa8") },
  CROWN: { label: "Crown", abbr: "Cr", color: c("crown", "#b54708") },
  VENEER: { label: "Veneer", abbr: "V", color: c("veneer", "#7a4cc2") },
  SEALANT: { label: "Sealant", abbr: "Se", color: c("sealant", "#2f7d8c") },
  FRACTURED: { label: "Fractured", abbr: "Fx", color: c("fractured", "#a1253f") },
  ROOT_CANAL_TREATED: { label: "Root canal treated", abbr: "RCT", color: c("rct", "#5b4bb7") },
  PERIAPICAL_LESION: { label: "Periapical lesion", abbr: "PA", color: c("pa", "#9a3412") },
  MOBILITY: { label: "Mobility", abbr: "Mo", color: c("mobility", "#8a5a00") },
  BRIDGE_ABUTMENT: { label: "Bridge abutment", abbr: "Ab", color: c("abutment", "#6b5d2f") },
  BRIDGE_PONTIC: { label: "Bridge pontic", abbr: "Po", color: c("pontic", "#6b5d2f") },
  IMPLANT: { label: "Implant", abbr: "Im", color: c("implant", "#3f6f3a") },
  MISSING: { label: "Missing", abbr: "Mi", color: c("missing", "#5f6368"), absent: true },
  EXTRACTED: { label: "Extracted", abbr: "Ex", color: c("extracted", "#5f6368"), absent: true },
  UNERUPTED: { label: "Unerupted", abbr: "Un", color: c("unerupted", "#5f6368") },
  IMPACTED: { label: "Impacted", abbr: "Ip", color: c("impacted", "#7c4a1e") },
  OTHER: { label: "Other", abbr: "O", color: c("other", "#26272a") },
};

export interface OdontogramProps {
  fdi: OdontogramFdi;
  /** CURRENT records; later entries win when several cover the same surface. */
  records?: readonly OdontogramRecord[];
  /** Controlled dentition. Omit for an internal toggle that starts at `defaultDentition`. */
  dentition?: OdontogramDentition;
  defaultDentition?: OdontogramDentition;
  onDentitionChange?: (d: OdontogramDentition) => void;
  /** Selected tooth codes (controlled). */
  selected?: readonly number[];
  onSelectionChange?: (teeth: number[]) => void;
  /** Pointer shortcut: a click on one surface of a tooth (keyboard users pick surfaces in a form). */
  onSurfaceClick?: (toothCode: number, surface: string) => void;
  /** Allow Shift/Ctrl/Cmd to build a multi-tooth selection (default true). */
  multiple?: boolean;
  /** Surfaces to highlight as "being edited" (e.g. the open charting form). */
  pendingSurfaces?: Readonly<Record<number, readonly string[]>>;
  /** Accessible name of the chart. */
  label?: string;
  /** "auto" switches to the tooth list in narrow containers. */
  layout?: "auto" | "chart" | "list";
  /** Legend below the chart: every condition, only those charted, or none. */
  legend?: "all" | "present" | "none";
  conditions?: Readonly<Record<string, OdontogramConditionStyle>>;
  /** Extra content in the toolbar (e.g. a history toggle). */
  toolbar?: ReactNode;
  className?: string;
}

const UPPER = new Set([1, 2, 5, 6]);
const PATIENT_RIGHT = new Set([1, 4, 5, 8]);
const quadrantOf = (code: number) => Math.floor(code / 10);

/** Rows in chart order (upper then lower; patient's right on the viewer's left). */
export function odontogramRows(
  fdi: Pick<OdontogramFdi, "permanentTeeth" | "primaryTeeth">,
  dentition: OdontogramDentition,
): number[][] {
  const teeth = dentition === "PERMANENT" ? fdi.permanentTeeth : fdi.primaryTeeth;
  const [qr1, ql1, ql2, qr2] = dentition === "PERMANENT" ? [1, 2, 3, 4] : [5, 6, 7, 8];
  const inQ = (q: number) =>
    teeth.filter((t) => quadrantOf(t) === q).sort((a, b) => (a % 10) - (b % 10));
  return [
    [...inQ(qr1).reverse(), ...inQ(ql1)],
    [...inQ(qr2).reverse(), ...inQ(ql2)],
  ];
}

type Region = "top" | "right" | "bottom" | "left" | "center";

/** Which drawn region shows which surface: mesial faces the midline, buccal/facial faces out. */
export function surfaceRegions(fdi: Pick<OdontogramFdi, "validSurfaces">, code: number) {
  const [mesial, center, distal, outer, inner] = fdi.validSurfaces(code);
  const q = quadrantOf(code);
  const upper = UPPER.has(q);
  const right = PATIENT_RIGHT.has(q);
  const map: Record<Region, string | undefined> = {
    center,
    top: upper ? outer : inner,
    bottom: upper ? inner : outer,
    left: right ? distal : mesial,
    right: right ? mesial : distal,
  };
  return map;
}

const REGION_SHAPES: Record<Region, string> = {
  top: "2,2 38,2 27,13 13,13",
  right: "38,2 38,38 27,27 27,13",
  bottom: "2,38 38,38 27,27 13,27",
  left: "2,2 13,13 13,27 2,38",
  center: "13,13 27,13 27,27 13,27",
};

interface ToothState {
  surfaceFill: Record<string, OdontogramConditionStyle>;
  whole: OdontogramConditionStyle[];
  findings: { style: OdontogramConditionStyle; surfaces: readonly string[] }[];
  absent: boolean;
}

function styleFor(
  conditions: Readonly<Record<string, OdontogramConditionStyle>>,
  condition: string,
): OdontogramConditionStyle {
  return (
    conditions[condition] ??
    conditions.OTHER ?? { label: condition, abbr: "?", color: "currentColor" }
  );
}

function buildState(
  records: readonly OdontogramRecord[],
  conditions: Readonly<Record<string, OdontogramConditionStyle>>,
): Map<number, ToothState> {
  const out = new Map<number, ToothState>();
  for (const r of records) {
    const st = out.get(r.toothCode) ?? { surfaceFill: {}, whole: [], findings: [], absent: false };
    const style = styleFor(conditions, r.condition);
    st.findings.push({ style, surfaces: r.surfaces });
    if (r.surfaces.length === 0) {
      st.whole.push(style);
      if (style.absent) st.absent = true;
    } else for (const s of r.surfaces) st.surfaceFill[s] = style;
    out.set(r.toothCode, st);
  }
  return out;
}

/** "Lower left first molar, tooth 36: Caries (Mesial, Occlusal); Root canal treated". */
export function describeTooth(
  fdi: Pick<OdontogramFdi, "toothName" | "surfaceLabels">,
  code: number,
  findings: ToothState["findings"] | undefined,
): string {
  const base = `${fdi.toothName(code)}, tooth ${code}`;
  if (!findings || findings.length === 0) return `${base}: no findings`;
  const parts = findings.map((f) =>
    f.surfaces.length === 0
      ? f.style.label
      : `${f.style.label} (${f.surfaces.map((s) => fdi.surfaceLabels[s] ?? s).join(", ")})`,
  );
  return `${base}: ${parts.join("; ")}`;
}

const CSS = `
.dos-odo{container-type:inline-size;display:grid;gap:var(--space-3,12px);min-width:0}
.dos-odo__bar{display:flex;flex-wrap:wrap;gap:var(--space-2,8px);align-items:center;justify-content:space-between}
.dos-odo__seg{display:inline-flex;border:1px solid var(--color-border-strong,#868a8f);border-radius:var(--radius-sm,6px);overflow:hidden}
.dos-odo__seg button{font:inherit;font-size:var(--text-sm,13px);min-height:var(--control-height-sm,32px);padding:0 var(--space-3,12px);border:0;background:var(--color-surface,#fff);color:var(--color-text,#26272a);cursor:pointer}
.dos-odo__seg button+button{border-left:1px solid var(--color-border-strong,#868a8f)}
.dos-odo__seg button[aria-pressed="true"]{background:var(--color-primary,#0b7553);color:var(--color-primary-contrast,#fff);font-weight:600}
.dos-odo__seg button:focus-visible,.dos-odo__tooth:focus-visible,.dos-odo__item:focus-visible{outline:none;box-shadow:var(--focus-ring,0 0 0 2px #fff,0 0 0 4px #0b7553);position:relative;z-index:1}
.dos-odo__chart{display:grid;gap:var(--space-2,8px);margin-inline:auto;width:100%}
.dos-odo__chart[data-dentition="PERMANENT"]{max-width:56rem}
.dos-odo__chart[data-dentition="PRIMARY"]{max-width:36rem}
.dos-odo__sides{display:flex;justify-content:space-between;font-size:var(--text-xs,12px);color:var(--color-text-muted,#5f6368)}
.dos-odo__row{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:2px}
.dos-odo__row+.dos-odo__row{border-top:1px dashed var(--color-border-strong,#868a8f);padding-top:var(--space-2,8px)}
.dos-odo__cell{min-width:0;display:flex}
.dos-odo__cell[data-midline="true"]{margin-left:var(--space-2,8px);position:relative}
.dos-odo__cell[data-midline="true"]::before{content:"";position:absolute;left:calc(-1 * var(--space-1,4px) - 1px);top:0;bottom:0;border-left:1px dashed var(--color-border-strong,#868a8f)}
.dos-odo__tooth{all:unset;box-sizing:border-box;cursor:pointer;flex:1;min-width:24px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 1px;border:2px solid transparent;border-radius:var(--radius-sm,6px);color:var(--color-text,#26272a)}
.dos-odo__row[data-arch="lower"] .dos-odo__tooth{flex-direction:column-reverse}
.dos-odo__tooth:hover{background:var(--color-surface-muted,#f4f1ec)}
.dos-odo__cell[aria-selected="true"] .dos-odo__tooth{border-color:var(--color-primary,#0b7553);background:var(--color-primary-subtle,#e6f4ee)}
.dos-odo__num{font-size:var(--text-xs,12px);font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.dos-odo__abbr{font-size:10px;line-height:1.1;min-height:11px;color:var(--color-text-muted,#5f6368);text-align:center;overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis}
.dos-odo__glyph{width:100%;max-width:44px;height:auto;display:block}
.dos-odo__glyph polygon{stroke:var(--color-border-strong,#868a8f);stroke-width:1;fill:var(--color-surface,#fff)}
.dos-odo__glyph[data-absent="true"]{opacity:.45}
.dos-odo__glyph polygon[data-pending="true"]{stroke:var(--color-primary,#0b7553);stroke-width:2.5}
.dos-odo__count{font-variant-numeric:tabular-nums}
.dos-odo__sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dos-odo__notice{margin:0;padding:var(--space-2,8px) var(--space-3,12px);border:1px solid var(--color-warning,#9a6700);border-left-width:4px;border-radius:var(--radius-sm,6px);background:var(--color-warning-subtle,#fff8e1);color:var(--color-text,#26272a);font-size:var(--text-sm,13px)}
.dos-odo__notice button{font:inherit;font-weight:600;background:none;border:0;padding:0;color:var(--color-primary,#0b7553);text-decoration:underline;cursor:pointer;min-height:var(--target-min,24px)}
.dos-odo__notice button:focus-visible{outline:none;box-shadow:var(--focus-ring,0 0 0 2px #fff,0 0 0 4px #0b7553)}
.dos-odo__legend{display:flex;flex-wrap:wrap;gap:var(--space-1,4px) var(--space-3,12px);list-style:none;margin:0;padding:0;font-size:var(--text-xs,12px);color:var(--color-text-muted,#5f6368)}
.dos-odo__legend li{display:inline-flex;align-items:center;gap:4px}
.dos-odo__swatch{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--color-border-strong,#868a8f)}
.dos-odo__list{display:none;list-style:none;margin:0;padding:0;gap:var(--space-1,4px)}
.dos-odo[data-layout="list"] .dos-odo__list{display:grid}
.dos-odo[data-layout="list"] .dos-odo__chart{display:none}
.dos-odo__item{all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:var(--space-2,8px);align-items:baseline;width:100%;min-height:var(--target-min,24px);padding:var(--space-2,8px);border:1px solid var(--color-border,#e7e2da);border-radius:var(--radius-sm,6px);font-size:var(--text-sm,13px)}
.dos-odo__item[aria-pressed="true"]{border-color:var(--color-primary,#0b7553);background:var(--color-primary-subtle,#e6f4ee)}
.dos-odo__item b{font-variant-numeric:tabular-nums;min-width:2ch}
.dos-odo__item span{color:var(--color-text-muted,#5f6368)}
.dos-odo__group{font-size:var(--text-xs,12px);font-weight:600;color:var(--color-text-muted,#5f6368);margin-top:var(--space-2,8px)}
@container (max-width: 520px){
.dos-odo[data-layout="auto"] .dos-odo__chart{display:none}
.dos-odo[data-layout="auto"] .dos-odo__list{display:grid}
}
`;

const QUADRANT_LABELS: Record<number, string> = {
  1: "Upper right",
  2: "Upper left",
  3: "Lower left",
  4: "Lower right",
  5: "Primary upper right",
  6: "Primary upper left",
  7: "Primary lower left",
  8: "Primary lower right",
};

export function Odontogram({
  fdi,
  records = [],
  dentition: dentitionProp,
  defaultDentition = "PERMANENT",
  onDentitionChange,
  selected = [],
  onSelectionChange,
  onSurfaceClick,
  multiple = true,
  pendingSurfaces,
  label = "Odontogram",
  layout = "auto",
  legend = "all",
  conditions = ODONTOGRAM_CONDITIONS,
  toolbar,
  className,
}: OdontogramProps) {
  const [inner, setInner] = useState<OdontogramDentition>(defaultDentition);
  const dentition = dentitionProp ?? inner;
  const rows = useMemo(() => odontogramRows(fdi, dentition), [fdi, dentition]);
  const flat = useMemo(() => rows.flat(), [rows]);
  const state = useMemo(() => buildState(records, conditions), [records, conditions]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [active, setActive] = useState<number | null>(null);
  const refs = useRef(new Map<number, HTMLButtonElement | null>());

  // Roving tab stop: the last focused tooth if still shown, else the first selected, else 18/55.
  const tabStop =
    active !== null && flat.includes(active)
      ? active
      : (selected.find((t) => flat.includes(t)) ?? flat[0]);

  const setDentition = (d: OdontogramDentition) => {
    if (dentitionProp === undefined) setInner(d);
    onDentitionChange?.(d);
  };

  const select = useCallback(
    (code: number, additive: boolean) => {
      if (!onSelectionChange) return;
      if (additive && multiple) {
        const next = selectedSet.has(code)
          ? selected.filter((t) => t !== code)
          : [...selected, code];
        onSelectionChange(next);
      } else onSelectionChange([code]);
    },
    [onSelectionChange, multiple, selected, selectedSet],
  );

  const focusTooth = (code: number | undefined) => {
    if (code === undefined) return;
    setActive(code);
    refs.current.get(code)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, row: number, col: number) => {
    const r = rows[row] ?? [];
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    let target: number | undefined;
    switch (e.key) {
      case "ArrowRight":
        target = r[Math.min(col + 1, r.length - 1)];
        break;
      case "ArrowLeft":
        target = r[Math.max(col - 1, 0)];
        break;
      case "ArrowDown":
        target = rows[Math.min(row + 1, rows.length - 1)]?.[col];
        break;
      case "ArrowUp":
        target = rows[Math.max(row - 1, 0)]?.[col];
        break;
      case "Home":
        target = e.ctrlKey || e.metaKey ? rows[0]?.[0] : r[0];
        break;
      case "End": {
        const last = rows[rows.length - 1] ?? [];
        target = e.ctrlKey || e.metaKey ? last[last.length - 1] : r[r.length - 1];
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const code = r[col];
        if (code !== undefined) select(code, additive);
        return;
      }
      case "Escape":
        if (selected.length > 0 && onSelectionChange) {
          e.preventDefault();
          onSelectionChange([]);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    focusTooth(target);
  };

  const onToothClick = (e: MouseEvent<HTMLButtonElement>, code: number) => {
    setActive(code);
    const surface = (e.target as Element | null)?.getAttribute?.("data-surface");
    if (surface && onSurfaceClick) onSurfaceClick(code, surface);
    select(code, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  // Findings per dentition, so a finding on the set that is not shown is never silently hidden.
  const counts = useMemo(() => {
    const perm = new Set(fdi.permanentTeeth);
    const prim = new Set(fdi.primaryTeeth);
    return {
      PERMANENT: records.filter((r) => perm.has(r.toothCode)).length,
      PRIMARY: records.filter((r) => prim.has(r.toothCode)).length,
    } satisfies Record<OdontogramDentition, number>;
  }, [records, fdi]);
  const otherDentition: OdontogramDentition = dentition === "PERMANENT" ? "PRIMARY" : "PERMANENT";
  const hiddenCount = counts[otherDentition];

  // "present" lists only conditions on the teeth actually shown.
  const legendEntries = useMemo(() => {
    if (legend === "none") return [];
    if (legend === "all") return Object.entries(conditions);
    const shown = new Set(flat);
    const present = new Set(
      records
        .filter((r) => shown.has(r.toothCode))
        .map((r) => (conditions[r.condition] ? r.condition : "OTHER")),
    );
    return Object.entries(conditions).filter(([k]) => present.has(k));
  }, [legend, conditions, records, flat]);

  const glyph = (code: number) => {
    const st = state.get(code);
    const regions = surfaceRegions(fdi, code);
    const pending = new Set(pendingSurfaces?.[code] ?? []);
    const ring = st?.whole.find((w) => !w.absent);
    return (
      <svg
        className="dos-odo__glyph"
        viewBox="0 0 40 40"
        aria-hidden="true"
        focusable="false"
        data-absent={st?.absent ? "true" : undefined}
      >
        {ring ? (
          <rect
            x="0.5"
            y="0.5"
            width="39"
            height="39"
            rx="4"
            fill="none"
            stroke={ring.color}
            strokeWidth="2"
          />
        ) : null}
        {(Object.keys(REGION_SHAPES) as Region[]).map((region) => {
          const surface = regions[region];
          const fill = surface ? st?.surfaceFill[surface] : undefined;
          return (
            <polygon
              key={region}
              points={REGION_SHAPES[region]}
              data-surface={surface}
              data-pending={surface && pending.has(surface) ? "true" : undefined}
              style={fill ? { fill: fill.color } : undefined}
            />
          );
        })}
        {st?.absent ? (
          <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="4" y1="4" x2="36" y2="36" />
            <line x1="36" y1="4" x2="4" y2="36" />
          </g>
        ) : null}
      </svg>
    );
  };

  const abbr = (code: number) => {
    const st = state.get(code);
    if (!st) return "";
    return [...new Set(st.findings.map((f) => f.style.abbr))].join(" ");
  };

  return (
    <div className={cx("dos-odo", className)} data-layout={layout}>
      <style href="dos-odontogram" precedence="medium">
        {CSS}
      </style>
      <div className="dos-odo__bar">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a legend box to a toolbar control */}
        <div className="dos-odo__seg" role="group" aria-label="Dentition">
          {(["PERMANENT", "PRIMARY"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={dentition === d}
              onClick={() => setDentition(d)}
            >
              {d === "PERMANENT" ? "Permanent" : "Primary"}
              {counts[d] > 0 ? (
                <span className="dos-odo__count">
                  {" "}
                  · {counts[d]}
                  <span className="dos-odo__sr"> finding{counts[d] === 1 ? "" : "s"}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {toolbar ? <div className="dos-odo__bar">{toolbar}</div> : null}
      </div>
      {hiddenCount > 0 ? (
        <p className="dos-odo__notice" role="note">
          {hiddenCount} finding{hiddenCount === 1 ? "" : "s"} on{" "}
          {otherDentition === "PRIMARY" ? "primary" : "permanent"} teeth{" "}
          {hiddenCount === 1 ? "is" : "are"} not shown.{" "}
          <button type="button" onClick={() => setDentition(otherDentition)}>
            Show {otherDentition === "PRIMARY" ? "primary" : "permanent"} teeth
          </button>
        </p>
      ) : null}

      {layout !== "list" ? (
        <div className="dos-odo__chart" data-dentition={dentition}>
          <div className="dos-odo__sides" aria-hidden="true">
            <span>Patient's right</span>
            <span>Patient's left</span>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid of tooth buttons laid out with CSS grid, not tabular data */}
          <div
            role="grid"
            aria-label={`${label} (${dentition === "PERMANENT" ? "permanent" : "primary"} dentition)`}
            aria-multiselectable={multiple && onSelectionChange ? true : undefined}
          >
            {rows.map((row, ri) => (
              // biome-ignore lint/a11y/useFocusableInteractive: focus lives on the tooth buttons (roving tabindex)
              <div
                key={ri === 0 ? "upper" : "lower"}
                // biome-ignore lint/a11y/useSemanticElements: row of the ARIA grid (CSS grid layout, not a table)
                role="row"
                className="dos-odo__row"
                data-arch={ri === 0 ? "upper" : "lower"}
                style={{ ["--cols" as string]: row.length }}
              >
                {row.map((code, ci) => {
                  const isSel = selectedSet.has(code);
                  return (
                    // biome-ignore lint/a11y/useFocusableInteractive: the cell's tooth button is the focus target
                    <div
                      key={code}
                      // biome-ignore lint/a11y/useSemanticElements: cell of the ARIA grid (CSS grid layout, not a table)
                      role="gridcell"
                      className="dos-odo__cell"
                      aria-selected={onSelectionChange ? isSel : undefined}
                      data-midline={ci === row.length / 2 ? "true" : undefined}
                      data-tooth={code}
                    >
                      <button
                        ref={(el) => {
                          refs.current.set(code, el);
                        }}
                        type="button"
                        className="dos-odo__tooth"
                        tabIndex={code === tabStop ? 0 : -1}
                        aria-label={describeTooth(fdi, code, state.get(code)?.findings)}
                        onKeyDown={(e) => onKeyDown(e, ri, ci)}
                        onFocus={() => setActive(code)}
                        onClick={(e) => onToothClick(e, code)}
                      >
                        <span className="dos-odo__num" aria-hidden="true">
                          {code}
                        </span>
                        {glyph(code)}
                        <span className="dos-odo__abbr" aria-hidden="true">
                          {abbr(code)}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {layout !== "chart" ? (
        <ul className="dos-odo__list" aria-label={`${label} tooth list`}>
          {flat
            .slice()
            .sort((a, b) => a - b)
            .map((code, i, all) => {
              const q = quadrantOf(code);
              const newGroup = i === 0 || quadrantOf(all[i - 1] ?? 0) !== q;
              const findings = state.get(code)?.findings;
              return (
                <li key={code}>
                  {newGroup ? (
                    <div className="dos-odo__group" aria-hidden="true">
                      {QUADRANT_LABELS[q]}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="dos-odo__item"
                    aria-pressed={onSelectionChange ? selectedSet.has(code) : undefined}
                    aria-label={describeTooth(fdi, code, findings)}
                    onClick={(e) => select(code, e.shiftKey || e.ctrlKey || e.metaKey)}
                  >
                    <b>{code}</b>
                    <span>
                      {fdi.toothName(code)}
                      {findings?.length
                        ? ` — ${findings
                            .map((f) =>
                              f.surfaces.length
                                ? `${f.style.label} (${f.surfaces.join(", ")})`
                                : f.style.label,
                            )
                            .join("; ")}`
                        : ""}
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      ) : null}

      {legendEntries.length > 0 ? (
        <ul className="dos-odo__legend" aria-label="Condition legend">
          {legendEntries.map(([key, s]) => (
            <li key={key}>
              <span
                className="dos-odo__swatch"
                aria-hidden="true"
                style={{ background: s.absent ? "transparent" : s.color }}
              />
              <span>
                <b>{s.abbr}</b> {s.label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
