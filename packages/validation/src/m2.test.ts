import { describe, expect, test } from "bun:test";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  ALL_TEETH,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  APPOINTMENT_TRANSITION_PERMISSIONS,
  PERMANENT_TEETH,
  PLAN_ITEM_STATUSES,
  PLAN_ITEM_TRANSITIONS,
  PLAN_ITEM_TRANSITION_PERMISSIONS,
  PRIMARY_TEETH,
  type PlanItemStatus,
  type PlanSnapshot,
  RECORDABLE_CONSENT_TYPES,
  TEMPLATE_ONLY_CONSENT_TYPES,
  TREATMENT_PLAN_STATUSES,
  TREATMENT_PLAN_TRANSITIONS,
  allowedAppointmentTransitions,
  appointmentTransitionRequest,
  arch,
  areValidSurfaces,
  bookAppointmentRequest,
  canTransition,
  canTransitionAppointment,
  canTransitionPlan,
  canTransitionPlanItem,
  chartTeethRequest,
  createChairRequest,
  createDiagnosisRequest,
  createProcedureRequest,
  createWalkInRequest,
  decidePlanItemsRequest,
  dentitionOf,
  derivePlanStatus,
  diffPlanSnapshots,
  hhmmToMinutes,
  isAnterior,
  isNoShowEligible,
  isStatusEndpointTransition,
  isTerminalState,
  isValidTooth,
  listAppointmentsQuery,
  listPermanentTeeth,
  listPrimaryTeeth,
  minutesToHHMM,
  planItemInput,
  planItemTransitionPermissions,
  planItemTransitionRequest,
  planTotals,
  quadrant,
  recordConsentRequest,
  rescheduleAppointmentRequest,
  resolveClinicalSettings,
  resolveSchedulingSettings,
  setWorkingHoursRequest,
  signConsentRequest,
  tenantSettings,
  toothClass,
  toothName,
  toothRecordInput,
  updateAppointmentRequest,
  updateChairRequest,
  updateConsentTemplateRequest,
  updateDiagnosisRequest,
  updateEncounterRequest,
  updateNoteRequest,
  updatePlanItemRequest,
  updatePlanItemSessionRequest,
  updatePlanRequest,
  updateProcedureRequest,
  updateSchedulingSettingsRequest,
  updateStaffProfileRequest,
  utcToZoned,
  validSurfaces,
  zonedToUtc,
} from "./index";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

