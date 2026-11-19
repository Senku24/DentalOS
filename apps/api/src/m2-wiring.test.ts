import { afterAll, expect, test } from "bun:test";
import { ALL_PERMISSIONS } from "@dentalos/contracts";
import { $Enums, PrismaClient } from "@dentalos/db";
import * as v from "@dentalos/validation";
import { ClinicalModule } from "./clinical/clinical.module";
import {
  CLINICAL_GUARD_CODES,
  clinicalGuardError,
  notAMember,
  slotConflict,
} from "./common/db-errors";
import { PlansModule } from "./plans/plans.module";
import { SchedulingModule } from "./scheduling/scheduling.module";

// Module DI resolution for the M2 stubs is covered by m1-wiring.test.ts (same AppModule boot).
const prisma = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.DATABASE_URL ??
        "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos",
    },
  },
});
afterAll(() => prisma.$disconnect());

test("M2 modules are registered in AppModule", async () => {
  const { AppModule } = await import("./app.module");
  const imports: unknown[] = Reflect.getMetadata("imports", AppModule) ?? [];
  for (const m of [SchedulingModule, ClinicalModule, PlansModule]) expect(imports).toContain(m);
});

test("M2 @dentalos/validation enum lists match the Prisma schema", () => {
  const pairs: [string, readonly string[], Record<string, string>][] = [
    ["WorkingHoursScope", v.WORKING_HOURS_SCOPES, $Enums.WorkingHoursScope],
    ["AppointmentStatus", v.APPOINTMENT_STATUSES, $Enums.AppointmentStatus],
    ["AppointmentSource", v.APPOINTMENT_SOURCES, $Enums.AppointmentSource],
    ["EncounterStatus", v.ENCOUNTER_STATUSES, $Enums.EncounterStatus],
    ["ClinicalNoteKind", v.CLINICAL_NOTE_KINDS, $Enums.ClinicalNoteKind],
    ["Dentition", v.DENTITIONS, $Enums.Dentition],
    ["ToothRecordStatus", v.TOOTH_RECORD_STATUSES, $Enums.ToothRecordStatus],
    ["ProcedureStatus", v.PROCEDURE_STATUSES, $Enums.ProcedureStatus],
    ["TreatmentPlanStatus", v.TREATMENT_PLAN_STATUSES, $Enums.TreatmentPlanStatus],
    ["PlanItemStatus", v.PLAN_ITEM_STATUSES, $Enums.PlanItemStatus],
    ["PlanItemSessionStatus", v.PLAN_ITEM_SESSION_STATUSES, $Enums.PlanItemSessionStatus],
    ["ConsentTemplateType", v.CONSENT_TEMPLATE_TYPES, $Enums.ConsentTemplateType],
  ];
  for (const [name, mine, db] of pairs)
    expect(`${name}: ${[...mine].sort()}`).toBe(`${name}: ${Object.values(db).sort()}`);
  // Template types are signable consent types (PatientConsent.type is text, validated by CONSENT_TYPES).
  for (const t of v.CONSENT_TEMPLATE_TYPES)
    expect(v.CONSENT_TYPES as readonly string[]).toContain(t);
});

test("transition permission tables only name real permissions", () => {
  const perms = new Set<string>(ALL_PERMISSIONS);
  for (const list of [
    ...Object.values(v.APPOINTMENT_TRANSITION_PERMISSIONS),
    ...Object.values(v.PLAN_ITEM_TRANSITION_PERMISSIONS),
  ])
    for (const p of list) expect(perms.has(p) ? p : `unknown: ${p}`).toBe(p);
});

test("ACTIVE_APPOINTMENT_STATUSES equals the exclusion constraints' status list", async () => {
  const rows = await prisma.$queryRaw<{ name: string; def: string }[]>`
    SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname IN ('Appointment_dentist_no_overlap', 'Appointment_chair_no_overlap')`;
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    const listed = [...r.def.matchAll(/'([A-Z_]+)'::"AppointmentStatus"/g)].map((m) => m[1]);
    expect([r.name, listed.sort()]).toEqual([r.name, [...v.ACTIVE_APPOINTMENT_STATUSES].sort()]);
  }
});

test("db-errors maps Prisma's exclusion / trigger error shapes", () => {
  // Shapes captured from Prisma 6 against migration 0006.
  const excl = {
    message:
      'Invalid `prisma.appointment.create()` invocation: ... QueryError(PostgresError { code: "23P01", message: "conflicting key value violates exclusion constraint \\"Appointment_chair_no_overlap\\"" })',
  };
  const trig = {
    message:
      'QueryError(PostgresError { code: "P0001", message: "encounter_signed: ClinicalNote of signed encounter 6965 is immutable" })',
  };
  const raw = {
    code: "P2010",
    meta: {
      code: "P0001",
      message: "ERROR: tooth_record_immutable: tooth record x can only be superseded",
    },
    message: "Raw query failed.",
  };
  expect(slotConflict(excl)).toBe("chair");
  expect(slotConflict({ message: excl.message.replace("chair", "dentist") })).toBe("dentist");
  expect(slotConflict(trig)).toBeNull();
  expect(clinicalGuardError(trig)).toBe("encounter_signed");
  expect(clinicalGuardError(raw)).toBe("tooth_record_immutable");
  expect(clinicalGuardError(excl)).toBeNull();
  expect(clinicalGuardError(new Error("boom"))).toBeNull();
  expect(CLINICAL_GUARD_CODES).toContain("encounter_not_signed");
  const member = {
    message:
      'QueryError(PostgresError { code: "P0001", message: "not_a_member: WorkingHours.userId = ghost is not a member of the tenant", severity: "ERROR" })',
  };
  expect(notAMember(member)).toBe("userId");
  expect(clinicalGuardError(member)).toBeNull();
  expect(notAMember(trig)).toBeNull();
  expect(notAMember(excl)).toBeNull();
});
