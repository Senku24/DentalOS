import { setRolePassword } from "../src/role-password";

const { ADMIN_DATABASE_URL, APP_DB_PASSWORD } = process.env;
if (!ADMIN_DATABASE_URL || !APP_DB_PASSWORD) {
  console.error("ADMIN_DATABASE_URL and APP_DB_PASSWORD are required");
  process.exit(1);
}
await setRolePassword(ADMIN_DATABASE_URL, "dentalos_app", APP_DB_PASSWORD);
console.log("dentalos_app password rotated");
