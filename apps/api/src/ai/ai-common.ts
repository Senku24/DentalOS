import { randomInt } from "node:crypto";
import { type AiDraft, Prisma, type PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  AI_APPROVED_LABEL,
  AI_DRAFT_LABEL,
  type AiDraftResponse,
  type AiErrorCode,
  aiContentHash,
  aiDraftMetadata,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  M4_GUARD_HTTP,
  checkViolation,
  clinicalGuardError,
  foreignKeyViolation,
  isRetryableTxError,
  isUniqueViolation,
  m4GuardError,
  notAMember,
  privilegeDenied,
} from "../common/db-errors";
import { logger } from "../observability/logger";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** HTTP status of each stable AI error code (`AI_ERROR_CODES` in @dentalos/validation). */
export const AI_HTTP: Readonly<Record<AiErrorCode, number>> = {
  ai_disabled: 403,
  ai_capability_disabled: 403,
  ai_role_denied: 403,
  ai_quota_exceeded: 429,
  ai_region_not_compliant: 422,
  // 424, not 502: the global exception filter flattens every 5xx into an opaque 500.
  ai_provider_error: 424,
  ai_consent_required: 409,
  ai_audio_invalid: 400,
  ai_draft_not_found: 404,
  ai_draft_final: 409,
  ai_draft_expired: 409,
  ai_draft_content_invalid: 400,
  ai_encounter_signed: 409,
  ai_content_changed: 409,
  ai_refused: 422,
};

export const aiError = (code: AiErrorCode, extra: Record<string, unknown> = {}): HttpException =>
  new HttpException({ error: code, ...extra }, AI_HTTP[code]);

/** 409 `encounter_signed` (the clinical module's code; `aiCode` carries the contract's `ai_encounter_signed`). */
export const encounterSigned = () =>
  new ConflictException({ error: "encounter_signed", aiCode: "ai_encounter_signed" });
export const notFound = (error: string) => new NotFoundException({ error });
export const badRequest = (error: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ error, ...extra });
export const conflict = (error: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ error, ...extra });
export const forbidden = (error: string) => new ForbiddenException({ error });

/** Translates the database's guard errors into stable API errors (HttpExceptions pass through). */
export function mapAiDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const m4 = m4GuardError(e);
  if (m4) {
    const status = M4_GUARD_HTTP[m4];
    if (m4 === "ai_draft_expired") throw aiError("ai_draft_expired");
    if (status === 400) throw new BadRequestException({ error: m4 });
    if (status === 403) throw new ForbiddenException({ error: m4 });
    if (status === 429) throw new HttpException({ error: m4 }, 429);
    throw new ConflictException({ error: m4 });
  }
  const clinical = clinicalGuardError(e);
  if (clinical === "clinical_row_moved") throw new BadRequestException({ error: clinical });
  if (clinical) throw new ConflictException({ error: clinical });
  const check = checkViolation(e);
  if (check) throw new ConflictException({ error: "constraint_violated", constraint: check });
  const fk = foreignKeyViolation(e);
  if (fk) throw new ConflictException({ error: "link_mismatch", constraint: fk });
  const member = notAMember(e);
  if (member) throw new BadRequestException({ error: "not_a_member", field: member });
  if (privilegeDenied(e)) {
    logger.error("ai: privilege denied (programming error: a column / table grant is missing)");
    throw new InternalServerErrorException();
  }
  if (isRetryableTxError(e)) throw new ConflictException({ error: "retry_later" });
  if (isUniqueViolation(e)) throw new ConflictException({ error: "duplicate" });
  throw e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One unit of work: `withTenant` + actor (DB triggers), retried on deadlock / serialization, DB errors mapped. */
export async function runTx<T>(
  prisma: PrismaClient,
  who: { tenantId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTenant(prisma, who.tenantId, fn, { actorId: who.userId });
    } catch (e) {
      if (attempt < 4 && isRetryableTxError(e)) {
        await sleep(10 + randomInt(40) * attempt);
        continue;
      }
      return mapAiDbError(e);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cursors (createdAt desc, id desc)
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badRequest("invalid_cursor");
  return { createdAt, id: id as string };
}

/** Keyset predicate for rows ordered by (field desc, id desc). */
export function beforeCursor(field: string, cursor: string | undefined): object[] {
  if (!cursor) return [];
  const c = decodeCursor(cursor);
  return [{ OR: [{ [field]: { lt: c.createdAt } }, { [field]: c.createdAt, id: { lt: c.id } }] }];
}

// ---------------------------------------------------------------------------------------------
// Draft mapper
// ---------------------------------------------------------------------------------------------

export async function toDraftResponse(d: AiDraft): Promise<AiDraftResponse> {
  const meta = aiDraftMetadata.parse(d.metadata);
  const content = (d.content ?? {}) as Record<string, unknown>;
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    subjectType: d.subjectType,
    subjectId: d.subjectId,
    patientId: d.patientId,
    branchId: d.branchId,
    encounterId: d.encounterId,
    planVersionId: d.planVersionId,
    content,
    metadata: meta,
    label: d.status === "APPROVED" ? AI_APPROVED_LABEL : AI_DRAFT_LABEL,
    contentHash: await aiContentHash(content),
    createdBy: d.createdBy,
    createdAt: d.createdAt.toISOString(),
    editedBy: d.editedBy,
    editedAt: d.editedAt?.toISOString() ?? null,
    reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    reviewNote: d.reviewNote,
    resultingRecordType: d.resultingRecordType,
    resultingRecordId: d.resultingRecordId,
    expiresAt: d.expiresAt.toISOString(),
  };
}

export const asJson = (v: unknown) => v as Prisma.InputJsonValue;

/** Builds a Prisma `Sql` raw uuid cast helper (kept here so services share one spelling). */
export const sqlUuid = (id: string) => Prisma.sql`${id}::uuid`;
