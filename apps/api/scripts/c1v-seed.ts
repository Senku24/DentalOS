import { writeFileSync } from "node:fs";
import { PrismaClient } from "@dentalos/db";
import { SignJWT } from "jose";
const admin = new PrismaClient({ datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } } });
const T = "c1f20000-0000-4000-8000-000000000001";
const BA = "c1f2b000-0000-4000-8000-00000000000a";
const BB = "c1f2b000-0000-4000-8000-00000000000b";
const P1 = "c1f2c000-0000-4000-8000-000000000001";
const S1 = "c1f2d000-0000-4000-8000-000000000001";
const S2 = "c1f2d000-0000-4000-8000-000000000002";
const CAT1 = "c1f2e000-0000-4000-8000-000000000001";
await admin.tenant.create({ data: { id: T, name: "c1v verify" } });
await admin.branch.createMany({
  data: [
    { id: BA, tenantId: T, code: "A", name: "A" },
    { id: BB, tenantId: T, code: "B", name: "B" },
  ],
});
const m = (userId: string, roles: any[], orgWide: boolean, branchScope: string[]) => ({
  tenantId: T,
  userId,
  roles,
  orgWide,
  branchScope,
  displayName: userId,
  email: `${userId.toLowerCase()}@v.test`,
});
await admin.membership.createMany({
  data: [
    m("owner", ["OWNER"], true, []),
    m("acct", ["ACCOUNTANT"], true, []),
    m("acctA", ["ACCOUNTANT"], false, [BA]),
    m("mgrA", ["MANAGER"], false, [BA]),
    m("mgrB", ["MANAGER"], false, [BB]),
    m("recA", ["RECEPTIONIST"], false, [BA]),
    m("d1", ["DENTIST"], false, [BA]),
    m("d2", ["DENTIST"], false, [BA]),
    m("dB", ["DENTIST"], false, [BB]),
  ],
});
await admin.patient.create({
  data: {
    id: P1,
    tenantId: T,
    originBranchId: BA,
    firstName: "Asha",
    lastName: "V",
    nameNormalized: "asha v",
    intakeType: "WALK_IN" as any,
    createdBy: "x",
  },
});
await admin.serviceCategory.create({ data: { id: CAT1, tenantId: T, name: "Cat1" } });
await admin.service.createMany({
  data: [
    {
      id: S1,
      tenantId: T,
      code: "X1",
      name: "NoTax",
      basePricePaise: 100000,
      taxable: false,
      durationMin: 30,
      categoryId: CAT1,
    },
    {
      id: S2,
      tenantId: T,
      code: "X2",
      name: "Taxed",
      basePricePaise: 50000,
      taxable: true,
      gstRateBp: 1800,
      hsnSac: "999312",
      durationMin: 30,
    },
  ],
});
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const tokens: Record<string, string> = {};
for (const u of ["owner", "acct", "acctA", "mgrA", "mgrB", "recA", "d1", "d2", "dB"])
  tokens[u] = await new SignJWT({ mfa: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(u)
    .setExpirationTime("2h")
    .sign(key);
writeFileSync(process.argv[2]!, JSON.stringify({ T, BA, BB, P1, S1, S2, CAT1, tokens }, null, 1));
await admin.$disconnect();
console.log("seeded");
