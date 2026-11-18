import { type Patient, Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type DuplicateCandidateResponse,
  type DuplicateCheckRequest,
  type PatientSummary,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import {
  type DuplicateReason,
  type IdentityProbe,
  LIKELY_THRESHOLD,
  MATCH_THRESHOLD,
  orderPair,
  scoreDuplicate,
} from "./duplicate-scoring";
import { dateOnly, toSummary } from "./patient-common";

export interface DuplicateMatch {
  patient: PatientSummary;
  score: number;
  reasons: DuplicateReason[];
}

/** Rows narrowed in SQL before scoring; the trigram GIN index serves `%`. */
const CANDIDATE_LIMIT = 50;
const MATCH_LIMIT = 10;

export function probeFrom(v: {
  firstName: string;
  middleName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
}): IdentityProbe {
  return {
    nameNormalized: normalizeName(v.firstName, v.middleName, v.lastName),
    phoneNormalized: normalizePhoneIN(v.phone),
    emailNormalized: normalizeEmail(v.email),
    dob: v.dob ?? null,
  };
}

export const probeOfPatient = (p: Patient): IdentityProbe => ({
  nameNormalized: p.nameNormalized,
  phoneNormalized: p.phoneNormalized,
  emailNormalized: p.emailNormalized,
  dob: dateOnly(p.dob),
});

@Injectable()
export class DuplicatesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * DB-backed match: pg_trgm narrows by name (`%`, threshold 0.3) or exact phone/email/DOB, then the
   * pure scorer ranks using Postgres `similarity()`. Merged tombstones are never candidates.
   */
  async findMatches(
    tx: Tx,
    tenantId: string,
    probe: IdentityProbe,
    excludeIds: string[] = [],
  ): Promise<DuplicateMatch[]> {
    const rows = await tx.$queryRaw<{ id: string; sim: number }[]>(Prisma.sql`
      SELECT id::text AS id, similarity("nameNormalized", ${probe.nameNormalized}) AS sim
      FROM "Patient"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "mergedIntoId" IS NULL
        AND NOT (id = ANY(${excludeIds}::uuid[]))
        AND (
          "nameNormalized" % ${probe.nameNormalized}
          OR ("phoneNormalized" IS NOT NULL AND "phoneNormalized" = ${probe.phoneNormalized}::text)
          OR ("emailNormalized" IS NOT NULL AND "emailNormalized" = ${probe.emailNormalized}::text)
          OR (dob = ${probe.dob}::date
              AND similarity("nameNormalized", ${probe.nameNormalized}) >= 0.2)
        )
      ORDER BY ("phoneNormalized" = ${probe.phoneNormalized}::text
                OR "emailNormalized" = ${probe.emailNormalized}::text) DESC NULLS LAST,
               sim DESC, id
      LIMIT ${CANDIDATE_LIMIT}`);
    if (rows.length === 0) return [];
    const sims = new Map(rows.map((r) => [r.id, Number(r.sim)]));
    const patients = await tx.patient.findMany({ where: { id: { in: [...sims.keys()] } } });
    return patients
      .map((c) => ({ c, s: scoreDuplicate(probe, probeOfPatient(c), sims.get(c.id)) }))
      .filter(({ s }) => s.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.s.score - a.s.score || a.c.id.localeCompare(b.c.id))
      .slice(0, MATCH_LIMIT)
      .map(({ c, s }) => ({ patient: toSummary(c), score: s.score, reasons: s.reasons }));
  }

  /**
   * Upserts likely pairs into the review queue (patientAId < patientBId). A pair already reviewed
   * (DISMISSED/MERGED) is left alone so dismissed pairs do not resurface on every edit.
   */
  async persistLikely(tx: Tx, tenantId: string, patientId: string, matches: DuplicateMatch[]) {
    let n = 0;
    for (const m of matches) {
      if (m.score < LIKELY_THRESHOLD) continue;
      const [a, b] = orderPair(patientId, m.patient.id);
      n += await tx.$executeRaw(Prisma.sql`
        INSERT INTO "DuplicateCandidate"
          ("id", "tenantId", "patientAId", "patientBId", "score", "reasons", "status", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${a}::uuid, ${b}::uuid, ${m.score},
                ${JSON.stringify(m.reasons)}::jsonb, 'PENDING', now(), now())
        ON CONFLICT ("tenantId", "patientAId", "patientBId") DO UPDATE
          SET "score" = EXCLUDED."score", "reasons" = EXCLUDED."reasons", "updatedAt" = now()
          WHERE "DuplicateCandidate"."status" = 'PENDING'`);
    }
    return n;
  }

  /** Pre-create / pre-edit check. Read-only: never persists, never blocks unless `failOnMatch`. */
  async check(p: Principal, body: DuplicateCheckRequest) {
    const matches = await withTenant(
      this.prisma,
      p.tenantId,
      (tx) =>
        this.findMatches(
          tx,
          p.tenantId,
          probeFrom(body),
          body.excludePatientId ? [body.excludePatientId] : [],
        ),
      { actorId: p.userId },
    );
    if (body.failOnMatch && matches.some((m) => m.score >= LIKELY_THRESHOLD))
      throw new ConflictException({ error: "possible_duplicates", matches });
    return { matches };
  }

  async listCandidates(
    p: Principal,
    q: { status: "PENDING" | "DISMISSED" | "MERGED"; cursor?: string; limit: number },
  ) {
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const rows = await tx.duplicateCandidate.findMany({
        where: { status: q.status },
        include: { patientA: true, patientB: true },
        orderBy: [{ score: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor && isUuid(q.cursor) ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      const items = rows.slice(0, q.limit).map(
        (r): DuplicateCandidateResponse => ({
          id: r.id,
          patientA: toSummary(r.patientA),
          patientB: toSummary(r.patientB),
          score: r.score,
          reasons: (Array.isArray(r.reasons) ? r.reasons : []) as DuplicateReason[],
          status: r.status,
          reviewedBy: r.reviewedBy,
          reviewedAt: r.reviewedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }),
      );
      return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
    });
  }

  /** The dismissal reason is not stored (no column; audit is ids-only) — see Flags. */
  async dismiss(p: Principal, id: string) {
    const r = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const c = await tx.duplicateCandidate.findUnique({ where: { id } });
        if (!c) throw new NotFoundException({ error: "duplicate_candidate_not_found" });
        if (c.status !== "PENDING")
          throw new ConflictException({ error: "already_reviewed", status: c.status });
        return tx.duplicateCandidate.update({
          where: { id },
          data: { status: "DISMISSED", reviewedBy: p.userId, reviewedAt: new Date() },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.duplicate.dismiss",
      resource: "duplicate_candidate",
      resourceId: id,
      outcome: "success",
    });
    return { id: r.id, status: r.status };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
