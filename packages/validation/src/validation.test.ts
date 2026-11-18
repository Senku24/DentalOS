import { expect, test } from "bun:test";
import {
  consentResponse,
  convertEnquiryRequest,
  createBranchRequest,
  createInvitationRequest,
  createPatientRequest,
  duplicateCheckRequest,
  includeResolvedQuery,
  mergePatientsRequest,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
  requestUploadRequest,
  searchPatientsQuery,
  setPriceOverrideRequest,
  updateBranchRequest,
  updateEnquiryRequest,
  updatePatientRequest,
  updateServiceCategoryRequest,
  updateServiceRequest,
  updateTenantRequest,
  workingHours,
} from "./index";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

test("normalizePhoneIN handles common Indian formats", () => {
  for (const v of [
    "98765 43210",
    "098765-43210",
    "+91 98765 43210",
    "919876543210",
    "0091 9876543210",
  ])
    expect(normalizePhoneIN(v)).toBe("+919876543210");
  expect(normalizePhoneIN("+44 20 7946 0958")).toBe("+442079460958");
  expect(normalizePhoneIN("12345")).toBeNull();
  expect(normalizePhoneIN("+91 12345")).toBeNull();
  expect(normalizePhoneIN("")).toBeNull();
});

test("normalizeName strips diacritics, punctuation and case", () => {
  expect(normalizeName("  Dr. Ánanya ", undefined, "O'Neil")).toBe("dr ananya oneil");
  expect(normalizeName("RAVI", "kumar")).toBe("ravi kumar");
  expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
});

test("createPatientRequest normalises phone + email and defaults", () => {
  const r = createPatientRequest.parse({
    originBranchId: U1,
    intakeType: "WALK_IN",
    firstName: " Asha ",
    phone: "98765 43210",
    email: "ASHA@Example.com",
  });
  expect(r.firstName).toBe("Asha");
  expect(r.phone).toBe("+919876543210");
  expect(r.email).toBe("asha@example.com");
  expect(r.sex).toBe("UNKNOWN");
  expect(r.country).toBe("IN");
  expect(
    createPatientRequest.safeParse({ originBranchId: U1, intakeType: "X", firstName: "a" }).success,
  ).toBe(false);
  expect(
    createPatientRequest.safeParse({
      originBranchId: U1,
      intakeType: "URGENT",
      firstName: "a",
      dob: "2999-01-01",
    }).success,
  ).toBe(false);
});

test("invitation requires branch scope unless orgWide", () => {
  expect(createInvitationRequest.safeParse({ email: "x@y.in", roles: ["DENTIST"] }).success).toBe(
    false,
  );
  expect(
    createInvitationRequest.safeParse({ email: "x@y.in", roles: ["DENTIST"], branchScope: [U1] })
      .success,
  ).toBe(true);
  expect(
    createInvitationRequest.safeParse({ email: "x@y.in", roles: ["PATIENT"], orgWide: true })
      .success,
  ).toBe(false);
});

test("branch code upper-cased; working hours reject overlaps", () => {
  expect(createBranchRequest.parse({ code: "blr-01", name: "Indiranagar" }).code).toBe("BLR-01");
  expect(
    workingHours.safeParse({
      mon: [
        { open: "09:00", close: "13:00" },
        { open: "14:00", close: "19:00" },
      ],
    }).success,
  ).toBe(true);
  expect(
    workingHours.safeParse({
      mon: [
        { open: "09:00", close: "13:00" },
        { open: "12:00", close: "19:00" },
      ],
    }).success,
  ).toBe(false);
  expect(
    createBranchRequest.safeParse({ code: "X1", name: "n", timezone: "Mars/Base" }).success,
  ).toBe(false);
});

test("money is integer paise; override needs a reason", () => {
  expect(
    setPriceOverrideRequest.safeParse({ branchId: U1, pricePaise: 1999.5, reason: "promo" })
      .success,
  ).toBe(false);
  expect(
    setPriceOverrideRequest.safeParse({ branchId: U1, pricePaise: 199900, reason: "" }).success,
  ).toBe(false);
  expect(
    setPriceOverrideRequest.safeParse({ branchId: U1, pricePaise: 199900, reason: "local market" })
      .success,
  ).toBe(true);
});

