/**
 * Local demo data for manual testing (`bun run db:seed`, reads ./.env).
 *
 * Creates two demo organisations (A, B) and one "UI" organisation whose dentist is the staff-web
 * dev user. Each run adds its own patients. Re-running is safe: rows are looked up and reused, and
 * nothing is deleted.
 *
 * It prints a ready-to-paste block of NEXT_PUBLIC_DEV_* values for .env (staff-web dev login) and
 * 7-day dev access tokens (set DEV_TOKEN_TTL to change it), minted with DEV_JWT_SECRET.
 *
 * Env: ADMIN_DATABASE_URL (superuser, RLS bootstrap), DATABASE_URL (app role), DEV_JWT_SECRET.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient, type Role, type Tx, withTenant } from "@dentalos/db";
import { normalizeName, normalizePhoneIN } from "@dentalos/validation";
import { SignJWT } from "jose";

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/dentalos";
const APP_URL =
  process.env.DATABASE_URL ?? "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";

/** Fixed ids for the DENTIST build of staff-web (see lib/session.ts + lib/api/fixtures.ts `fid`). */
export const UI_TENANT_ID = "5eed0d00-0000-4000-8000-000000000001";
export const UI_BRANCH_ID = "0b000000-0000-4000-8000-000000000001";
export const UI_DENTIST = "dev-user";

const runId = (process.env.SEED_RUN_ID ?? randomBytes(4).toString("hex")).toLowerCase();
if (!/^[a-z0-9]{3,16}$/.test(runId)) throw new Error("SEED_RUN_ID must be 3-16 [a-z0-9] chars");
const RUN = runId.toUpperCase();
const SEED_ACTOR = "seed-dev";

const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

/** IANA zone whose local time is ~11:xx right now (Etc/GMT signs are inverted: GMT-5 = UTC+5). */
export function lateMorningZone(now = new Date()): string {
  const offset = Math.max(-12, Math.min(14, 11 - now.getUTCHours()));
  if (offset === 0) return "Etc/UTC";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function tenant(name: string, id?: string): Promise<string> {
  if (id) {
    await admin.tenant.upsert({ where: { id }, update: {}, create: { id, name } });
    return id;
  }
  const found = await admin.tenant.findFirst({ where: { name }, select: { id: true } });
  return found?.id ?? (await admin.tenant.create({ data: { name } })).id;
}

interface MemberSpec {
  userId: string;
  roles: Role[];
  displayName: string;
  email: string;
  orgWide?: boolean;
  branchScope?: string[];
}

async function member(tenantId: string, m: MemberSpec): Promise<string> {
  const data = {
    roles: m.roles,
    orgWide: m.orgWide ?? false,
    branchScope: m.branchScope ?? [],
    displayName: m.displayName,
    email: m.email.toLowerCase(),
  };
  await admin.membership.upsert({
    where: { tenantId_userId: { tenantId, userId: m.userId } },
    update: data,
    create: { tenantId, userId: m.userId, ...data },
  });
  return m.userId;
}

async function branch(
  tx: Tx,
  tenantId: string,
  b: { id?: string; code: string; name: string; timezone: string },
): Promise<string> {
  const found = await tx.branch.findFirst({
    where: { tenantId, code: b.code },
    select: { id: true },
  });
  if (found) return found.id;
  return (
    await tx.branch.create({
      data: {
        ...(b.id ? { id: b.id } : {}),
        tenantId,
        code: b.code,
        name: b.name,
        timezone: b.timezone,
        city: "New Delhi",
        state: "Delhi",
        postalCode: "110017",
      },
    })
  ).id;
}

async function chair(tx: Tx, tenantId: string, branchId: string, code: string): Promise<string> {
  const found = await tx.chair.findFirst({
    where: { tenantId, branchId, code },
    select: { id: true },
  });
  if (found) return found.id;
  return (await tx.chair.create({ data: { tenantId, branchId, code, name: `Operatory ${code}` } }))
    .id;
}

/** Every weekday 07:00–21:00 branch-local, in force since 2020 (written directly: no past-date rule). */
async function branchHours(tx: Tx, tenantId: string, branchId: string): Promise<void> {
  const n = await tx.workingHours.count({ where: { tenantId, branchId, scope: "BRANCH" } });
  if (n > 0) return;
  await tx.workingHours.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      tenantId,
      scope: "BRANCH" as const,
      branchId,
      weekday,
      startMinute: 7 * 60,
      endMinute: 21 * 60,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: SEED_ACTOR,
    })),
  });
}

