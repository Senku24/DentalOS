export const ROLES = [
  "OWNER",
  "MANAGER",
  "DENTIST",
  "RECEPTIONIST",
  "ACCOUNTANT",
  "PATIENT",
] as const;
export type Role = (typeof ROLES)[number];
