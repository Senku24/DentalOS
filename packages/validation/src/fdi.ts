import { z } from "zod";

/**
 * FDI (ISO 3950) two-digit tooth numbering — PRD 4.4. Pure and frontend-safe (the odontogram UI and
 * the API share it). The database enforces the same rules with fdi_valid_tooth() /
 * fdi_valid_surfaces() CHECKs (migration 0006), so keep both in sync.
 *
 *  - First digit = quadrant: 1 upper right, 2 upper left, 3 lower left, 4 lower right (permanent);
 *    5–8 the same for the primary dentition. "Right/left" are the PATIENT's.
 *  - Second digit = position from the midline: permanent 1–8, primary 1–5.
 *  - Surfaces: M mesial, D distal, O occlusal, I incisal, B buccal, F facial (labial), L lingual,
 *    P palatal. Anterior teeth (positions 1–3: incisors + canine) use I/F instead of O/B;
 *    maxillary teeth (quadrants 1, 2, 5, 6) use P instead of L. So every tooth has exactly 5 valid
 *    surfaces and a surface list never needs a tooth-class lookup on the client beyond this file.
 */

export const DENTITIONS = ["PERMANENT", "PRIMARY"] as const;
export type Dentition = (typeof DENTITIONS)[number];
export const dentition = z.enum(DENTITIONS);

export const TOOTH_SURFACES = ["M", "O", "D", "B", "L", "I", "F", "P"] as const;
export type ToothSurface = (typeof TOOTH_SURFACES)[number];
export const TOOTH_SURFACE_LABELS: Readonly<Record<ToothSurface, string>> = {
  M: "Mesial",
  O: "Occlusal",
  D: "Distal",
  B: "Buccal",
  L: "Lingual",
  I: "Incisal",
  F: "Facial (labial)",
  P: "Palatal",
};

export type ToothClass = "INCISOR" | "CANINE" | "PREMOLAR" | "MOLAR";
export type Arch = "MAXILLARY" | "MANDIBULAR";

const quadrantTeeth = (q: number, n: number) => Array.from({ length: n }, (_, i) => q * 10 + i + 1);
/** 11–18, 21–28, 31–38, 41–48 in chart order per quadrant. */
export const PERMANENT_TEETH: readonly number[] = Object.freeze(
  [1, 2, 3, 4].flatMap((q) => quadrantTeeth(q, 8)),
);
/** 51–55, 61–65, 71–75, 81–85. */
export const PRIMARY_TEETH: readonly number[] = Object.freeze(
  [5, 6, 7, 8].flatMap((q) => quadrantTeeth(q, 5)),
);
export const ALL_TEETH: readonly number[] = Object.freeze([...PERMANENT_TEETH, ...PRIMARY_TEETH]);

export function isValidTooth(code: unknown): code is number {
  if (typeof code !== "number" || !Number.isInteger(code)) return false;
  const q = Math.floor(code / 10);
  const pos = code % 10;
  return (q >= 1 && q <= 4 && pos >= 1 && pos <= 8) || (q >= 5 && q <= 8 && pos >= 1 && pos <= 5);
}

function assertTooth(code: number): void {
  if (!isValidTooth(code)) throw new RangeError(`Invalid FDI tooth code: ${code}`);
}

export function dentitionOf(code: number): Dentition {
  assertTooth(code);
  return code < 50 ? "PERMANENT" : "PRIMARY";
}

/** 1–8. */
export function quadrant(code: number): number {
  assertTooth(code);
  return Math.floor(code / 10);
}

/** Position from the midline: 1–8 permanent, 1–5 primary. */
export function toothPosition(code: number): number {
  assertTooth(code);
  return code % 10;
}

export function arch(code: number): Arch {
  return [1, 2, 5, 6].includes(quadrant(code)) ? "MAXILLARY" : "MANDIBULAR";
}

