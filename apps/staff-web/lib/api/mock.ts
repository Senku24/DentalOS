import type { Permission } from "@dentalos/contracts";
import {
  type BranchResponse,
  type DocumentResponse,
  type DuplicateCheckResponse,
  type MergeableField,
  type PatientResponse,
  type PriceOverrideResponse,
  type ServiceResponse,
  addAlertRequest,
  addAllergyRequest,
  addMedicalHistoryRequest,
  assignDentistRequest,
  createBranchRequest,
  createEnquiryRequest,
  createInvitationRequest,
  createPatientRequest,
  createServiceCategoryRequest,
  createServiceRequest,
  dismissDuplicateRequest,
  duplicateCheckRequest,
  mergePatientsRequest,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
  recordConsentRequest,
  requestUploadRequest,
  setCommunicationPreferencesRequest,
  setPriceOverrideRequest,
  transferDentistRequest,
  updateBranchRequest,
  updateEnquiryRequest,
  updateMembershipRequest,
  updateServiceCategoryRequest,
  updateServiceRequest,
  updateTenantRequest,
  type z,
} from "@dentalos/validation";
import { canDo } from "../session";
import type { Method, MockHandler } from "./client";
import { mapHttpError } from "./errors";
import * as F from "./fixtures";
import { API_PREFIX } from "./routes";

/**
 * In-memory fake of the M1 API for mock mode. Request bodies are validated with the same zod schemas
 * the server uses, so client-side validation gaps show up here too. State lives for the page session.
 */

const ACTOR = "dev-user";
const LATENCY_MS = 220;

// Mutable copies so fixtures stay pristine for tests.
const db = {
  tenant: structuredClone(F.tenant),
  branches: structuredClone(F.branches),
  staff: structuredClone(F.staff),
  invitations: structuredClone(F.invitations),
  assignments: structuredClone(F.assignments),
  categories: structuredClone(F.categories),
  services: structuredClone(F.services),
  overrides: structuredClone(F.overrides),
  patients: structuredClone(F.patients),
  history: structuredClone(F.medicalHistory),
  allergies: structuredClone(F.allergies),
  alerts: structuredClone(F.alerts),
  consents: structuredClone(F.consents),
  commPrefs: structuredClone(F.commPrefs),
  enquiries: structuredClone(F.enquiries),
  duplicates: structuredClone(F.duplicateCandidates),
  documents: structuredClone(F.documents),
};

let seq = 1000;
const newId = (kind: string) => F.fid(kind, ++seq);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

const fail = (
  status: number,
  error: string,
  issues?: { path: string; message: string }[],
  extra: Record<string, unknown> = {},
) => {
  throw mapHttpError(status, { error, issues, ...extra });
};

/** Writes to a merged patient are rejected with a pointer to the survivor (API contract). */
const assertNotMerged = (p: PatientResponse) => {
  if (p.mergedIntoId)
    fail(409, "patient_merged", undefined, {
      mergedIntoId: p.mergedIntoId,
      survivorId: p.mergedIntoId,
    });
};
const writablePatient = (id: string | undefined) => {
  const p = find(db.patients, id);
  assertNotMerged(p);
  return p;
};
const notFound = () => fail(404, "not_found");

/**
 * Permission gates mirroring the API on the few reads whose 403 the UI must handle (staff
 * directory). Display-only principal: the session (dev role / signed-in), overridable in tests.
 */
type MockCan = (perm: Permission, resource?: { branchId?: string }) => boolean;
let mockCan: MockCan = canDo;
export function setSharedMockCan(fn?: MockCan) {
  mockCan = fn ?? canDo;
}
const assertCan = (perm: Permission, branchId?: string) => {
  if (!mockCan(perm, branchId ? { branchId } : undefined)) fail(403, "forbidden");
};

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    fail(
      400,
      "validation_failed",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return (r as { data: z.output<T> }).data;
}

/** Offset cursor pagination over an in-memory list. */
function paginate<T>(rows: T[], q: Record<string, string>) {
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
  const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
  const items = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? String(offset + limit) : null;
  return { items, nextCursor: next };
}

const find = <T extends { id: string }>(list: T[], id: string | undefined): T => {
  const row = list.find((r) => r.id === id);
  if (!row) return notFound() as never;
  return row;
};

