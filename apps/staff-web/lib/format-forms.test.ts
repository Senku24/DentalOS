import { describe, expect, test } from "bun:test";
import {
  createBranchRequest,
  createInvitationRequest,
  createPatientRequest,
  setPriceOverrideRequest,
} from "@dentalos/validation";
import { ageFrom, formatPaise, formatPhone, humanize } from "./format";
import {
  changedFields,
  cleanEmpty,
  fieldErrorsFrom,
  paiseToRupeeInput,
  rupeesToPaise,
  validate,
} from "./forms";

describe("money", () => {
  test("formatPaise uses ₹ and Indian digit grouping, hides zero paise", () => {
    expect(formatPaise(150_000)).toBe("₹1,500");
    expect(formatPaise(125_050)).toBe("₹1,250.50");
    expect(formatPaise(15_000_000)).toBe("₹1,50,000");
    expect(formatPaise(5)).toBe("₹0.05");
    expect(formatPaise(0)).toBe("₹0");
    expect(formatPaise(null)).toBe("—");
    expect(formatPaise(Number.NaN)).toBe("—");
  });

  test("rupeesToPaise parses exactly (no float drift) and rejects junk", () => {
    expect(rupeesToPaise("1500")).toBe(150_000);
    expect(rupeesToPaise("1,250.5")).toBe(125_050);
    expect(rupeesToPaise("₹ 0.29")).toBe(29);
    expect(rupeesToPaise("19.99")).toBe(1999); // 19.99 * 100 = 1998.9999… in floats
    expect(rupeesToPaise("1.234")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("")).toBeNull();
  });

  test("paise ↔ rupee input round-trips", () => {
    for (const p of [0, 5, 99, 100, 125_050, 1_500_000]) {
      expect(rupeesToPaise(paiseToRupeeInput(p))).toBe(p);
    }
  });
});

describe("display formatting", () => {
  test("ageFrom counts whole years and respects the birthday", () => {
    const on = new Date(2026, 10, 19);
    expect(ageFrom("1990-11-19", on)).toBe(36);
    expect(ageFrom("1990-11-20", on)).toBe(35);
    expect(ageFrom(null, on)).toBeNull();
    expect(ageFrom("2030-01-01", on)).toBeNull();
  });
  test("formatPhone groups Indian mobiles", () => {
    expect(formatPhone("+919000010037")).toBe("+91 90000 10037");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
    expect(formatPhone(null)).toBe("—");
  });
  test("humanize", () => {
    expect(humanize("IN_TREATMENT")).toBe("In treatment");
    expect(humanize(null)).toBe("—");
  });
});

describe("form validation wiring (shared zod schemas)", () => {
  test("cleanEmpty drops blank strings recursively but keeps false/0/arrays", () => {
    expect(
      cleanEmpty({ a: "", b: "  ", c: "x", d: false, e: 0, f: { g: "" }, h: ["", "y"] }),
    ).toEqual({
      c: "x",
      d: false,
      e: 0,
      f: {},
      h: [undefined, "y"],
    });
  });

  test("valid branch input parses to the API body (code upper-cased, defaults applied)", () => {
    const r = validate(createBranchRequest, {
      code: "skt-2",
      name: "Saket 2",
      phone: "98765 43210",
      email: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.code).toBe("SKT-2");
      expect(r.data.phone).toBe("+919876543210");
      expect(r.data.email).toBeUndefined();
      expect(r.data.timezone).toBe("Asia/Kolkata");
      expect(r.data.country).toBe("IN");
    }
  });

  test("missing required fields read as 'Required'", () => {
    const r = validate(createBranchRequest, { code: "", name: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBe("Required");
      expect(r.errors.code).toBeTruthy();
    }
  });

  test("cross-field rules surface on the right field", () => {
    const inv = validate(createInvitationRequest, {
      email: "a@example.com",
      roles: ["DENTIST"],
      orgWide: false,
    });
    expect(inv.ok).toBe(false);
    if (!inv.ok) expect(inv.errors.branchScope).toBe("Branch scope required unless orgWide");

    const noRole = validate(createInvitationRequest, {
      email: "a@example.com",
      roles: [],
      orgWide: true,
    });
    expect(!noRole.ok && noRole.errors.roles).toBe("Select at least one");
  });

  test("price override needs a reason; working-hours overlap is caught", () => {
    const r = validate(setPriceOverrideRequest, {
      branchId: "0b000000-0000-4000-8000-000000000001",
      pricePaise: 150_000,
      reason: "",
    });
    expect(!r.ok && r.errors.reason).toBe("Required");

    const wh = validate(createBranchRequest, {
      code: "AB",
      name: "A",
      workingHours: {
        mon: [
          { open: "09:00", close: "13:00" },
          { open: "12:00", close: "15:00" },
        ],
      },
    });
    expect(!wh.ok && wh.errors.workingHours).toBe("Sessions overlap");
  });

  test("patient phone is normalised and invalid phone reported", () => {
    const base = {
      firstName: "Asha",
      originBranchId: "0b000000-0000-4000-8000-000000000001",
      intakeType: "WALK_IN",
    };
    const good = validate(createPatientRequest, { ...base, phone: "098765-43210" });
    expect(good.ok && good.data.phone).toBe("+919876543210");
    const bad = validate(createPatientRequest, { ...base, phone: "12" });
    expect(!bad.ok && bad.errors.phone).toBe("Invalid phone number");
  });

  test("fieldErrorsFrom maps root issues to _form", () => {
    expect(
      fieldErrorsFrom([
        { code: "custom", path: [], message: "Whole form bad", input: undefined } as never,
      ]),
    ).toEqual({ _form: "Whole form bad" });
  });
});

describe("PATCH bodies", () => {
  test("changedFields sends only modified keys (null == undefined, objects by value)", () => {
    const current = {
      name: "Saket",
      phone: null,
      city: "New Delhi",
      workingHours: { mon: [{ open: "09:00", close: "13:00" }] },
    };
    expect(
      changedFields(
        {
          name: "Saket",
          phone: undefined,
          city: "Delhi",
          workingHours: { mon: [{ open: "09:00", close: "13:00" }] },
          timezone: "Asia/Kolkata",
        },
        current,
      ),
    ).toEqual({ city: "Delhi", timezone: "Asia/Kolkata" });
    expect(changedFields({ name: "Saket" }, current)).toEqual({});
  });
});
