import axe from "axe-core";

/**
 * Structural WCAG checks via axe-core in a simulated DOM. Colour contrast cannot be computed here;
 * it is covered by tokens.test.ts (token pairs) and by running axe in a real browser on /design.
 */
export async function a11yViolations(root: Element = document.body) {
  const r = await axe.run(root, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
    },
  });
  return r.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(" | ")})`,
  );
}
