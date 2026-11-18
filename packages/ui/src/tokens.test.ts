import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const tok = (name: string) => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`token --${name} missing or not a 6-digit hex`);
  return m[1];
};
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(tok(a)), lum(tok(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground token, background token, minimum]. 4.5 = normal text, 3 = UI components/large text.
const pairs: [string, string, number][] = [
  ["color-text", "color-bg", 4.5],
  ["color-text", "color-surface", 4.5],
  ["color-text", "color-surface-muted", 4.5],
  ["color-text-muted", "color-bg", 4.5],
  ["color-text-muted", "color-surface", 4.5],
  ["color-text-muted", "color-surface-muted", 4.5],
  ["color-primary-contrast", "color-primary", 4.5],
  ["color-primary-contrast", "color-primary-hover", 4.5],
  ["color-primary", "color-bg", 4.5], // links / outline buttons
  ["color-primary", "color-surface", 4.5],
  ["color-primary-subtle-text", "color-primary-subtle", 4.5],
  ["color-danger", "color-surface", 4.5],
  ["color-danger", "color-danger-subtle", 4.5],
  ["color-warning", "color-surface", 4.5],
  ["color-warning", "color-warning-subtle", 4.5],
  ["color-success", "color-success-subtle", 4.5],
  ["color-info", "color-info-subtle", 4.5],
  ["color-border-strong", "color-surface", 3],
  ["color-border-strong", "color-bg", 3],
  ["color-primary", "color-surface", 3], // focus ring against surfaces
];
for (const [fg, bg, min] of pairs)
  test(`${fg} on ${bg} >= ${min}:1`, () => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