test("merge rejects self-merge; upload enforces allow-list and size", () => {
  expect(
    mergePatientsRequest.safeParse({ survivorId: U1, mergedId: U1, reason: "same person" }).success,
  ).toBe(false);
  expect(
    mergePatientsRequest.safeParse({ survivorId: U1, mergedId: U2, reason: "same person" }).success,
  ).toBe(true);
  const up = {
    patientId: U1,
    branchId: U2,
    fileName: "xray.png",
    contentType: "image/png",
    sizeBytes: 1000,
  };
  expect(requestUploadRequest.safeParse(up).success).toBe(true);
  expect(requestUploadRequest.safeParse({ ...up, contentType: "text/html" }).success).toBe(false);
  expect(requestUploadRequest.safeParse({ ...up, sizeBytes: 26 * 1024 * 1024 }).success).toBe(
    false,
  );
  expect(requestUploadRequest.safeParse({ ...up, fileName: "../etc/passwd" }).success).toBe(false);
});

test("PATCH schemas never inject defaults: absent keys stay absent", () => {
  const cases: [string, { parse: (v: unknown) => unknown }, Record<string, unknown>][] = [
    ["updatePatientRequest", updatePatientRequest, { city: "Pune" }],
    ["updateBranchRequest", updateBranchRequest, { name: "Koramangala" }],
    ["updateServiceRequest", updateServiceRequest, { name: "Scaling" }],
    ["updateServiceCategoryRequest", updateServiceCategoryRequest, { name: "Hygiene" }],
    ["updateTenantRequest", updateTenantRequest, { name: "Smile Co" }],
    ["updateEnquiryRequest", updateEnquiryRequest, { notes: "call back" }],
  ];
  for (const [name, schema, one] of cases) {
    expect([name, schema.parse({})]).toEqual([name, {}]);
    expect([name, schema.parse(one)]).toEqual([name, one]);
  }
  // Defaulted fields can still be set explicitly.
  expect(updatePatientRequest.parse({ sex: "FEMALE", country: "GB" })).toEqual({
    sex: "FEMALE",
    country: "GB",
  });
  expect(updateBranchRequest.parse({ timezone: "Asia/Dubai" })).toEqual({
    timezone: "Asia/Dubai",
  });
  expect(updateServiceRequest.parse({ taxable: true, categoryId: null })).toEqual({
    taxable: true,
    categoryId: null,
  });
  expect(updateServiceCategoryRequest.parse({ sortOrder: 3 })).toEqual({ sortOrder: 3 });
  // Create schemas keep their defaults.
  expect(createBranchRequest.parse({ code: "x1", name: "n" })).toMatchObject({
    timezone: "Asia/Kolkata",
    workingHours: {},
    country: "IN",
  });
});

test("promoted patient DTOs: search filters, failOnMatch, merge choices, convert, includeResolved", () => {
  expect(searchPatientsQuery.parse({ intakeType: "WALK_IN", email: "A@B.in" })).toMatchObject({
    intakeType: "WALK_IN",
    email: "a@b.in",
  });
  expect(duplicateCheckRequest.parse({ firstName: "a", failOnMatch: true }).failOnMatch).toBe(true);
  expect(duplicateCheckRequest.parse({ firstName: "a" }).failOnMatch).toBeUndefined();
  const m = { survivorId: U1, mergedId: U2, reason: "same person" };
  expect(mergePatientsRequest.parse(m).fieldChoices).toBeUndefined();
  expect(
    mergePatientsRequest.parse({ ...m, fieldChoices: { email: "merged" } }).fieldChoices,
  ).toEqual({ email: "merged" });
  expect(mergePatientsRequest.safeParse({ ...m, fieldChoices: { mrn: "merged" } }).success).toBe(
    false,
  );
  expect(convertEnquiryRequest.parse({ existingPatientId: U1 })).toEqual({ existingPatientId: U1 });
  expect(convertEnquiryRequest.parse({ originBranchId: U1, firstName: "Asha" })).toMatchObject({
    intakeType: "ENQUIRY",
    sex: "UNKNOWN",
  });
  expect(includeResolvedQuery.parse({})).toEqual({ includeResolved: false });
  expect(includeResolvedQuery.parse({ includeResolved: "true" })).toEqual({
    includeResolved: true,
  });
  const c = {
    id: U1,
    type: "DATA_PROCESSING",
    version: "1",
    status: "GRANTED",
    method: null,
    documentId: null,
    capturedBy: "u",
    grantedAt: null,
    withdrawnAt: null,
  };
  expect(consentResponse.safeParse(c).success).toBe(true);
  expect(consentResponse.safeParse({ ...c, branchId: U2 }).success).toBe(true);
});
