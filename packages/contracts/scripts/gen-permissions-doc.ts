import { renderPermissionsDoc } from "../src/permissions-doc";

const out = new URL("../../../docs/permissions.md", import.meta.url).pathname;
await Bun.write(out, renderPermissionsDoc());
console.log(`wrote ${out}`);
