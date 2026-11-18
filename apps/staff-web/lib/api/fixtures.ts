import type {
  AlertResponse,
  AllergyResponse,
  BranchResponse,
  ConsentResponse,
  DentistAssignmentResponse,
  DocumentResponse,
  DuplicateCandidateResponse,
  EnquiryResponse,
  InvitationResponse,
  MedicalHistoryResponse,
  PatientResponse,
  PriceOverrideResponse,
  ServiceCategoryResponse,
  ServiceResponse,
  StaffMemberResponse,
  TenantResponse,
  WorkingHours,
} from "@dentalos/validation";
import type { CommunicationPreference } from "./types";

/**
 * Synthetic data for mock mode: a fictional three-branch clinic group in the Delhi NCR region.
 * No real people: names are common given/family names combined arbitrarily, phone numbers use the
 * obviously synthetic +91 90000 0xxxx range, email domains are example.com.
 */

/** Deterministic RFC 9562 v4-shaped ids: `kind` (2 hex) distinguishes entity types. */
export const fid = (kind: string, n: number) =>
  `${kind.padStart(2, "0")}000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const daysAgo = (d: number, hour = 10) => {
  const t = new Date(Date.UTC(2026, 10, 19, hour - 5, 30) - d * 86_400_000);
  return t.toISOString();
};
const dateDaysAgo = (d: number) => daysAgo(d).slice(0, 10);

export const TENANT_ID = "00000000-0000-0000-0000-000000000001";

export const tenant: TenantResponse = {
  id: TENANT_ID,
  name: "Smile Arc Dental Clinics",
  settings: {
    displayName: "Smile Arc Dental",
    defaultTimeZone: "Asia/Kolkata",
    currency: "INR",
  },
  onboardingStatus: "IN_PROGRESS",
  onboardedAt: null,
  createdAt: daysAgo(120),
};

const weekdayHours: WorkingHours = {
  mon: [
    { open: "09:30", close: "13:30" },
    { open: "16:30", close: "20:30" },
  ],
  tue: [
    { open: "09:30", close: "13:30" },
    { open: "16:30", close: "20:30" },
  ],
  wed: [
    { open: "09:30", close: "13:30" },
    { open: "16:30", close: "20:30" },
  ],
  thu: [
    { open: "09:30", close: "13:30" },
    { open: "16:30", close: "20:30" },
  ],
  fri: [
    { open: "09:30", close: "13:30" },
    { open: "16:30", close: "20:30" },
  ],
  sat: [{ open: "10:00", close: "16:00" }],
};

const branch = (
  n: number,
  code: string,
  name: string,
  city: string,
  state: string,
  postalCode: string,
  active = true,
): BranchResponse => ({
  id: fid("0b", n),
  code,
  name,
  active,
  addressLine1: `${10 + n * 7}, Main Market Road`,
  addressLine2: null,
  city,
  state,
  postalCode,
  country: "IN",
  phone: `+91900000${(1000 + n).toString()}`,
  email: `${code.toLowerCase()}@example.com`,
  timezone: "Asia/Kolkata",
  workingHours: weekdayHours,
  createdAt: daysAgo(118 - n),
  updatedAt: daysAgo(30 - n),
});

export const branches: BranchResponse[] = [
  branch(1, "SKT", "Saket", "New Delhi", "Delhi", "110017"),
  branch(2, "GGN", "Gurugram Sector 29", "Gurugram", "Haryana", "122002"),
  branch(3, "NDA", "Noida Sector 18", "Noida", "Uttar Pradesh", "201301"),
  branch(4, "DWK", "Dwarka", "New Delhi", "Delhi", "110075", false),
];
const [B1, B2, B3] = [fid("0b", 1), fid("0b", 2), fid("0b", 3)];

/** Display directory for staff user ids (the membership API returns ids only). */
export const STAFF_DIRECTORY: Record<string, { name: string; email: string }> = {
  "dev-user": { name: "Asha Verma", email: "asha.verma@example.com" },
  "usr-owner-1": { name: "Dr. Vikram Malhotra", email: "vikram.m@example.com" },
  "usr-dent-1": { name: "Dr. Neha Iyer", email: "neha.iyer@example.com" },
  "usr-dent-2": { name: "Dr. Arjun Bhatia", email: "arjun.bhatia@example.com" },
  "usr-dent-3": { name: "Dr. Sana Qureshi", email: "sana.q@example.com" },
  "usr-recep-1": { name: "Pooja Rawat", email: "pooja.rawat@example.com" },
  "usr-recep-2": { name: "Imran Sheikh", email: "imran.sheikh@example.com" },
  "usr-acct-1": { name: "Kavita Joshi", email: "kavita.joshi@example.com" },
};

const member = (
  n: number,
  userId: string,
  roles: StaffMemberResponse["roles"],
  orgWide: boolean,
  branchScope: string[],
): StaffMemberResponse => ({
  id: fid("0a", n),
  userId,
  roles,
  orgWide,
  branchScope,
  createdAt: daysAgo(110 - n * 5),
});

export const staff: StaffMemberResponse[] = [
  member(1, "usr-owner-1", ["OWNER", "DENTIST"], true, []),
  member(2, "dev-user", ["MANAGER"], false, [B1]),
  member(3, "usr-dent-1", ["DENTIST"], false, [B1, B2]),
  member(4, "usr-dent-2", ["DENTIST"], false, [B2]),
  member(5, "usr-dent-3", ["DENTIST"], false, [B3]),
  member(6, "usr-recep-1", ["RECEPTIONIST"], false, [B1]),
  member(7, "usr-recep-2", ["RECEPTIONIST"], false, [B2, B3]),
  member(8, "usr-acct-1", ["ACCOUNTANT"], true, []),
];

export const invitations: InvitationResponse[] = [
  {
    id: fid("0c", 1),
    email: "ritu.kapoor@example.com",
    roles: ["RECEPTIONIST"],
    orgWide: false,
    branchScope: [B3],
    status: "PENDING",
    expiresAt: daysAgo(-5),
    invitedBy: "usr-owner-1",
    createdAt: daysAgo(2),
  },
  {
    id: fid("0c", 2),
    email: "dr.farhan.ali@example.com",
    roles: ["DENTIST"],
    orgWide: false,
    branchScope: [B2],
    status: "EXPIRED",
    expiresAt: daysAgo(3),
    invitedBy: "usr-owner-1",
    createdAt: daysAgo(10),
  },
  {
    id: fid("0c", 3),
    email: "accounts.temp@example.com",
    roles: ["ACCOUNTANT"],
    orgWide: true,
    branchScope: [],
    status: "REVOKED",
    expiresAt: daysAgo(20),
    invitedBy: "usr-owner-1",
    createdAt: daysAgo(27),
  },
];

export const assignments: DentistAssignmentResponse[] = [
  {
    id: fid("0d", 1),
    userId: "usr-owner-1",
    branchId: B1,
    effectiveFrom: dateDaysAgo(118),
    effectiveTo: null,
    createdBy: "usr-owner-1",
    createdAt: daysAgo(118),
  },
  {
    id: fid("0d", 2),
    userId: "usr-dent-1",
    branchId: B2,
    effectiveFrom: dateDaysAgo(100),
    effectiveTo: dateDaysAgo(40),
    createdBy: "usr-owner-1",
    createdAt: daysAgo(100),
  },
  {
    id: fid("0d", 3),
    userId: "usr-dent-1",
    branchId: B1,
    effectiveFrom: dateDaysAgo(40),
    effectiveTo: null,
    createdBy: "usr-owner-1",
    createdAt: daysAgo(41),
  },
  {
    id: fid("0d", 4),
    userId: "usr-dent-2",
    branchId: B2,
    effectiveFrom: dateDaysAgo(90),
    effectiveTo: null,
    createdBy: "usr-owner-1",
    createdAt: daysAgo(90),
  },
  {
    id: fid("0d", 5),
    userId: "usr-dent-3",
    branchId: B3,
    effectiveFrom: dateDaysAgo(60),
    effectiveTo: null,
    createdBy: "usr-owner-1",
    createdAt: daysAgo(60),
  },
];

export const categories: ServiceCategoryResponse[] = [
  "Diagnostics",
  "Preventive",
  "Restorative",
  "Endodontics",
  "Prosthodontics",
  "Oral surgery",
  "Cosmetic",
  "Orthodontics",
].map((name, i) => ({ id: fid("0e", i + 1), name, sortOrder: (i + 1) * 10, active: i !== 7 }));

const cat = (name: string) => categories.find((c) => c.name === name)?.id ?? null;

const svc = (
  n: number,
  code: string,
  name: string,
  category: string,
  durationMin: number,
  rupees: number,
  taxable = false,
  active = true,
): ServiceResponse => ({
  id: fid("05", n),
  code,
  name,
  description: null,
  categoryId: cat(category),
  durationMin,
  basePricePaise: rupees * 100,
  taxable,
  active,
});

export const services: ServiceResponse[] = [
  svc(1, "CONS", "Consultation", "Diagnostics", 15, 500),
  svc(2, "IOPA", "IOPA X-ray (per film)", "Diagnostics", 10, 300),
  svc(3, "OPG", "OPG full-mouth X-ray", "Diagnostics", 15, 900),
  svc(4, "SCAL", "Scaling and polishing", "Preventive", 40, 1800),
  svc(5, "FLUOR", "Fluoride application", "Preventive", 20, 1200),
  svc(6, "COMP-1", "Composite filling (one surface)", "Restorative", 30, 1500),
  svc(7, "GIC", "GIC filling", "Restorative", 30, 1000),
  svc(8, "RCT-ANT", "Root canal treatment — anterior", "Endodontics", 60, 5500),
  svc(9, "RCT-MOL", "Root canal treatment — molar", "Endodontics", 90, 8500),
  svc(10, "CRN-PFM", "Crown — porcelain fused to metal", "Prosthodontics", 45, 6500),
  svc(11, "CRN-ZIR", "Crown — zirconia", "Prosthodontics", 45, 14_000),
  svc(12, "DENT-CD", "Complete denture (per arch)", "Prosthodontics", 60, 18_000),
  svc(13, "EXT-S", "Extraction — simple", "Oral surgery", 30, 1200),
  svc(14, "EXT-SURG", "Surgical extraction (impacted tooth)", "Oral surgery", 60, 6000),
  svc(15, "IMPL", "Dental implant (fixture)", "Oral surgery", 90, 35_000),
  svc(16, "WHITEN", "In-office teeth whitening", "Cosmetic", 75, 12_000, true),
  svc(17, "ALIGN-C", "Clear aligner consultation", "Orthodontics", 30, 1000, false, false),
];

export const overrides: PriceOverrideResponse[] = [
  {
    id: fid("06", 1),
    serviceId: fid("05", 4),
    branchId: B2,
    pricePaise: 1_500_00,
    reason: "Launch offer for new branch",
    setBy: "usr-owner-1",
    effectiveFrom: daysAgo(80),
    effectiveTo: daysAgo(30),
  },
  {
    id: fid("06", 2),
    serviceId: fid("05", 4),
    branchId: B2,
    pricePaise: 2_000_00,
    reason: "Aligned with local market rates",
    setBy: "usr-owner-1",
    effectiveFrom: daysAgo(30),
    effectiveTo: null,
  },
  {
    id: fid("06", 3),
    serviceId: fid("05", 11),
    branchId: B2,
    pricePaise: 15_500_00,
    reason: "Higher lab cost at Gurugram partner lab",
    setBy: "usr-owner-1",
    effectiveFrom: daysAgo(55),
    effectiveTo: null,
  },
  {
    id: fid("06", 4),
    serviceId: fid("05", 1),
    branchId: B3,
    pricePaise: 400_00,
    reason: "Community pricing agreed for Noida",
    setBy: "dev-user",
    effectiveFrom: daysAgo(12),
    effectiveTo: null,
  },
];

// ---- Patients -------------------------------------------------------------------------------

const FIRST = [
  "Aarav",
  "Ishita",
  "Rohan",
  "Meera",
  "Kabir",
  "Ananya",
  "Vihaan",
  "Diya",
  "Aditya",
  "Saanvi",
  "Arnav",
  "Kiara",
  "Reyansh",
  "Myra",
  "Dhruv",
  "Aditi",
  "Siddharth",
  "Tara",
];
const LAST = [
  "Mehta",
  "Kapoor",
  "Gupta",
  "Nair",
  "Singh",
  "Rao",
  "Chopra",
  "Bansal",
  "Menon",
  "Saxena",
  "Pillai",
  "Arora",
];
const LIFECYCLE: PatientResponse["lifecycleStage"][] = [
  "REGISTERED",
  "ACTIVE",
  "ACTIVE",
  "IN_TREATMENT",
  "FOLLOW_UP",
  "RECALL",
  "INACTIVE",
];
const INTAKE: PatientResponse["intakeType"][] = ["APPOINTMENT", "APPOINTMENT", "WALK_IN", "URGENT"];

const patient = (
  n: number,
  first: string,
  last: string | null,
  o: Partial<PatientResponse> = {},
): PatientResponse => {
  const sex = (n % 2 === 0 ? "MALE" : "FEMALE") as PatientResponse["sex"];
  const year = 1950 + ((n * 7) % 60);
  return {
    id: fid("01", n),
    mrn: `SA-${(1000 + n).toString()}`,
    firstName: first,
    middleName: null,
    lastName: last,
    preferredName: null,
    dob: `${year}-${String((n % 12) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}`,
    sex,
    phone: `+919000${(10000 + n * 37).toString().padStart(6, "0")}`,
    altPhone: null,
    email: n % 3 === 0 ? `${first.toLowerCase()}.${(last ?? "x").toLowerCase()}@example.com` : null,
    addressLine1: n % 4 === 0 ? `House ${n}, Block C` : null,
    addressLine2: null,
    city: [null, "New Delhi", "Gurugram", "Noida"][n % 4] ?? null,
    state: [null, "Delhi", "Haryana", "Uttar Pradesh"][n % 4] ?? null,
    postalCode: null,
    country: "IN",
    originBranchId: [B1, B2, B3][n % 3] ?? B1,
    lifecycleStage: LIFECYCLE[n % LIFECYCLE.length] ?? "ACTIVE",
    intakeType: INTAKE[n % INTAKE.length] ?? "APPOINTMENT",
    mergedIntoId: null,
    identityVerifiedAt: n % 3 === 0 ? daysAgo(n) : null,
    identityVerificationMethod: n % 3 === 0 ? "IN_PERSON_DOCUMENT" : null,
    createdAt: daysAgo(100 - n),
    updatedAt: daysAgo(Math.max(1, 40 - n)),
    ...o,
  };
};

const generated: PatientResponse[] = Array.from({ length: 34 }, (_, i) => {
  const n = i + 1;
  return patient(n, FIRST[i % FIRST.length] ?? "Aarav", LAST[(i * 5) % LAST.length] ?? null);
});

/** Duplicate pairs + one merged record, used by the duplicates queue and merged-banner flows. */
export const patients: PatientResponse[] = [
  ...generated,
  patient(41, "Rahul", "Sharma", {
    phone: "+919000077001",
    dob: "1988-04-12",
    originBranchId: B1,
    lifecycleStage: "IN_TREATMENT",
    email: "rahul.sharma@example.com",
  }),
  patient(42, "Rahul", "Sharma", {
    phone: "+919000077001",
    dob: null,
    originBranchId: B2,
    lifecycleStage: "REGISTERED",
    intakeType: "WALK_IN",
    email: null,
    city: "Gurugram",
  }),
  patient(43, "Priya", "Nair", {
    dob: "1992-09-03",
    phone: "+919000077002",
    originBranchId: B3,
    lifecycleStage: "ACTIVE",
  }),
  patient(44, "Priyaa", "Nair", {
    dob: "1992-09-03",
    phone: "+919000077102",
    originBranchId: B1,
    lifecycleStage: "REGISTERED",
    intakeType: "URGENT",
  }),
  patient(45, "Sunil", "Verma", {
    phone: "+919000077003",
    originBranchId: B2,
    lifecycleStage: "INACTIVE",
    mergedIntoId: fid("01", 46),
  }),
  patient(46, "Sunil", "Verma", {
    phone: "+919000077003",
    originBranchId: B2,
    lifecycleStage: "ACTIVE",
  }),
];

export const medicalHistory: MedicalHistoryResponse[] = [
  {
    id: fid("07", 1),
    patientId: fid("01", 41),
    version: 1,
    medical: { diabetes: false, hypertension: false, pregnant: false, bleedingDisorder: false },
    dental: { lastVisit: "Over 2 years ago", sensitivity: true },
    medications: [],
    notes: "No significant history at registration.",
    recordedBy: "usr-recep-1",
    recordedAt: daysAgo(60),
  },
  {
    id: fid("07", 2),
    patientId: fid("01", 41),
    version: 2,
    medical: { diabetes: true, hypertension: false, pregnant: false, bleedingDisorder: false },
    dental: { lastVisit: "Within 6 months", sensitivity: true, bruxism: true },
    medications: [{ name: "Metformin", dose: "500 mg", frequency: "Twice daily" }],
    notes: "Diagnosed type 2 diabetes since last visit. HbA1c reported 7.1.",
    recordedBy: "usr-dent-1",
    recordedAt: daysAgo(12),
  },
  {
    id: fid("07", 3),
    patientId: fid("01", 3),
    version: 1,
    medical: { diabetes: false, hypertension: true, pregnant: false, bleedingDisorder: false },
    dental: { lastVisit: "Within a year" },
    medications: [{ name: "Amlodipine", dose: "5 mg", frequency: "Once daily" }],
    notes: null,
    recordedBy: "usr-recep-1",
    recordedAt: daysAgo(30),
  },
];

export const allergies: (AllergyResponse & { patientId: string })[] = [
  {
    id: fid("08", 1),
    patientId: fid("01", 41),
    substance: "Penicillin",
    reaction: "Hives and facial swelling",
    severity: "HIGH",
    active: true,
    notedBy: "usr-dent-1",
    notedAt: daysAgo(60),
    resolvedAt: null,
  },
  {
    id: fid("08", 2),
    patientId: fid("01", 41),
    substance: "Latex",
    reaction: "Mild skin irritation",
    severity: "LOW",
    active: false,
    notedBy: "usr-recep-1",
    notedAt: daysAgo(58),
    resolvedAt: daysAgo(20),
  },
  {
    id: fid("08", 3),
    patientId: fid("01", 3),
    substance: "Lignocaine with adrenaline",
    reaction: "Palpitations",
    severity: "MODERATE",
    active: true,
    notedBy: "usr-dent-2",
    notedAt: daysAgo(30),
    resolvedAt: null,
  },
];

export const alerts: (AlertResponse & { patientId: string })[] = [
  {
    id: fid("09", 1),
    patientId: fid("01", 41),
    title: "Diabetic — check sugar before surgical procedures",
    details: "Type 2, on metformin.",
    severity: "MODERATE",
    active: true,
    createdBy: "usr-dent-1",
    createdAt: daysAgo(12),
    resolvedAt: null,
  },
  {
    id: fid("09", 2),
    patientId: fid("01", 6),
    title: "On anticoagulants (warfarin)",
    details: "Obtain INR within 24 h before extraction.",
    severity: "CRITICAL",
    active: true,
    createdBy: "usr-dent-1",
    createdAt: daysAgo(15),
    resolvedAt: null,
  },
];

export const consents: (ConsentResponse & { patientId: string })[] = [
  {
    id: fid("10", 1),
    patientId: fid("01", 41),
    type: "DATA_PROCESSING",
    version: "2026-01",
    status: "GRANTED",
    method: "DIGITAL",
    documentId: null,
    capturedBy: "usr-recep-1",
    grantedAt: daysAgo(60),
    withdrawnAt: null,
  },
  {
    id: fid("10", 2),
    patientId: fid("01", 41),
    type: "CLINICAL_PHOTOGRAPHY",
    version: "2026-01",
    status: "WITHDRAWN",
    method: "PAPER",
    documentId: null,
    capturedBy: "usr-recep-1",
    grantedAt: daysAgo(60),
    withdrawnAt: daysAgo(5),
  },
];

export const commPrefs: Record<string, CommunicationPreference[]> = {
  [fid("01", 41)]: [
    { channel: "WHATSAPP", purpose: "REMINDER", optIn: true },
    { channel: "SMS", purpose: "TRANSACTIONAL", optIn: true },
    { channel: "EMAIL", purpose: "MARKETING", optIn: false },
  ],
};

export const enquiries: EnquiryResponse[] = [
  ["Nikhil Ahuja", "PHONE", "Braces for teenager", "NEW", B1],
  ["Farah Khan", "WHATSAPP", "Teeth whitening", "CONTACTED", B2],
  ["Gaurav Sethi", "WEBSITE", "Dental implants", "NEW", B2],
  ["Lata Krishnan", "REFERRAL", "Dentures for parent", "CONTACTED", B3],
  ["Mohit Tandon", "SOCIAL", "Clear aligners", "LOST", B1],
  ["Ritika Das", "WALK_IN", "Tooth pain, wants same-day slot", "NEW", B1],
  ["Yusuf Mirza", "CAMPAIGN", "Free check-up camp follow-up", "NEW", B3],
].map(([name, source, area, status, branchId], i) => ({
  id: fid("11", i + 1),
  branchId: branchId as string,
  name: name as string,
  phone: `+919000${(55000 + i * 11).toString().padStart(6, "0")}`,
  email: i % 2 === 0 ? null : `${(name as string).split(" ")[0]?.toLowerCase()}@example.com`,
  source: source as EnquiryResponse["source"],
  areaOfInterest: area as string,
  notes: null,
  status: status as EnquiryResponse["status"],
  convertedPatientId: null,
  createdAt: daysAgo(i * 2 + 1),
}));

const summary = (p: PatientResponse) => ({
  id: p.id,
  mrn: p.mrn,
  firstName: p.firstName,
  lastName: p.lastName,
  preferredName: p.preferredName,
  dob: p.dob,
  sex: p.sex,
  phone: p.phone,
  originBranchId: p.originBranchId,
  lifecycleStage: p.lifecycleStage,
  mergedIntoId: p.mergedIntoId,
});
export { summary as toPatientSummary };

const byId = (n: number) => patients.find((p) => p.id === fid("01", n)) as PatientResponse;

export const duplicateCandidates: DuplicateCandidateResponse[] = [
  {
    id: fid("12", 1),
    patientA: summary(byId(41)),
    patientB: summary(byId(42)),
    score: 92,
    reasons: ["PHONE_EXACT", "NAME_EXACT"],
    status: "PENDING",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: daysAgo(3),
  },
  {
    id: fid("12", 2),
    patientA: summary(byId(43)),
    patientB: summary(byId(44)),
    score: 74,
    reasons: ["NAME_SIMILAR", "DOB_EXACT"],
    status: "PENDING",
    reviewedBy: null,
    reviewedAt: null,
    createdAt: daysAgo(1),
  },
  {
    id: fid("12", 3),
    patientA: summary(byId(45)),
    patientB: summary(byId(46)),
    score: 88,
    reasons: ["PHONE_EXACT", "NAME_EXACT"],
    status: "MERGED",
    reviewedBy: "usr-owner-1",
    reviewedAt: daysAgo(8),
    createdAt: daysAgo(9),
  },
];

export const documents: DocumentResponse[] = [
  {
    id: fid("13", 1),
    patientId: fid("01", 41),
    branchId: B1,
    fileName: "opg-2026-10.png",
    contentType: "image/png",
    sizeBytes: 1_842_311,
    category: "XRAY",
    description: "OPG taken at consultation",
    status: "AVAILABLE",
    uploadedBy: "usr-dent-1",
    createdAt: daysAgo(40),
  },
  {
    id: fid("13", 2),
    patientId: fid("01", 41),
    branchId: B1,
    fileName: "consent-photography.pdf",
    contentType: "application/pdf",
    sizeBytes: 220_114,
    category: "CONSENT_FORM",
    description: null,
    status: "AVAILABLE",
    uploadedBy: "usr-recep-1",
    createdAt: daysAgo(60),
  },
];
