import { ALL_PERMISSIONS, PERMISSIONS, hasPermission } from "./permissions";
import { ROLES } from "./roles";

/** Renders the permission matrix (PRD 2.3 / 12.2 artefact). Output is committed as docs/permissions.md. */
export function renderPermissionsDoc(): string {
  const roles = ROLES.filter((r) => r !== "PATIENT");
  const head = `| Permission | Scope | ${roles.join(" | ")} |`;
  const sep = `|---|---|${roles.map(() => ":-:").join("|")}|`;
  const rows = ALL_PERMISSIONS.map(
    (p) =>
      `| \`${p}\` | ${PERMISSIONS[p]} | ${roles.map((r) => (hasPermission([r], p) ? "✔" : "")).join(" | ")} |`,
  );
  return [
    "# Permission matrix",
    "",
    "> Generated from `packages/contracts/src/permissions.ts` — do not edit by hand.",
    "> Regenerate: `bun run --cwd packages/contracts docs:permissions`.",
    "",
    "Scopes: **tenant** any holder · **branch** resource branch must be in scope (or orgWide) ·",
    "**org** requires orgWide · **self** own records unless orgWide.",
    "A user may hold several roles (union of permissions). `PATIENT` has no staff permissions;",
    "the patient portal uses a separate self-scoped surface.",
    "",
    head,
    sep,
    ...rows,
    "",
  ].join("\n");
}