async function assignment(tx: Tx, tenantId: string, userId: string, branchId: string) {
  const found = await tx.dentistBranchAssignment.findFirst({
    where: { tenantId, userId, branchId, effectiveTo: null },
    select: { id: true },
  });
  if (found) return;
  await tx.dentistBranchAssignment.create({
    data: {
      tenantId,
      userId,
      branchId,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: SEED_ACTOR,
    },
  });
}

async function service(
  tx: Tx,
  tenantId: string,
  s: { code: string; name: string; durationMin: number; basePricePaise: number },
): Promise<string> {
  const found = await tx.service.findFirst({
    where: { tenantId, code: s.code },
    select: { id: true },
  });
  return found?.id ?? (await tx.service.create({ data: { tenantId, ...s } })).id;
}

interface SeededPatient {
  id: string;
  firstName: string;
  lastName: string;
  mrn: string;
  phone: string;
  /** AVAILABLE CONSENT_FORM document (usable as a consent signature). */
  signatureDocumentId: string;
}

async function patient(
  tx: Tx,
  tenantId: string,
  branchId: string,
  n: number,
  firstName: string,
  tag: string,
): Promise<SeededPatient> {
  const mrn = `DEMO-${RUN}-${tag}-${n}`;
  const lastName = `DEMO${RUN}${tag}`;
  const phone = `+9198${String(Number.parseInt(runId.slice(0, 6), 36) % 10_000).padStart(4, "0")}${String(n).padStart(4, "0")}`;
  const p =
    (await tx.patient.findFirst({ where: { tenantId, mrn }, select: { id: true } })) ??
    (await tx.patient.create({
      data: {
        tenantId,
        originBranchId: branchId,
        mrn,
        firstName,
        lastName,
        nameNormalized: normalizeName(firstName, lastName),
        phone,
        phoneNormalized: normalizePhoneIN(phone),
        sex: n % 2 ? "FEMALE" : "MALE",
        dob: new Date(Date.UTC(1980 + n, n % 12, 10)),
        intakeType: "WALK_IN",
        createdBy: SEED_ACTOR,
      },
      select: { id: true },
    }));
  const storageKey = `${tenantId}/demo/${p.id}/signature.png`;
  const doc =
    (await tx.patientDocument.findFirst({
      where: { tenantId, storageKey },
      select: { id: true },
    })) ??
    (await tx.patientDocument.create({
      data: {
        tenantId,
        patientId: p.id,
        branchId,
        storageKey,
        fileName: "signature.png",
        contentType: "image/png",
        sizeBytes: 128,
        category: "CONSENT_FORM",
        status: "AVAILABLE",
        uploadedBy: SEED_ACTOR,
      },
      select: { id: true },
    }));
  return { id: p.id, firstName, lastName, mrn, phone, signatureDocumentId: doc.id };
}

const FIRST_NAMES = ["Aarav", "Diya", "Kabir", "Meera", "Rohan", "Saanvi", "Vihaan", "Anaya"];

