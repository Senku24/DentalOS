import {
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  TOOTH_LEVEL_CONDITIONS,
  TOOTH_SURFACE_LABELS,
  type ToothSurface,
  toothName,
  validSurfaces,
} from "@dentalos/validation";
// Wave 3: import from "@dentalos/ui" once packages/ui/src/index.ts exports the odontogram (see the
// U2 report). Until then the component is pulled from its source file (same transpiled package).
import {
  ODONTOGRAM_CONDITIONS,
  Odontogram,
  type OdontogramDentition,
  type OdontogramFdi,
  type OdontogramRecord,
} from "../../../../packages/ui/src/odontogram";
import { humanize } from "../../lib/format";

export { Odontogram, ODONTOGRAM_CONDITIONS };
export type { OdontogramDentition, OdontogramRecord };

/** The shared FDI helpers (packages/validation fdi.ts) in the shape the odontogram takes. */
export const FDI: OdontogramFdi = {
  permanentTeeth: PERMANENT_TEETH,
  primaryTeeth: PRIMARY_TEETH,
  validSurfaces,
  toothName,
  surfaceLabels: TOOTH_SURFACE_LABELS,
};

export const conditionLabel = (c: string) => ODONTOGRAM_CONDITIONS[c]?.label ?? humanize(c);

/** Whole-tooth conditions take no surfaces (validation rejects them). */
export const isToothLevel = (c: string) =>
  (TOOTH_LEVEL_CONDITIONS as readonly string[]).includes(c);

export const surfaceName = (s: string) => TOOTH_SURFACE_LABELS[s as ToothSurface] ?? s;

/** "36 · Lower left first molar" */
export const toothLabel = (code: number) => `${code} · ${toothName(code)}`;

/** "36 MO" / "Whole tooth" / "—" for compact tables. */
export function toothShort(code: number | null | undefined, surfaces: readonly string[] = []) {
  if (code === null || code === undefined) return "—";
  return surfaces.length ? `${code} ${surfaces.join("")}` : String(code);
}

/** Full accessible text: "Lower left first molar (36), mesial and occlusal". */
export function toothLong(code: number | null | undefined, surfaces: readonly string[] = []) {
  if (code === null || code === undefined) return "No tooth";
  const base = `${toothName(code)} (${code})`;
  return surfaces.length
    ? `${base}, ${surfaces.map((s) => surfaceName(s).toLowerCase()).join(", ")}`
    : base;
}

export const dentitionFor = (code: number | undefined): OdontogramDentition =>
  code !== undefined && code >= 50 ? "PRIMARY" : "PERMANENT";
