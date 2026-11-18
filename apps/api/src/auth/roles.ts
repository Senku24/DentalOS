export type Role = "OWNER" | "MANAGER" | "DENTIST" | "RECEPTIONIST" | "ACCOUNTANT" | "PATIENT";

/** Request principal. Built ONLY from verified token + DB membership, never from client headers. */
export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
  /** Empty = organisation-wide (permission-controlled); otherwise restricted to these branch ids. */
  branchScope: string[];
}

export const canAccessBranch = (p: Principal, branchId: string) =>
  p.branchScope.length === 0 ? p.role === "OWNER" : p.branchScope.includes(branchId);