async function seedTenant(tag: "A" | "B", timezone: string) {
  const name = `Demo ${RUN} ${tag}`;
  const tenantId = await tenant(name);
  const lower = tag.toLowerCase();
  const user = (role: string) => `demo-${runId}-${lower}-${role}`;

  const b = await withTenant(
    app,
    tenantId,
    async (tx) => ({
      b1: await branch(tx, tenantId, {
        code: `${tag}1`,
        name: `Demo ${tag} Saket`,
        timezone,
      }),
      b2:
        tag === "A"
          ? await branch(tx, tenantId, { code: `${tag}2`, name: `Demo ${tag} Noida`, timezone })
          : undefined,
    }),
    { actorId: SEED_ACTOR },
  );
  const allBranches = [b.b1, ...(b.b2 ? [b.b2] : [])];

  const users: Record<string, string> = {};
  const specs: MemberSpec[] = [
    {
      userId: user("owner"),
      roles: ["OWNER"],
      orgWide: true,
      displayName: `Owner ${tag} (demo)`,
      email: `${user("owner")}@demo.test`,
    },
    {
      userId: user("manager"),
      roles: ["MANAGER"],
      branchScope: [b.b1],
      displayName: `Manager ${tag} (demo)`,
      email: `${user("manager")}@demo.test`,
    },
    {
      userId: user("dentist"),
      roles: ["DENTIST"],
      branchScope: [b.b1],
      displayName: `Dr. Dentist ${tag} (demo)`,
      email: `${user("dentist")}@demo.test`,
    },
    {
      userId: user("receptionist"),
      roles: ["RECEPTIONIST"],
      branchScope: [b.b1],
      displayName: `Receptionist ${tag} (demo)`,
      email: `${user("receptionist")}@demo.test`,
    },
    {
      userId: user("accountant"),
      roles: ["ACCOUNTANT"],
      branchScope: [b.b1],
      displayName: `Accountant ${tag} (demo)`,
      email: `${user("accountant")}@demo.test`,
    },
  ];
  if (b.b2)
    specs.push({
      userId: user("dentist2"),
      roles: ["DENTIST"],
      branchScope: [b.b2],
      displayName: `Dr. Second ${tag} (demo)`,
      email: `${user("dentist2")}@demo.test`,
    });
  for (const s of specs) {
    const key = s.userId.slice(`demo-${runId}-${lower}-`.length);
    users[key] = await member(tenantId, s);
  }

  const rest = await withTenant(
    app,
    tenantId,
    async (tx) => {
      const chairs: Record<string, string[]> = {};
      for (const br of allBranches) {
        chairs[br] = [await chair(tx, tenantId, br, "OP-1"), await chair(tx, tenantId, br, "OP-2")];
        await branchHours(tx, tenantId, br);
      }
      await assignment(tx, tenantId, users.dentist as string, b.b1);
      if (b.b2 && users.dentist2) await assignment(tx, tenantId, users.dentist2, b.b2);
      const services = {
        consult: await service(tx, tenantId, {
          code: "DEMO-CONSULT",
          name: "Consultation",
          durationMin: 15,
          basePricePaise: 50_000,
        }),
        filling: await service(tx, tenantId, {
          code: "DEMO-FILL",
          name: "Composite filling",
          durationMin: 30,
          basePricePaise: 150_000,
        }),
        rct: await service(tx, tenantId, {
          code: "DEMO-RCT",
          name: "Root canal treatment (molar)",
          durationMin: 60,
          basePricePaise: 800_000,
        }),
      };
      const count = tag === "A" ? 8 : 2;
      const patients: SeededPatient[] = [];
      for (let n = 1; n <= count; n++)
        patients.push(
          await patient(
            tx,
            tenantId,
            b.b1,
            n,
            FIRST_NAMES[(n - 1) % FIRST_NAMES.length] as string,
            tag,
          ),
        );
      return { chairs, services, patients };
    },
    { actorId: SEED_ACTOR },
  );

  return {
    id: tenantId,
    name,
    timezone,
    branches: b,
    users,
    ...rest,
  };
}