const full = (p: PatientResponse) => normalizeName(p.firstName, p.middleName, p.lastName);

function effective(s: ServiceResponse, branchId: string) {
  const ov = db.overrides.find(
    (o) => o.serviceId === s.id && o.branchId === branchId && o.effectiveTo === null,
  );
  return {
    branchId,
    pricePaise: ov ? ov.pricePaise : s.basePricePaise,
    source: ov ? ("OVERRIDE" as const) : ("BASE" as const),
    overrideId: ov ? ov.id : null,
  };
}

export function scoreDuplicates(
  input: z.output<typeof duplicateCheckRequest>,
): DuplicateCheckResponse {
  const name = normalizeName(input.firstName, input.lastName);
  const first = normalizeName(input.firstName);
  const phone = input.phone ? normalizePhoneIN(input.phone) : null;
  const email = normalizeEmail(input.email);
  const matches: DuplicateCheckResponse["matches"] = [];
  for (const p of db.patients) {
    if (p.mergedIntoId || p.id === input.excludePatientId) continue;
    const reasons: DuplicateCheckResponse["matches"][number]["reasons"] = [];
    let score = 0;
    if (phone && (p.phone === phone || p.altPhone === phone)) {
      reasons.push("PHONE_EXACT");
      score += 55;
    }
    if (email && normalizeEmail(p.email) === email) {
      reasons.push("EMAIL_EXACT");
      score += 45;
    }
    const pn = normalizeName(p.firstName, p.lastName);
    if (pn === name) {
      reasons.push("NAME_EXACT");
      score += 30;
    } else if (
      first.length >= 3 &&
      normalizeName(p.firstName).slice(0, 4) === first.slice(0, 4) &&
      normalizeName(p.lastName) === normalizeName(input.lastName)
    ) {
      reasons.push("NAME_SIMILAR");
      score += 20;
    }
    if (input.dob && p.dob === input.dob) {
      reasons.push("DOB_EXACT");
      score += 25;
    }
    if (score >= 40) {
      matches.push({ patient: F.toPatientSummary(p), score: Math.min(100, score), reasons });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return { matches: matches.slice(0, 5) };
}

type Handler = (m: string[], q: Record<string, string>, body: unknown) => unknown;
const table: [Method, RegExp, Handler][] = [];
const on = (method: Method, pattern: string, h: Handler) =>
  table.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

// ---- Organisation ----------------------------------------------------------------------------
on("GET", "/org", () => db.tenant);
on("PATCH", "/org", (_m, _q, b) => {
  const body = parse(updateTenantRequest, b);
  db.tenant = {
    ...db.tenant,
    name: body.name ?? db.tenant.name,
    settings: { ...db.tenant.settings, ...body.settings },
    onboardingStatus: body.onboardingStatus ?? db.tenant.onboardingStatus,
    onboardedAt:
      body.onboardingStatus === "COMPLETED"
        ? (db.tenant.onboardedAt ?? now())
        : db.tenant.onboardedAt,
  };
  return db.tenant;
});
on("GET", "/org/onboarding", () => {
  const s = db.tenant.settings;
  const steps = {
    settings: Boolean(s.displayName && s.defaultTimeZone),
    branches: db.branches.some((b) => b.active),
    services: db.services.some((x) => x.active),
    staff: db.staff.length > 1 || db.invitations.length > 0,
  };
  return {
    status: db.tenant.onboardingStatus,
    onboardedAt: db.tenant.onboardedAt,
    steps,
    complete: Object.values(steps).every(Boolean),
  };
});

// ---- Branches --------------------------------------------------------------------------------
on("GET", "/branches", (_m, q) => ({
  items: db.branches
    .filter((b) => (q.active === undefined ? true : String(b.active) === q.active))
    .sort((a, b) => a.name.localeCompare(b.name)),
}));
on("GET", "/branches/:id", ([id]) => find(db.branches, id));
on("POST", "/branches", (_m, _q, b) => {
  const body = parse(createBranchRequest, b);
  if (db.branches.some((x) => x.code === body.code)) fail(409, "conflict");
  const row: BranchResponse = {
    id: newId("0b"),
    active: true,
    code: body.code,
    name: body.name,
    addressLine1: body.addressLine1 ?? null,
    addressLine2: body.addressLine2 ?? null,
    city: body.city ?? null,
    state: body.state ?? null,
    postalCode: body.postalCode ?? null,
    country: body.country,
    phone: body.phone ?? null,
    email: body.email ?? null,
    timezone: body.timezone,
    workingHours: body.workingHours,
    createdAt: now(),
    updatedAt: now(),
  };
  db.branches.push(row);
  return row;
});
on("PATCH", "/branches/:id", ([id], _q, b) => {
  const row = find(db.branches, id);
  const body = parse(updateBranchRequest, b);
  if (body.code && db.branches.some((x) => x.code === body.code && x.id !== id))
    fail(409, "conflict");
  Object.assign(row, body, { updatedAt: now() });
  return row;
});
on("POST", "/branches/:id/activate", ([id]) =>
  Object.assign(find(db.branches, id), { active: true, updatedAt: now() }),
);
on("POST", "/branches/:id/deactivate", ([id]) =>
  Object.assign(find(db.branches, id), { active: false, updatedAt: now() }),
);

// ---- Staff & invitations ---------------------------------------------------------------------
on("GET", "/staff", (_m, q) => {
  assertCan("staff:read", q.branchId || undefined);
  return {
    items: db.staff.filter(
      (s) =>
        (!q.role || s.roles.includes(q.role as never)) &&
        (!q.branchId || s.orgWide || s.branchScope.includes(q.branchId)),
    ),
  };
});
on("PATCH", "/staff/:id", ([id], _q, b) => {
  const row = find(db.staff, id);
  const body = parse(updateMembershipRequest, b);
  const owners = db.staff.filter((s) => s.roles.includes("OWNER") && s.orgWide && s.id !== id);
  if (owners.length === 0 && !(body.roles.includes("OWNER") && body.orgWide))
    fail(409, "last_owner");
  Object.assign(row, body);
  return row;
});
on("GET", "/invitations", (_m, q) => ({
  items: db.invitations.filter((i) => !q.status || i.status === q.status),
}));
on("POST", "/invitations", (_m, _q, b) => {
  const body = parse(createInvitationRequest, b);
  if (db.invitations.some((i) => i.email === body.email && i.status === "PENDING"))
    fail(409, "conflict");
  const row = {
    id: newId("0c"),
    email: body.email,
    roles: body.roles,
    orgWide: body.orgWide,
    branchScope: body.branchScope,
    status: "PENDING" as const,
    expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString(),
    invitedBy: ACTOR,
    createdAt: now(),
  };
  db.invitations.unshift(row);
  return { ...row, acceptPath: "/accept-invite?mock=1" };
});
on("POST", "/invitations/:id/revoke", ([id]) => {
  const row = find(db.invitations, id);
  if (row.status !== "PENDING") fail(409, "invitation_not_pending");
  row.status = "REVOKED";
  return row;
});
on("POST", "/invitations/:id/resend", ([id], _q, b) => {
  const row = find(db.invitations, id);
  if (row.status !== "PENDING" && row.status !== "EXPIRED") fail(409, "invitation_not_resendable");
  const days = Number((b as { expiresInDays?: number })?.expiresInDays ?? 7);
  row.status = "PENDING";
  row.expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  return row;
});

// ---- Dentist assignments ---------------------------------------------------------------------
on("GET", "/dentist-assignments", (_m, q) => {
  assertCan("staff:read", q.branchId || undefined);
  return {
    items: db.assignments
      .filter(
        (a) =>
          (!q.userId || a.userId === q.userId) &&
          (!q.branchId || a.branchId === q.branchId) &&
          (q.status !== "current" || a.effectiveTo === null || a.effectiveTo > today()),
      )
      .sort(
        (a, b) =>
          a.userId.localeCompare(b.userId) || b.effectiveFrom.localeCompare(a.effectiveFrom),
      ),
  };
});
/** GET /scheduling/dentists (scheduling module, appointment:read): current dentists at a branch. */
on("GET", "/scheduling/dentists", (_m, q) => {
  if (!q.branchId) fail(400, "validation_failed", [{ path: "branchId", message: "Required" }]);
  assertCan("appointment:read", q.branchId);
  find(db.branches, q.branchId);
  const ids = new Set(
    db.assignments
      .filter(
        (a) => a.branchId === q.branchId && (a.effectiveTo === null || a.effectiveTo > today()),
      )
      .map((a) => a.userId),
  );
  return {
    items: db.staff
      .filter((s) => ids.has(s.userId) && s.roles.includes("DENTIST") && !s.removedAt)
      .map((s) => ({
        userId: s.userId,
        displayName: s.displayName ?? F.STAFF_DIRECTORY[s.userId]?.name ?? null,
      }))
      .sort(
        (a, b) =>
          (a.displayName ?? "\uffff").localeCompare(b.displayName ?? "\uffff") ||
          a.userId.localeCompare(b.userId),
      ),
  };
});
on("POST", "/dentist-assignments", (_m, _q, b) => {
  const body = parse(assignDentistRequest, b);
  if (body.effectiveFrom < today()) fail(400, "effective_date_in_past");
  const m = db.staff.find((s) => s.userId === body.userId);
  if (!m?.roles.includes("DENTIST")) fail(400, "not_a_dentist");
  if (!find(db.branches, body.branchId).active) fail(409, "branch_inactive");
  const open = db.assignments.find(
    (a) => a.userId === body.userId && a.branchId === body.branchId && a.effectiveTo === null,
  );
  if (open) fail(409, "conflict");
  const row = { id: newId("0d"), ...body, effectiveTo: null, createdBy: ACTOR, createdAt: now() };
  db.assignments.push(row);
  return row;
});
on("POST", "/dentist-assignments/transfer", (_m, _q, b) => {
  const body = parse(transferDentistRequest, b);
  if (body.effectiveFrom < today()) fail(400, "effective_date_in_past");
  if (!find(db.branches, body.toBranchId).active) fail(409, "branch_inactive");
  const open = db.assignments.find(
    (a) => a.userId === body.userId && a.branchId === body.fromBranchId && a.effectiveTo === null,
  );
  if (!open) return fail(409, "no_open_assignment");
  if (body.effectiveFrom < open.effectiveFrom) fail(400, "transfer_before_assignment_start");
  open.effectiveTo = body.effectiveFrom;
  const created = {
    id: newId("0d"),
    userId: body.userId,
    branchId: body.toBranchId,
    effectiveFrom: body.effectiveFrom,
    effectiveTo: null,
    createdBy: ACTOR,
    createdAt: now(),
  };
  db.assignments.push(created);
  return { closed: open, opened: created };
});
on("POST", "/dentist-assignments/:id/end", ([id], _q, b) => {
  const row = find(db.assignments, id);
  if (row.effectiveTo) fail(409, "assignment_closed");
  row.effectiveTo = String((b as { effectiveTo?: string })?.effectiveTo ?? today());
  return row;
});

// ---- Catalogue -------------------------------------------------------------------------------
on("GET", "/catalog/categories", () => ({
  items: [...db.categories].sort((a, b) => a.sortOrder - b.sortOrder),
}));
on("POST", "/catalog/categories", (_m, _q, b) => {
  const body = parse(createServiceCategoryRequest, b);
  const row = { id: newId("0e"), ...body, active: true };
  db.categories.push(row);
  return row;
});
on("PATCH", "/catalog/categories/:id", ([id], _q, b) =>
  Object.assign(find(db.categories, id), parse(updateServiceCategoryRequest, b)),
);
on("DELETE", "/catalog/categories/:id", ([id]) => {
  find(db.categories, id);
  if (db.services.some((s) => s.categoryId === id)) fail(409, "category_in_use");
  db.categories = db.categories.filter((c) => c.id !== id);
  return undefined;
});
on("GET", "/catalog/services/:id/price", ([id], q) => {
  const s = find(db.services, id);
  return { serviceId: s.id, ...effective(s, q.branchId ?? "") };
});
on("GET", "/catalog/services", (_m, q) => {
  const term = q.q?.toLowerCase();
  const rows = db.services
    .filter(
      (s) =>
        (!term || s.name.toLowerCase().includes(term) || s.code.startsWith(term.toUpperCase())) &&
        (!q.categoryId || s.categoryId === q.categoryId) &&
        (q.active === undefined || String(s.active) === q.active),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) =>
      q.branchId ? { ...s, effectivePricePaise: effective(s, q.branchId).pricePaise } : s,
    );
  return paginate(rows, q);
});
on("POST", "/catalog/services", (_m, _q, b) => {
  const body = parse(createServiceRequest, b);
  if (db.services.some((s) => s.code === body.code)) fail(409, "conflict");
  const row: ServiceResponse = {
    id: newId("05"),
    code: body.code,
    name: body.name,
    description: body.description ?? null,
    categoryId: body.categoryId ?? null,
    durationMin: body.durationMin,
    basePricePaise: body.basePricePaise,
    taxable: body.taxable,
    active: true,
  };
  db.services.push(row);
  return row;
});
on("PATCH", "/catalog/services/:id", ([id], _q, b) => {
  const row = find(db.services, id);
  const body = parse(updateServiceRequest, b);
  if (body.code && db.services.some((s) => s.code === body.code && s.id !== id))
    fail(409, "conflict");
  Object.assign(row, body);
  return row;
});
on("POST", "/catalog/services/:id/activate", ([id]) =>
  Object.assign(find(db.services, id), { active: true }),
);
on("POST", "/catalog/services/:id/deactivate", ([id]) =>
  Object.assign(find(db.services, id), { active: false }),
);
on("GET", "/catalog/price-list", (_m, q) => {
  const branchId = q.branchId ?? "";
  find(db.branches, branchId);
  return {
    branchId,
    items: db.services
      .filter((s) => s.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ ...s, ...effective(s, branchId) })),
  };
});
on("GET", "/catalog/services/:id/overrides", ([id], q) => {
  find(db.services, id);
  return {
    items: db.overrides
      .filter((o) => o.serviceId === id && (!q.branchId || o.branchId === q.branchId))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
  };
});
on("PUT", "/catalog/services/:id/overrides", ([id], _q, b) => {
  find(db.services, id);
  const body = parse(setPriceOverrideRequest, b);
  const from = body.effectiveFrom ?? now();
  for (const o of db.overrides)
    if (o.serviceId === id && o.branchId === body.branchId && o.effectiveTo === null)
      o.effectiveTo = from;
  const row: PriceOverrideResponse = {
    id: newId("06"),
    serviceId: id ?? "",
    branchId: body.branchId,
    pricePaise: body.pricePaise,
    reason: body.reason,
    setBy: ACTOR,
    effectiveFrom: from,
    effectiveTo: null,
  };
  db.overrides.push(row);
  return row;
});
on("POST", "/catalog/services/:id/overrides/clear", ([id], _q, b) => {
  const body = b as { branchId?: string };
  const open = db.overrides.find(
    (o) => o.serviceId === id && o.branchId === body.branchId && o.effectiveTo === null,
  );
  if (open) open.effectiveTo = now();
  return { cleared: Boolean(open) };
});

