import "reflect-metadata";
import { afterAll, expect, test } from "bun:test";
import { $Enums } from "@dentalos/db";
import * as v from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuditService } from "./audit/audit.service";
import { PRISMA } from "./auth/auth.guard";
import { CatalogModule } from "./catalog/catalog.module";
import { ClinicalModule } from "./clinical/clinical.module";
import { DocumentsModule } from "./documents/documents.module";
import { OrgModule } from "./org/org.module";
import { PatientsModule } from "./patients/patients.module";
import { PlansModule } from "./plans/plans.module";
import { SchedulingModule } from "./scheduling/scheduling.module";
import { StorageService } from "./storage/storage.service";

process.env.DEV_JWT_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATABASE_URL ??= "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";

// Proves the M1 + M2 feature modules can inject the @Global AppModule providers without importing anything.
@Injectable()
class Probe {
  constructor(
    @Inject(PRISMA) readonly prisma: unknown,
    readonly audit: AuditService,
    readonly storage: StorageService,
  ) {}
}

const modules = [
  OrgModule,
  CatalogModule,
  PatientsModule,
  DocumentsModule,
  SchedulingModule,
  ClinicalModule,
  PlansModule,
];
// Swap each module's providers AND controllers for the probe: the real controllers depend on the
// module's real providers, and Nest would otherwise fail to resolve them (abortOnError exits the process).
const saved = modules.map((m) => ({
  providers: Reflect.getMetadata("providers", m),
  controllers: Reflect.getMetadata("controllers", m),
}));
afterAll(() =>
  modules.forEach((m, i) => {
    Reflect.defineMetadata("providers", saved[i]?.providers, m);
    Reflect.defineMetadata("controllers", saved[i]?.controllers, m);
  }),
);

test("feature modules resolve PRISMA, AuditService and StorageService", async () => {
  for (const m of modules) {
    Reflect.defineMetadata("providers", [Probe], m);
    Reflect.defineMetadata("controllers", [], m);
  }
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  for (const m of modules) {
    const probe = app.select(m).get(Probe, { strict: true });
    expect(probe.prisma).toBeDefined();
    expect(probe.audit).toBeInstanceOf(AuditService);
    expect(probe.storage).toBeInstanceOf(StorageService);
  }
  await app.close();
});

test("@dentalos/validation enum lists match the Prisma schema", () => {
  const pairs: [string, readonly string[], Record<string, string>][] = [
    ["OnboardingStatus", v.ONBOARDING_STATUSES, $Enums.OnboardingStatus],
    ["InvitationStatus", v.INVITATION_STATUSES, $Enums.InvitationStatus],
    ["Sex", v.SEXES, $Enums.Sex],
    ["PatientLifecycleStage", v.PATIENT_LIFECYCLE_STAGES, $Enums.PatientLifecycleStage],
    ["IntakeType", v.INTAKE_TYPES, $Enums.IntakeType],
    [
      "IdentityVerificationMethod",
      v.IDENTITY_VERIFICATION_METHODS,
      $Enums.IdentityVerificationMethod,
    ],
    ["EnquirySource", v.ENQUIRY_SOURCES, $Enums.EnquirySource],
    ["EnquiryStatus", v.ENQUIRY_STATUSES, $Enums.EnquiryStatus],
    ["Severity", v.SEVERITIES, $Enums.Severity],
    ["ConsentStatus", v.CONSENT_STATUSES, $Enums.ConsentStatus],
    ["CommChannel", v.COMM_CHANNELS, $Enums.CommChannel],
    ["CommPurpose", v.COMM_PURPOSES, $Enums.CommPurpose],
    ["DocumentCategory", v.DOCUMENT_CATEGORIES, $Enums.DocumentCategory],
    ["DocumentStatus", v.DOCUMENT_STATUSES, $Enums.DocumentStatus],
    ["DuplicateStatus", v.DUPLICATE_STATUSES, $Enums.DuplicateStatus],
  ];
  for (const [name, mine, prisma] of pairs)
    expect(`${name}: ${[...mine].sort()}`).toBe(`${name}: ${Object.values(prisma).sort()}`);
  // Staff roles = Prisma Role minus PATIENT.
  expect([...v.STAFF_ROLES].sort()).toEqual(
    Object.values($Enums.Role)
      .filter((r) => r !== "PATIENT")
      .sort(),
  );
});