async function seedUiTenant() {
  const tenantId = await tenant("Dev UI clinic (shared)", UI_TENANT_ID);
  await withTenant(
    app,
    tenantId,
    (tx) =>
      branch(tx, tenantId, {
        id: UI_BRANCH_ID,
        code: "UI1",
        name: "Dev UI Saket",
        timezone: "Asia/Kolkata",
      }),
    { actorId: SEED_ACTOR },
  );
  await member(tenantId, {
    userId: UI_DENTIST,
    roles: ["DENTIST"],
    branchScope: [UI_BRANCH_ID],
    displayName: "Asha Verma",
    email: "dev-user@demo.test",
  });
  const patients = await withTenant(
    app,
    tenantId,
    async (tx) => {
      await assignment(tx, tenantId, UI_DENTIST, UI_BRANCH_ID);
      const out: SeededPatient[] = [];
      for (let n = 1; n <= 3; n++)
        out.push(await patient(tx, tenantId, UI_BRANCH_ID, n, FIRST_NAMES[n] as string, "UI"));
      return out;
    },
    { actorId: SEED_ACTOR },
  );
  return { id: tenantId, branchId: UI_BRANCH_ID, dentist: UI_DENTIST, patients };
}

async function mintTokens(users: string[]): Promise<Record<string, string> | undefined> {
  const secret = process.env.DEV_JWT_SECRET;
  if (!secret) return undefined;
  const key = new TextEncoder().encode(secret);
  const out: Record<string, string> = {};
  for (const sub of users)
    out[sub] = await new SignJWT({ mfa: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setSubject(sub)
      .setExpirationTime(process.env.DEV_TOKEN_TTL ?? "7d")
      .sign(key);
  return out;
}

/** Updates the NEXT_PUBLIC_DEV_* lines of the repo-root .env in place (only those keys). */
function writeDevEnv(ui: { id: string; branchId: string; dentist: string }, token?: string) {
  const file = new URL("../../../.env", import.meta.url).pathname;
  if (!existsSync(file)) {
    console.error(`No .env at ${file}: copy .env.example to .env first.`);
    return;
  }
  if (!token) {
    console.error("DEV_JWT_SECRET is empty in .env: set it, then run this again.");
    return;
  }
  const values: Record<string, string> = {
    NEXT_PUBLIC_DEV_ROLE: "DENTIST",
    NEXT_PUBLIC_DEV_TENANT_ID: ui.id,
    NEXT_PUBLIC_DEV_BRANCH_ID: ui.branchId,
    NEXT_PUBLIC_DEV_USER_ID: ui.dentist,
    NEXT_PUBLIC_DEV_TOKEN: token,
  };
  const seen = new Set<string>();
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => {
      const k = l.split("=", 1)[0] ?? "";
      if (!(k in values)) return l;
      seen.add(k);
      return `${k}=${values[k]}`;
    });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  writeFileSync(file, lines.join("\n"));
  console.error("Updated NEXT_PUBLIC_DEV_* in .env. Restart `bun run dev:web` to pick them up.");
}

async function main() {
  const timezone = lateMorningZone();
  const A = await seedTenant("A", timezone);
  const B = await seedTenant("B", timezone);
  const ui = await seedUiTenant();
  const tokens = await mintTokens([
    ...Object.values(A.users),
    ...Object.values(B.users),
    ui.dentist,
  ]);
  if (process.argv.includes("--write-env")) writeDevEnv(ui, tokens?.[ui.dentist]);
  if (ui.patients[0]) {
    process.stderr.write(
      [
        "",
        "# Paste into .env (repo root) for the staff-web dev login:",
        "NEXT_PUBLIC_DEV_ROLE=DENTIST",
        `NEXT_PUBLIC_DEV_TENANT_ID=${ui.id}`,
        `NEXT_PUBLIC_DEV_BRANCH_ID=${ui.branchId}`,
        `NEXT_PUBLIC_DEV_USER_ID=${ui.dentist}`,
        `NEXT_PUBLIC_DEV_TOKEN=${tokens?.[ui.dentist] ?? "<set DEV_JWT_SECRET and re-run>"}`,
        "",
      ].join("\n"),
    );
  }
  const out = {
    runId,
    seededAt: new Date().toISOString(),
    A,
    B,
    ui,
    ...(tokens ? { tokens } : {}),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.$disconnect();
    await app.$disconnect();
  });