export function toothClass(code: number): ToothClass {
  const pos = toothPosition(code);
  if (pos <= 2) return "INCISOR";
  if (pos === 3) return "CANINE";
  if (dentitionOf(code) === "PRIMARY") return "MOLAR";
  return pos <= 5 ? "PREMOLAR" : "MOLAR";
}

/** Incisors and canines. */
export function isAnterior(code: number): boolean {
  return toothPosition(code) <= 3;
}

/** The 5 surfaces valid for a tooth, in chart order (mesial, occlusal/incisal, distal, buccal/facial, lingual/palatal). */
export function validSurfaces(code: number): readonly ToothSurface[] {
  const lingual: ToothSurface = arch(code) === "MAXILLARY" ? "P" : "L";
  return isAnterior(code) ? ["M", "I", "D", "F", lingual] : ["M", "O", "D", "B", lingual];
}

/** Every surface valid for the tooth and no duplicates. An empty list (tooth-level) is valid. */
export function areValidSurfaces(code: number, surfaces: readonly string[]): boolean {
  if (!isValidTooth(code)) return false;
  const allowed = validSurfaces(code) as readonly string[];
  return new Set(surfaces).size === surfaces.length && surfaces.every((s) => allowed.includes(s));
}

export function listPermanentTeeth(): number[] {
  return [...PERMANENT_TEETH];
}

export function listPrimaryTeeth(): number[] {
  return [...PRIMARY_TEETH];
}

const POSITION_NAMES_PERMANENT = [
  "central incisor",
  "lateral incisor",
  "canine",
  "first premolar",
  "second premolar",
  "first molar",
  "second molar",
  "third molar",
];
const POSITION_NAMES_PRIMARY = [
  "central incisor",
  "lateral incisor",
  "canine",
  "first molar",
  "second molar",
];
const QUADRANT_NAMES = ["upper right", "upper left", "lower left", "lower right"];

/** Accessible name, e.g. 36 -> "Lower left first molar", 55 -> "Primary upper right second molar". */
export function toothName(code: number): string {
  const q = quadrant(code);
  const primary = q >= 5;
  const where = QUADRANT_NAMES[(q - 1) % 4] ?? "";
  const what = (primary ? POSITION_NAMES_PRIMARY : POSITION_NAMES_PERMANENT)[
    toothPosition(code) - 1
  ];
  const name = `${primary ? "primary " : ""}${where} ${what}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------------------------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------------------------

export const toothCode = z.number().int().refine(isValidTooth, "Invalid FDI tooth code");
export const toothSurface = z.enum(TOOTH_SURFACES);
export const toothSurfaces = z
  .array(toothSurface)
  .max(5)
  .refine((s) => new Set(s).size === s.length, "Duplicate surface");

/**
 * Object-level check for `{ toothCode, surfaces }` pairs: surfaces need a tooth and must be valid
 * for it. Use `"create"` on create schemas (absent tooth = no tooth) and `"patch"` on PATCH schemas
 * (absent tooth = unchanged: skipped here, merged server-side and re-checked by the DB CHECK).
 *   z.object({ toothCode: toothCode.optional(), surfaces: toothSurfaces.default([]) })
 *     .superRefine(toothSurfacesRefinement("create"))
 */
export function toothSurfacesRefinement(mode: "create" | "patch") {
  return (
    v: { toothCode?: number | null; surfaces?: readonly string[] },
    ctx: z.RefinementCtx,
  ): void => {
    const surfaces = v.surfaces ?? [];
    if (surfaces.length === 0) return;
    const tooth = v.toothCode;
    if (tooth === null || (tooth === undefined && mode === "create")) {
      ctx.addIssue({ code: "custom", message: "Surfaces require a tooth", path: ["surfaces"] });
      return;
    }
    if (tooth !== undefined && !areValidSurfaces(tooth, surfaces))
      ctx.addIssue({
        code: "custom",
        message: isValidTooth(tooth)
          ? `Valid surfaces for tooth ${tooth}: ${validSurfaces(tooth).join(", ")}`
          : "Invalid FDI tooth code",
        path: ["surfaces"],
      });
  };
}