describe("FDI catalogue", () => {
  test("32 permanent + 20 primary teeth, all valid, nothing else", () => {
    expect(PERMANENT_TEETH).toHaveLength(32);
    expect(PRIMARY_TEETH).toHaveLength(20);
    expect(listPermanentTeeth()).toEqual([...PERMANENT_TEETH]);
    expect(listPrimaryTeeth().slice(0, 5)).toEqual([51, 52, 53, 54, 55]);
    const valid = new Set(ALL_TEETH);
    for (let c = -5; c <= 100; c++) expect([c, isValidTooth(c)]).toEqual([c, valid.has(c)]);
    for (const bad of [19, 56, 10, 20, 49, 50, 59, 66, 86, 90, 11.5, "11", null])
      expect(isValidTooth(bad)).toBe(false);
  });

  test("dentition, quadrant, arch, class", () => {
    expect(dentitionOf(48)).toBe("PERMANENT");
    expect(dentitionOf(51)).toBe("PRIMARY");
    expect(quadrant(36)).toBe(3);
    expect(quadrant(85)).toBe(8);
    expect([arch(16), arch(26), arch(55), arch(65)]).toEqual(Array(4).fill("MAXILLARY"));
    expect([arch(36), arch(46), arch(75), arch(85)]).toEqual(Array(4).fill("MANDIBULAR"));
    expect([toothClass(11), toothClass(13), toothClass(14), toothClass(16)]).toEqual([
      "INCISOR",
      "CANINE",
      "PREMOLAR",
      "MOLAR",
    ]);
    expect(toothClass(54)).toBe("MOLAR"); // primary teeth have no premolars
    expect(isAnterior(43)).toBe(true);
    expect(isAnterior(44)).toBe(false);
    expect(() => dentitionOf(19)).toThrow(RangeError);
    expect(toothName(36)).toBe("Lower left first molar");
    expect(toothName(55)).toBe("Primary upper right second molar");
  });

  test("surfaces: anterior uses I/F instead of O/B; maxillary P instead of L", () => {
    expect(validSurfaces(11)).toEqual(["M", "I", "D", "F", "P"]);
    expect(validSurfaces(41)).toEqual(["M", "I", "D", "F", "L"]);
    expect(validSurfaces(16)).toEqual(["M", "O", "D", "B", "P"]);
    expect(validSurfaces(36)).toEqual(["M", "O", "D", "B", "L"]);
    expect(validSurfaces(63)).toEqual(["M", "I", "D", "F", "P"]);
    for (const t of ALL_TEETH) expect(validSurfaces(t)).toHaveLength(5);
    expect(areValidSurfaces(36, ["O", "M"])).toBe(true);
    expect(areValidSurfaces(36, [])).toBe(true);
    expect(areValidSurfaces(36, ["I"])).toBe(false);
    expect(areValidSurfaces(36, ["P"])).toBe(false);
    expect(areValidSurfaces(36, ["O", "O"])).toBe(false);
    expect(areValidSurfaces(11, ["O"])).toBe(false);
    expect(areValidSurfaces(19, [])).toBe(false);
  });

  test("tooth record DTO: FDI, surfaces per tooth, whole-tooth conditions", () => {
    const ok = toothRecordInput.parse({ toothCode: 36, condition: "CARIES", surfaces: ["O", "M"] });
    expect(ok.surfaces).toEqual(["O", "M"]);
    expect(toothRecordInput.parse({ toothCode: 46, condition: "MISSING" }).surfaces).toEqual([]);
    for (const bad of [
      { toothCode: 19, condition: "CARIES" },
      { toothCode: 56, condition: "CARIES" },
      { toothCode: 36, condition: "CARIES", surfaces: ["I"] },
      { toothCode: 11, condition: "CARIES", surfaces: ["O"] },
      { toothCode: 36, condition: "CARIES", surfaces: ["O", "O"] },
      { toothCode: 36, condition: "MISSING", surfaces: ["O"] },
      { toothCode: 36, condition: "WOBBLY" },
    ])
      expect([bad, toothRecordInput.safeParse(bad).success]).toEqual([bad, false]);
    expect(chartTeethRequest.safeParse({ records: [] }).success).toBe(false);
    // Surfaces need a tooth on create; on PATCH an absent tooth means "unchanged".
    expect(
      createDiagnosisRequest.safeParse({ code: "K02", label: "x", surfaces: ["O"] }).success,
    ).toBe(false);
    expect(updateDiagnosisRequest.safeParse({ surfaces: ["O"] }).success).toBe(true);
    expect(updateDiagnosisRequest.safeParse({ toothCode: null, surfaces: ["O"] }).success).toBe(
      false,
    );
    expect(createProcedureRequest.safeParse({ toothCode: 36 }).success).toBe(false); // what was done?
    expect(createProcedureRequest.parse({ description: "Scaling" }).status).toBe("COMPLETED");
  });
});