// ---- Patients --------------------------------------------------------------------------------
on("GET", "/patients", (_m, q) => {
  const term = q.q?.trim();
  const nterm = term ? normalizeName(term) : "";
  const digits = term?.replace(/\D/g, "") ?? "";
  const rows = db.patients
    .filter((p) => {
      if (q.includeMerged !== "true" && p.mergedIntoId) return false;
      if (q.originBranchId && p.originBranchId !== q.originBranchId) return false;
      if (q.lifecycleStage && p.lifecycleStage !== q.lifecycleStage) return false;
      if (q.intakeType && p.intakeType !== q.intakeType) return false;
      if (!term) return true;
      return (
        (nterm && full(p).includes(nterm)) ||
        (digits.length >= 3 && (p.phone ?? "").includes(digits)) ||
        (p.mrn ?? "").toLowerCase() === term.toLowerCase() ||
        (p.email ?? "").toLowerCase() === term.toLowerCase()
      );
    })
    .sort((a, b) => full(a).localeCompare(full(b)))
    .map(F.toPatientSummary);
  return paginate(rows, q);
});
on("POST", "/patients/duplicate-check", (_m, _q, b) =>
  scoreDuplicates(parse(duplicateCheckRequest, b)),
);
on("GET", "/patient-merges/preview", (_m, q) => {
  const survivor = find(db.patients, q.survivorId);
  const merged = find(db.patients, q.mergedId);
  return { survivor, merged };
});
on("POST", "/patient-merges", (_m, _q, b) => {
  const body = parse(mergePatientsRequest, b);
  const survivor = find(db.patients, body.survivorId);
  const merged = find(db.patients, body.mergedId);
  if (survivor.mergedIntoId || merged.mergedIntoId) fail(409, "patient_merged");
  const choices = ((b as { fieldChoices?: Record<string, string> }).fieldChoices ?? {}) as Record<
    MergeableField,
    string
  >;
  for (const [field, side] of Object.entries(choices) as [MergeableField, string][]) {
    if (side === "merged") (survivor as Record<string, unknown>)[field] = merged[field];
  }
  merged.mergedIntoId = survivor.id;
  merged.updatedAt = now();
  survivor.updatedAt = now();
  for (const d of db.duplicates) {
    const ids = [d.patientA.id, d.patientB.id];
    if (ids.includes(merged.id)) {
      d.status = ids.includes(survivor.id) ? "MERGED" : "DISMISSED";
      d.reviewedBy = ACTOR;
      d.reviewedAt = now();
    }
  }
  for (const list of [db.allergies, db.alerts, db.consents, db.documents])
    for (const r of list as { patientId: string }[])
      if (r.patientId === merged.id) r.patientId = survivor.id;
  return {
    id: newId("14"),
    survivorId: survivor.id,
    mergedId: merged.id,
    performedBy: ACTOR,
    approvedBy: null,
    reason: body.reason,
    createdAt: now(),
  };
});
on("GET", "/patients/:id", ([id]) => find(db.patients, id));
on("POST", "/patients", (_m, _q, b) => {
  const body = parse(createPatientRequest, b);
  const dup = scoreDuplicates({
    firstName: body.firstName,
    lastName: body.lastName,
    dob: body.dob,
    phone: body.phone,
    email: body.email,
  });
  // URGENT intake is never blocked by the duplicate check (it is reviewed later).
  if (!body.acknowledgeDuplicates && body.intakeType !== "URGENT" && dup.matches.length > 0)
    fail(409, "possible_duplicates", undefined, { matches: dup.matches });
  const row: PatientResponse = {
    id: newId("01"),
    mrn: `SA-${++seq}`,
    firstName: body.firstName,
    middleName: body.middleName ?? null,
    lastName: body.lastName ?? null,
    preferredName: body.preferredName ?? null,
    dob: body.dob ?? null,
    sex: body.sex,
    phone: body.phone ?? null,
    altPhone: body.altPhone ?? null,
    email: body.email ?? null,
    addressLine1: body.addressLine1 ?? null,
    addressLine2: body.addressLine2 ?? null,
    city: body.city ?? null,
    state: body.state ?? null,
    postalCode: body.postalCode ?? null,
    country: body.country,
    originBranchId: body.originBranchId,
    lifecycleStage: "REGISTERED",
    intakeType: body.intakeType,
    mergedIntoId: null,
    identityVerifiedAt: null,
    identityVerificationMethod: null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.patients.push(row);
  if (body.enquiryId) {
    const e = db.enquiries.find((x) => x.id === body.enquiryId);
    if (e) Object.assign(e, { status: "CONVERTED", convertedPatientId: row.id });
  }
  return { ...row, possibleDuplicates: dup.matches };
});
on("PATCH", "/patients/:id", ([id], _q, b) => {
  const row = writablePatient(id);
  Object.assign(row, b as object, { updatedAt: now() });
  return { ...row, possibleDuplicates: [] };
});
const TRANSITIONS: Record<string, string[]> = {
  REGISTERED: ["ACTIVE", "IN_TREATMENT", "INACTIVE"],
  ACTIVE: ["IN_TREATMENT", "FOLLOW_UP", "RECALL", "INACTIVE"],
  IN_TREATMENT: ["FOLLOW_UP", "ACTIVE", "INACTIVE"],
  FOLLOW_UP: ["RECALL", "ACTIVE", "IN_TREATMENT", "INACTIVE"],
  RECALL: ["ACTIVE", "IN_TREATMENT", "INACTIVE"],
  INACTIVE: ["ACTIVE"],
};
on("POST", "/patients/:id/lifecycle", ([id], _q, b) => {
  const row = writablePatient(id);
  const stage = String((b as { stage?: string })?.stage ?? "");
  if (!TRANSITIONS[row.lifecycleStage]?.includes(stage)) fail(409, "invalid_transition");
  Object.assign(row, { lifecycleStage: stage, updatedAt: now() });
  return row;
});
on("POST", "/patients/:id/identity-verification", ([id], _q, b) => {
  const row = writablePatient(id);
  Object.assign(row, {
    identityVerifiedAt: now(),
    identityVerificationMethod: (b as { method?: string })?.method ?? "IN_PERSON_DOCUMENT",
  });
  return row;
});
on("GET", "/patients/:id/merges", () => ({ items: [] }));
on("GET", "/patients/:id/medical-history", ([id]) => {
  const ids = new Set([id, ...db.patients.filter((p) => p.mergedIntoId === id).map((p) => p.id)]);
  const versions = db.history
    .filter((h) => ids.has(h.patientId))
    .sort((a, b) => b.version - a.version);
  return { latest: versions[0] ?? null, versions };
});
on("POST", "/patients/:id/medical-history", ([id], _q, b) => {
  writablePatient(id);
  const body = parse(addMedicalHistoryRequest, b);
  const version =
    Math.max(0, ...db.history.filter((h) => h.patientId === id).map((h) => h.version)) + 1;
  const row = {
    id: newId("07"),
    patientId: id ?? "",
    version,
    medical: body.medical,
    dental: body.dental,
    medications: body.medications,
    notes: body.notes ?? null,
    recordedBy: ACTOR,
    recordedAt: now(),
  };
  db.history.push(row);
  return row;
});
on("GET", "/patients/:id/allergies", ([id], q) => ({
  items: db.allergies.filter(
    (a) => a.patientId === id && (q.includeResolved === "true" || a.active),
  ),
}));
on("POST", "/patients/:id/allergies", ([id], _q, b) => {
  writablePatient(id);
  const body = parse(addAllergyRequest, b);
  const row = {
    id: newId("08"),
    patientId: id ?? "",
    substance: body.substance,
    reaction: body.reaction ?? null,
    severity: body.severity,
    active: true,
    notedBy: ACTOR,
    notedAt: now(),
    resolvedAt: null,
  };
  db.allergies.push(row);
  return row;
});
on("POST", "/patients/:id/allergies/:aid/resolve", ([, aid]) =>
  Object.assign(find(db.allergies, aid), { active: false, resolvedAt: now() }),
);
on("GET", "/patients/:id/alerts", ([id], q) => ({
  items: db.alerts.filter((a) => a.patientId === id && (q.includeResolved === "true" || a.active)),
}));
on("POST", "/patients/:id/alerts", ([id], _q, b) => {
  writablePatient(id);
  const body = parse(addAlertRequest, b);
  const row = {
    id: newId("09"),
    patientId: id ?? "",
    title: body.title,
    details: body.details ?? null,
    severity: body.severity,
    active: true,
    createdBy: ACTOR,
    createdAt: now(),
    resolvedAt: null,
  };
  db.alerts.push(row);
  return row;
});
on("POST", "/patients/:id/alerts/:aid/resolve", ([, aid]) =>
  Object.assign(find(db.alerts, aid), { active: false, resolvedAt: now() }),
);
on("GET", "/patients/:id/consents", ([id]) => ({
  items: db.consents.filter((c) => c.patientId === id),
}));
on("POST", "/patients/:id/consents", ([id], _q, b) => {
  writablePatient(id);
  const body = parse(recordConsentRequest, b);
  const row = {
    id: newId("10"),
    patientId: id ?? "",
    type: body.type,
    version: body.version,
    status: body.status,
    method: body.method,
    documentId: body.documentId ?? null,
    capturedBy: ACTOR,
    grantedAt: body.status === "GRANTED" ? now() : null,
    withdrawnAt: null,
  };
  db.consents.unshift(row);
  return row;
});
on("POST", "/patients/:id/consents/:cid/withdraw", ([, cid]) =>
  Object.assign(find(db.consents, cid), { status: "WITHDRAWN", withdrawnAt: now() }),
);
on("GET", "/patients/:id/communication-preferences", ([id]) => ({
  items: db.commPrefs[id ?? ""] ?? [],
}));
on("PUT", "/patients/:id/communication-preferences", ([id], _q, b) => {
  writablePatient(id);
  const body = parse(setCommunicationPreferencesRequest, b);
  db.commPrefs[id ?? ""] = body.preferences;
  return { items: body.preferences };
});

// ---- Enquiries -------------------------------------------------------------------------------
on("GET", "/enquiries", (_m, q) => {
  const term = q.q?.toLowerCase();
  const rows = db.enquiries.filter(
    (e) =>
      (!q.status || e.status === q.status) &&
      (!q.branchId || e.branchId === q.branchId) &&
      (!term || e.name.toLowerCase().includes(term) || (e.phone ?? "").includes(term)),
  );
  return paginate(rows, q);
});
on("POST", "/enquiries", (_m, _q, b) => {
  const body = parse(createEnquiryRequest, b);
  const row = {
    id: newId("11"),
    branchId: body.branchId ?? null,
    name: body.name,
    phone: body.phone ?? null,
    email: body.email ?? null,
    source: body.source,
    areaOfInterest: body.areaOfInterest ?? null,
    notes: body.notes ?? null,
    status: "NEW" as const,
    convertedPatientId: null,
    createdAt: now(),
  };
  db.enquiries.unshift(row);
  return row;
});
on("GET", "/enquiries/:id", ([id]) => find(db.enquiries, id));
on("PATCH", "/enquiries/:id", ([id], _q, b) =>
  Object.assign(find(db.enquiries, id), parse(updateEnquiryRequest, b)),
);
on("POST", "/enquiries/:id/convert", ([id], _q, b) => {
  const e = find(db.enquiries, id);
  if (e.status === "CONVERTED") fail(409, "conflict");
  const existing = (b as { existingPatientId?: string }).existingPatientId;
  if (existing) {
    const p = find(db.patients, existing);
    Object.assign(e, { status: "CONVERTED", convertedPatientId: p.id });
    return p;
  }
  const create = table.find(([m, r]) => m === "POST" && r.test("/patients"))?.[2];
  const p = create?.(
    [],
    {},
    {
      intakeType: "ENQUIRY",
      ...(b as object),
      enquiryId: id,
    },
  ) as PatientResponse;
  return p;
});

// ---- Duplicates ------------------------------------------------------------------------------
on("GET", "/duplicate-candidates", (_m, q) => {
  const status = q.status ?? "PENDING";
  return paginate(
    db.duplicates.filter((d) => d.status === status).sort((a, b) => b.score - a.score),
    q,
  );
});
on("POST", "/duplicate-candidates/:id/dismiss", ([id], _q, b) => {
  parse(dismissDuplicateRequest, b);
  return Object.assign(find(db.duplicates, id), {
    status: "DISMISSED",
    reviewedBy: ACTOR,
    reviewedAt: now(),
  });
});

// ---- Documents -------------------------------------------------------------------------------
on("GET", "/documents", (_m, q) =>
  paginate(
    db.documents
      .filter(
        (d) =>
          d.patientId === q.patientId &&
          d.status === "AVAILABLE" &&
          (!q.category || d.category === q.category) &&
          (!q.branchId || d.branchId === q.branchId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    q,
  ),
);
on("POST", "/documents/uploads", (_m, _q, b) => {
  const body = parse(requestUploadRequest, b);
  writablePatient(body.patientId);
  const row: DocumentResponse = {
    id: newId("13"),
    patientId: body.patientId,
    branchId: body.branchId,
    fileName: body.fileName,
    contentType: body.contentType,
    sizeBytes: body.sizeBytes,
    category: body.category,
    description: body.description ?? null,
    status: "PENDING_UPLOAD",
    uploadedBy: ACTOR,
    createdAt: now(),
  };
  db.documents.push(row);
  return {
    documentId: row.id,
    url: "mock://upload",
    fields: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
});
on("POST", "/documents/:id/confirm", ([id]) =>
  Object.assign(find(db.documents, id), { status: "AVAILABLE" }),
);
on("GET", "/documents/:id/download-url", ([id]) => {
  find(db.documents, id);
  return { url: "mock://download", expiresInSeconds: 300 };
});
on("GET", "/documents/:id", ([id]) => find(db.documents, id));
on("POST", "/documents/:id/delete", ([id], _q, b) => {
  const reason = (b as { reason?: string })?.reason ?? "";
  if (reason.trim().length < 3)
    fail(400, "validation_failed", [{ path: "reason", message: "Too short" }]);
  return Object.assign(find(db.documents, id), { status: "DELETED" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockHandler: MockHandler = async (method, fullPath, query, body) => {
  await sleep(LATENCY_MS);
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) return structuredClone(h(match.slice(1).map(decodeURIComponent), query, body));
  }
  return fail(404, "not_found");
};