describe("state machines", () => {
  const tables = [
    ["appointment", APPOINTMENT_TRANSITIONS, APPOINTMENT_STATUSES],
    ["plan item", PLAN_ITEM_TRANSITIONS, PLAN_ITEM_STATUSES],
    ["plan", TREATMENT_PLAN_TRANSITIONS, TREATMENT_PLAN_STATUSES],
  ] as const;

  test("every table covers exactly its enum and only targets known states", () => {
    for (const [name, table, states] of tables) {
      expect([name, Object.keys(table).sort()]).toEqual([name, [...states].sort()]);
      for (const targets of Object.values(table) as readonly string[][])
        for (const t of targets) expect(states as readonly string[]).toContain(t);
    }
  });

  test("appointment flow: BOOKED -> CONFIRMED -> CHECKED_IN -> IN_CHAIR -> COMPLETED", () => {
    const path = ["BOOKED", "CONFIRMED", "CHECKED_IN", "IN_CHAIR", "COMPLETED"] as const;
    for (let i = 1; i < path.length; i++)
      expect(canTransitionAppointment(path[i - 1] ?? "BOOKED", path[i] ?? "BOOKED")).toBe(true);
    expect(canTransitionAppointment("BOOKED", "CHECKED_IN")).toBe(true); // unconfirmed arrival
    expect(canTransitionAppointment("IN_CHAIR", "CANCELLED")).toBe(false);
    expect(canTransitionAppointment("CHECKED_IN", "NO_SHOW")).toBe(false);
    expect(canTransitionAppointment("CHECKED_IN", "RESCHEDULED")).toBe(false);
    expect(canTransitionAppointment("BOOKED", "BOOKED")).toBe(false);
    for (const s of ["COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"] as const)
      expect(isTerminalState(APPOINTMENT_TRANSITIONS, s)).toBe(true);
    expect(allowedAppointmentTransitions("IN_CHAIR")).toEqual(["COMPLETED"]);
    // Nothing goes back to an earlier state or to BOOKED.
    for (const from of APPOINTMENT_STATUSES)
      expect(canTransitionAppointment(from, "BOOKED")).toBe(false);
  });

  test("active statuses = the non-terminal ones; every status has a permission", () => {
    expect<string[]>([...ACTIVE_APPOINTMENT_STATUSES].sort()).toEqual(
      APPOINTMENT_STATUSES.filter((s) => !isTerminalState(APPOINTMENT_TRANSITIONS, s)).sort(),
    );
    for (const s of APPOINTMENT_STATUSES)
      expect(APPOINTMENT_TRANSITION_PERMISSIONS[s].length).toBeGreaterThan(0);
    for (const s of PLAN_ITEM_STATUSES)
      expect(PLAN_ITEM_TRANSITION_PERMISSIONS[s].length).toBeGreaterThan(0);
  });

  test("plan item flow: PROPOSED -> ACCEPTED/REJECTED/DEFERRED -> SCHEDULED -> IN_PROGRESS -> COMPLETED", () => {
    for (const d of ["ACCEPTED", "REJECTED", "DEFERRED"] as const)
      expect(canTransitionPlanItem("PROPOSED", d)).toBe(true);
    expect(canTransitionPlanItem("ACCEPTED", "SCHEDULED")).toBe(true);
    expect(canTransitionPlanItem("SCHEDULED", "IN_PROGRESS")).toBe(true);
    expect(canTransitionPlanItem("IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(canTransitionPlanItem("SCHEDULED", "ACCEPTED")).toBe(true); // appointment cancelled
    expect(canTransitionPlanItem("PROPOSED", "SCHEDULED")).toBe(false); // must be accepted first
    expect(canTransitionPlanItem("REJECTED", "ACCEPTED")).toBe(false); // re-propose first
    expect(canTransitionPlanItem("COMPLETED", "CANCELLED")).toBe(false);
    expect(canTransition(PLAN_ITEM_TRANSITIONS, "CANCELLED", "PROPOSED")).toBe(false);
    expect(canTransitionPlan("DRAFT", "PRESENTED")).toBe(true);
    expect(canTransitionPlan("PRESENTED", "DRAFT")).toBe(false);
  });

  test("derivePlanStatus", () => {
    expect(derivePlanStatus("DRAFT", ["ACCEPTED"])).toBe("DRAFT");
    expect(derivePlanStatus("PRESENTED", ["PROPOSED", "PROPOSED"])).toBe("PRESENTED");
    expect(derivePlanStatus("PRESENTED", ["ACCEPTED", "SCHEDULED"])).toBe("ACCEPTED");
    expect(derivePlanStatus("PRESENTED", ["ACCEPTED", "PROPOSED"])).toBe("PARTIALLY_ACCEPTED");
    expect(derivePlanStatus("PRESENTED", ["ACCEPTED", "DEFERRED"])).toBe("PARTIALLY_ACCEPTED");
    expect(derivePlanStatus("PRESENTED", ["REJECTED", "REJECTED"])).toBe("REJECTED");
    expect(derivePlanStatus("PRESENTED", ["REJECTED", "DEFERRED"])).toBe("PRESENTED");
    expect(derivePlanStatus("ACCEPTED", ["COMPLETED", "REJECTED", "CANCELLED"])).toBe("COMPLETED");
    expect(derivePlanStatus("ACCEPTED", ["CANCELLED"])).toBe("ACCEPTED");
    expect(derivePlanStatus("CANCELLED", ["ACCEPTED"])).toBe("CANCELLED");
  });
});

describe("scheduling DTOs and helpers", () => {
  test("booking defaults, walk-in defaults, transitions limited to the status endpoint", () => {
    const b = bookAppointmentRequest.parse({
      patientId: U1,
      branchId: U2,
      startsAt: "2031-03-04T10:00:00+05:30",
      durationMin: 30,
    });
    expect(b).toMatchObject({ appointmentType: "CONSULTATION", source: "SCHEDULED" });
    expect(b.dentistUserId).toBeUndefined();
    expect(
      bookAppointmentRequest.safeParse({ ...b, durationMin: 2 }).success ||
        bookAppointmentRequest.safeParse({ ...b, startsAt: "2031-03-04 10:00" }).success,
    ).toBe(false);
    expect(createWalkInRequest.parse({ patientId: U1, branchId: U2 })).toMatchObject({
      source: "WALK_IN",
      durationMin: 30,
      checkIn: true,
    });
    expect(appointmentTransitionRequest.safeParse({ to: "CANCELLED" }).success).toBe(false);
    expect(appointmentTransitionRequest.safeParse({ to: "CHECKED_IN" }).success).toBe(true);
    expect(rescheduleAppointmentRequest.safeParse({ startsAt: b.startsAt }).success).toBe(false);
  });

  test("calendar range is bounded; patient history needs no range; status list parses", () => {
    const from = "2031-03-01T00:00:00Z";
    expect(listAppointmentsQuery.safeParse({ branchId: U1 }).success).toBe(false);
    expect(listAppointmentsQuery.safeParse({ patientId: U1 }).success).toBe(true);
    expect(listAppointmentsQuery.safeParse({ from, to: "2031-04-11T00:00:00Z" }).success).toBe(
      true,
    );
    expect(listAppointmentsQuery.safeParse({ from, to: "2031-05-01T00:00:00Z" }).success).toBe(
      false,
    );
    expect(listAppointmentsQuery.safeParse({ from, to: from }).success).toBe(false);
    expect(
      listAppointmentsQuery.parse({ patientId: U1, status: "BOOKED, CHECKED_IN" }).status,
    ).toEqual(["BOOKED", "CHECKED_IN"]);
    expect(listAppointmentsQuery.safeParse({ patientId: U1, status: "NOPE" }).success).toBe(false);
  });

  test("working hours: subject per scope, no overlapping sessions", () => {
    const base = { branchId: U1, effectiveFrom: "2031-01-01" };
    const s = (weekday: number, a: string, b: string) => ({
      weekday,
      startMinute: hhmmToMinutes(a),
      endMinute: hhmmToMinutes(b),
    });
    expect(
      setWorkingHoursRequest.safeParse({
        ...base,
        scope: "DENTIST",
        userId: "dr-1",
        sessions: [s(1, "09:00", "13:00"), s(1, "17:00", "21:00"), s(2, "09:00", "13:00")],
      }).success,
    ).toBe(true);
    expect(
      setWorkingHoursRequest.safeParse({
        ...base,
        scope: "DENTIST",
        userId: "dr-1",
        sessions: [s(1, "09:00", "13:00"), s(1, "12:00", "14:00")],
      }).success,
    ).toBe(false);
    expect(
      setWorkingHoursRequest.safeParse({ ...base, scope: "DENTIST", sessions: [] }).success,
    ).toBe(false);
    expect(
      setWorkingHoursRequest.safeParse({ ...base, scope: "BRANCH", chairId: U2, sessions: [] })
        .success,
    ).toBe(false);
    expect(createChairRequest.parse({ branchId: U1, code: "op-1", name: "Op 1" }).code).toBe(
      "OP-1",
    );
  });

  test("time helpers: HH:MM, zoned conversion (incl. DST), no-show grace", () => {
    expect(minutesToHHMM(570)).toBe("09:30");
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(() => hhmmToMinutes("9:30")).toThrow();
    expect(zonedToUtc("2031-03-04", 600, "Asia/Kolkata").toISOString()).toBe(
      "2031-03-04T04:30:00.000Z",
    );
    expect(utcToZoned(new Date("2031-03-04T04:30:00Z"), "Asia/Kolkata")).toEqual({
      date: "2031-03-04",
      weekday: 2,
      minuteOfDay: 600,
    });
    // Late evening UTC is the next local day in India.
    expect(utcToZoned(new Date("2031-03-04T20:00:00Z"), "Asia/Kolkata").date).toBe("2031-03-05");
    // DST: London 09:00 is 09:00Z in winter and 08:00Z in summer.
    expect(zonedToUtc("2031-01-15", 540, "Europe/London").toISOString()).toBe(
      "2031-01-15T09:00:00.000Z",
    );
    expect(zonedToUtc("2031-07-15", 540, "Europe/London").toISOString()).toBe(
      "2031-07-15T08:00:00.000Z",
    );
    const start = new Date("2031-03-04T10:00:00Z");
    expect(isNoShowEligible(start, new Date("2031-03-04T10:14:59Z"))).toBe(false);
    expect(isNoShowEligible(start, new Date("2031-03-04T10:15:00Z"))).toBe(true);
    expect(isNoShowEligible(start, new Date("2031-03-04T10:05:00Z"), 5)).toBe(true);
  });

  test("branch scheduling knobs resolve to defaults when missing or invalid", () => {
    expect(resolveSchedulingSettings({})).toEqual({
      noShowGraceMinutes: 15,
      slotMinutes: 15,
      allowUnassignedDentist: true,
      allowOutsideHoursBooking: true,
    });
    expect(
      resolveSchedulingSettings({ scheduling: { noShowGraceMinutes: 30 } }).noShowGraceMinutes,
    ).toBe(30);
    expect(
      resolveSchedulingSettings({ scheduling: { noShowGraceMinutes: -1 } }).noShowGraceMinutes,
    ).toBe(15);
    expect(resolveSchedulingSettings(null).slotMinutes).toBe(15);
  });
});

describe("plans & consent", () => {
  test("plan items: defaults, surfaces per tooth, reasons for reject/defer/cancel", () => {
    expect(planItemInput.parse({ serviceId: U1 })).toMatchObject({
      phase: 1,
      quantity: 1,
      surfaces: [],
    });
    expect(planItemInput.safeParse({ serviceId: U1, toothCode: 46, surfaces: ["I"] }).success).toBe(
      false,
    );
    const d = (decision: string, reason?: string) =>
      decidePlanItemsRequest.safeParse({ decisions: [{ itemId: U1, decision, reason }] }).success;
    expect(d("ACCEPTED")).toBe(true);
    expect(d("REJECTED")).toBe(false);
    expect(d("DEFERRED", "after exams")).toBe(true);
    expect(
      decidePlanItemsRequest.safeParse({
        decisions: [
          { itemId: U1, decision: "ACCEPTED" },
          { itemId: U1, decision: "ACCEPTED" },
        ],
      }).success,
    ).toBe(false);
    expect(planItemTransitionRequest.safeParse({ to: "CANCELLED" }).success).toBe(false);
    // ACCEPTED is accepted by the DTO only for SCHEDULED -> ACCEPTED (appointment cancelled).
    expect(planItemTransitionRequest.safeParse({ to: "ACCEPTED" }).success).toBe(true);
    expect(planItemTransitionRequest.safeParse({ to: "REJECTED", reason: "no" }).success).toBe(
      false,
    );
    expect(planItemTransitionRequest.safeParse({ to: "COMPLETED" }).success).toBe(true);
    expect(isStatusEndpointTransition("SCHEDULED", "ACCEPTED")).toBe(true);
    expect(isStatusEndpointTransition("PROPOSED", "ACCEPTED")).toBe(false); // patient decision
    expect(isStatusEndpointTransition("DEFERRED", "ACCEPTED")).toBe(false);
    expect(isStatusEndpointTransition("ACCEPTED", "DEFERRED")).toBe(false);
    expect(isStatusEndpointTransition("ACCEPTED", "SCHEDULED")).toBe(true);
    expect(isStatusEndpointTransition("PROPOSED", "SCHEDULED")).toBe(false); // not in the table
  });

  test("SCHEDULED -> ACCEPTED needs what booking needs, not plan:approve", () => {
    expect(planItemTransitionPermissions("SCHEDULED", "ACCEPTED")).toEqual([
      "plan:write",
      "appointment:write",
    ]);
    expect(planItemTransitionPermissions("PROPOSED", "ACCEPTED")).toEqual(["plan:approve"]);
    expect(planItemTransitionPermissions("ACCEPTED", "SCHEDULED")).toEqual(
      PLAN_ITEM_TRANSITION_PERMISSIONS.SCHEDULED,
    );
    // Every DTO target is reachable through the status endpoint from some state.
    for (const to of planItemTransitionRequest.shape.to.options)
      expect([to, PLAN_ITEM_STATUSES.some((f) => isStatusEndpointTransition(f, to))]).toEqual([
        to,
        true,
      ]);
  });

  test("derivePlanStatus never implies a plan move the plan table forbids (exhaustive, <= 3 items)", () => {
    const sets: PlanItemStatus[][] = [];
    const grow = (acc: PlanItemStatus[]) => {
      if (acc.length > 0) sets.push(acc);
      if (acc.length < 3) for (const s of PLAN_ITEM_STATUSES) grow([...acc, s]);
    };
    grow([]);
    const bad: string[] = [];
    for (const items of sets) {
      // Consistent starting point: a presented plan whose status follows its items.
      const cur = derivePlanStatus("PRESENTED", items);
      if (cur === "COMPLETED") continue; // terminal: items are frozen
      items.forEach((from, i) => {
        for (const to of PLAN_ITEM_TRANSITIONS[from]) {
          const next = derivePlanStatus(
            cur,
            items.map((s, j) => (j === i ? to : s)),
          );
          if (next !== cur && !canTransitionPlan(cur, next))
            bad.push(`${cur} [${items}] item ${from}->${to} => ${next}`);
        }
      });
    }
    expect(bad).toEqual([]);
    expect(canTransitionPlan("ACCEPTED", "PRESENTED")).toBe(true); // last accepted item deferred
  });

  test("planTotals uses frozen unit price x quantity in integer paise", () => {
    const t = planTotals([
      { status: "ACCEPTED", estimatePricePaise: 150_000, quantity: 2 },
      { status: "COMPLETED", estimatePricePaise: 50_000, quantity: 1 },
      { status: "PROPOSED", estimatePricePaise: 10_000, quantity: 1 },
      { status: "REJECTED", estimatePricePaise: 99_999, quantity: 1 },
      { status: "CANCELLED", estimatePricePaise: 99_999, quantity: 1 },
    ]);
    expect(t).toEqual({
      estimatePaise: 360_000,
      acceptedPaise: 350_000,
      completedPaise: 50_000,
      pendingPaise: 10_000,
    });
  });

  test("diffPlanSnapshots reports plan fields, added/removed/changed items", () => {
    const item = (id: string, over: Partial<PlanSnapshot["items"][number]> = {}) => ({
      id,
      phase: 1,
      sequence: 1,
      serviceId: U3,
      toothCode: 36,
      surfaces: ["O"],
      quantity: 1,
      estimatePricePaise: 100_000,
      priceSource: "BASE" as const,
      status: "PROPOSED" as const,
      decisionReason: null,
      notes: null,
      ...over,
    });
    const totals = { estimatePaise: 0, acceptedPaise: 0, completedPaise: 0, pendingPaise: 0 };
    const plan = {
      id: U1,
      patientId: U2,
      branchId: U3,
      title: "Plan",
      notes: null,
      status: "PRESENTED" as const,
    };
    const a: PlanSnapshot = { plan, items: [item(U1), item(U2)], totals };
    const b: PlanSnapshot = {
      plan: { ...plan, status: "PARTIALLY_ACCEPTED" },
      items: [item(U1, { status: "ACCEPTED" }), item(U3)],
      totals,
    };
    expect(diffPlanSnapshots(a, b)).toEqual({
      planFields: ["status"],
      added: [U3],
      removed: [U2],
      changed: [{ itemId: U1, fields: ["status"] }],
    });
    expect(diffPlanSnapshots(a, a)).toEqual({
      planFields: [],
      added: [],
      removed: [],
      changed: [],
    });
  });

  test("clinical knobs: plan consent required by default; tenantSettings accepts them", () => {
    expect(resolveClinicalSettings({})).toEqual({ requirePlanConsentForApproval: true });
    expect(resolveClinicalSettings({ clinical: { requirePlanConsentForApproval: false } })).toEqual(
      { requirePlanConsentForApproval: false },
    );
    expect(resolveClinicalSettings({ clinical: { typo: 1 } })).toEqual({
      requirePlanConsentForApproval: true,
    });
    expect(
      tenantSettings.safeParse({ clinical: { requirePlanConsentForApproval: false } }).success,
    ).toBe(true);
  });

  test("template-only consent types cannot be recorded through the free-form M1 endpoint", () => {
    for (const type of TEMPLATE_ONLY_CONSENT_TYPES)
      expect(
        recordConsentRequest.safeParse({ type, version: "1", status: "GRANTED", method: "VERBAL" })
          .success,
      ).toBe(false);
    expect(RECORDABLE_CONSENT_TYPES).toContain("DATA_PROCESSING");
    expect(RECORDABLE_CONSENT_TYPES).toContain("CLINICAL_PHOTOGRAPHY");
    expect(
      recordConsentRequest.safeParse({
        type: "DATA_PROCESSING",
        version: "1",
        status: "GRANTED",
        method: "VERBAL",
      }).success,
    ).toBe(true);
  });

  test("signed consent: guardian needs a name", () => {
    const base = { templateVersionId: U1, branchId: U2, signatureDocumentId: U3 };
    expect(signConsentRequest.parse(base)).toMatchObject({
      method: "DIGITAL",
      signerRelationship: "SELF",
    });
    expect(signConsentRequest.safeParse({ ...base, signerRelationship: "GUARDIAN" }).success).toBe(
      false,
    );
    expect(
      signConsentRequest.safeParse({
        ...base,
        signerRelationship: "GUARDIAN",
        signerName: "Parent",
      }).success,
    ).toBe(true);
  });
});

test("M2 PATCH schemas never inject defaults: absent keys stay absent", () => {
  const cases: [string, { parse: (v: unknown) => unknown }, Record<string, unknown>][] = [
    ["updateChairRequest", updateChairRequest, { name: "Op 2" }],
    ["updateAppointmentRequest", updateAppointmentRequest, { notes: "x" }],
    ["updateSchedulingSettingsRequest", updateSchedulingSettingsRequest, { slotMinutes: 10 }],
    ["updateEncounterRequest", updateEncounterRequest, { treatingDentistUserId: "dr-2" }],
    ["updateNoteRequest", updateNoteRequest, { body: "edited" }],
    ["updateDiagnosisRequest", updateDiagnosisRequest, { label: "Caries" }],
    ["updateProcedureRequest", updateProcedureRequest, { status: "ABANDONED" }],
    ["updatePlanRequest", updatePlanRequest, { title: "Phase 1" }],
    ["updatePlanItemRequest", updatePlanItemRequest, { quantity: 2 }],
    ["updatePlanItemSessionRequest", updatePlanItemSessionRequest, { status: "COMPLETED" }],
    ["updateConsentTemplateRequest", updateConsentTemplateRequest, { active: false }],
    ["updateStaffProfileRequest", updateStaffProfileRequest, { displayName: "Dr A" }],
  ];
  for (const [name, schema, one] of cases) {
    expect([name, schema.parse({})]).toEqual([name, {}]);
    expect([name, schema.parse(one)]).toEqual([name, one]);
  }
  expect(updateAppointmentRequest.parse({ dentistUserId: null, chairId: null })).toEqual({
    dentistUserId: null,
    chairId: null,
  });
});
