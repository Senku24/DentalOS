import { type PatientDocument, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ConfirmUploadRequest,
  type DeleteDocumentRequest,
  type ListDocumentsQuery,
  type RequestUploadRequest,
  confirmUploadRequest,
  deleteDocumentRequest,
  listDocumentsQuery,
  requestUploadRequest,
} from "@dentalos/validation";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan, branchWhere } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { UUID, notFound, toPage } from "../org/http";
import { StorageService } from "../storage/storage.service";
import { objectStore } from "./object-store";

/** Mirrors StorageService's presigned TTLs (not exported there). */
const UPLOAD_TTL_SECONDS = 300;
const DOWNLOAD_TTL_SECONDS = 60;

const toDocument = (d: PatientDocument) => ({
  id: d.id,
  patientId: d.patientId,
  branchId: d.branchId,
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  category: d.category,
  description: d.description,
  status: d.status,
  uploadedBy: d.uploadedBy,
  createdAt: d.createdAt,
});

/** Patients are tenant-shared; checked directly by (tenantId, id). Merged tombstones take no new files. */
async function loadPatient(tx: Tx, tenantId: string, id: string) {
  const pt = await tx.patient.findUnique({
    where: { tenantId_id: { tenantId, id } },
    select: { id: true, mergedIntoId: true },
  });
  if (!pt) return notFound();
  return pt;
}

/**
 * Patient documents (PRD 4.2, 4.10): presigned upload -> confirm -> list -> presigned download -> soft
 * delete. Branch-scoped: out-of-scope documents answer 404. S3 work never runs inside a transaction.
 */
@Controller("documents")
export class DocumentsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /** Signs a POST limited to the declared size + content type, then records a PENDING_UPLOAD row. */
  @Can("document:write")
  @Post("uploads")
  async requestUpload(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(requestUploadRequest)) body: RequestUploadRequest,
  ) {
    assertCan(p, "document:write", { branchId: body.branchId });
    // Validate first (short tx), sign outside any transaction, then insert.
    await withTenant(this.prisma, p.tenantId, async (tx) => {
      const pt = await loadPatient(tx, p.tenantId, body.patientId);
      if (pt.mergedIntoId) throw new ConflictException({ error: "patient_merged" });
      const b = await tx.branch.findFirst({ where: { tenantId: p.tenantId, id: body.branchId } });
      if (!b) return notFound();
    });
    const post = await this.storage.presignUpload(p, {
      contentType: body.contentType,
      maxBytes: body.sizeBytes,
    });
    const doc = await withTenant(
      this.prisma,
      p.tenantId,
      (tx) =>
        tx.patientDocument.create({
          data: {
            tenantId: p.tenantId,
            patientId: body.patientId,
            branchId: body.branchId,
            storageKey: post.key,
            fileName: body.fileName,
            contentType: body.contentType,
            sizeBytes: body.sizeBytes,
            category: body.category,
            description: body.description,
            uploadedBy: p.userId,
          },
        }),
      { actorId: p.userId },
    );
    await this.record(p, "document.upload_request", doc);
    return {
      documentId: doc.id,
      url: post.url,
      fields: post.fields,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Verifies the object landed (size within the declared limit, same content type) and flips to AVAILABLE. */
  @Can("document:write")
  @Post(":id/confirm")
  @HttpCode(200)
  async confirm(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(confirmUploadRequest)) body: ConfirmUploadRequest,
  ) {
    const doc = await this.load(p, id);
    assertCan(p, "document:write", { branchId: doc.branchId });
    if (doc.status === "AVAILABLE") return toDocument(doc); // idempotent retry
    if (doc.status !== "PENDING_UPLOAD") throw new ConflictException({ error: "document_deleted" });
    this.storage.assertOwnKey(p, doc.storageKey);
    const head = await objectStore.head(doc.storageKey);
    if (!head || head.contentLength < 1) throw new ConflictException({ error: "upload_not_found" });
    if (
      head.contentLength > doc.sizeBytes ||
      (head.contentType && head.contentType !== doc.contentType)
    )
      throw new ConflictException({ error: "upload_mismatch" });
    const updated = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.patientDocument.updateMany({
          where: { tenantId: p.tenantId, id, status: "PENDING_UPLOAD" },
          data: { status: "AVAILABLE", sizeBytes: head.contentLength, sha256: body.sha256 },
        });
        const cur = await tx.patientDocument.findUniqueOrThrow({ where: { id } });
        if (r.count === 0 && cur.status !== "AVAILABLE")
          throw new ConflictException({ error: "document_deleted" });
        return cur;
      },
      { actorId: p.userId },
    );
    await this.record(p, "document.confirm", updated);
    return toDocument(updated);
  }

  @Can("document:read")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listDocumentsQuery)) q: ListDocumentsQuery,
  ) {
    if (q.branchId) assertCan(p, "document:read", { branchId: q.branchId });
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      await loadPatient(tx, p.tenantId, q.patientId);
      const rows = await tx.patientDocument.findMany({
        where: {
          tenantId: p.tenantId,
          patientId: q.patientId,
          status: "AVAILABLE",
          category: q.category,
          ...(q.branchId ? { branchId: q.branchId } : {}),
          AND: [branchWhere(p)],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor && z.uuid().safeParse(q.cursor).success
          ? { cursor: { id: q.cursor }, skip: 1 }
          : {}),
      });
      const { items, nextCursor } = toPage(rows, q.limit);
      return { items: items.map(toDocument), nextCursor };
    });
  }

  @Can("document:read")
  @Get(":id")
  async get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return toDocument(await this.load(p, id));
  }

  /** Short-lived presigned GET; every issued URL is audited (sensitive read). */
  @Can("document:read")
  @Get(":id/download-url")
  async download(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const doc = await this.load(p, id);
    assertCan(p, "document:read", { branchId: doc.branchId });
    if (doc.status !== "AVAILABLE") throw new ConflictException({ error: "document_unavailable" });
    const url = await this.storage.presignDownload(p, doc.storageKey);
    await this.record(p, "document.download", doc);
    return { url, expiresInSeconds: DOWNLOAD_TTL_SECONDS };
  }

  /** Soft delete only (DELETE is revoked from the app role); the object is retained per policy. */
  @Can("document:write")
  @Post(":id/delete")
  @HttpCode(200)
  async remove(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(deleteDocumentRequest)) _body: DeleteDocumentRequest,
  ) {
    const doc = await this.load(p, id);
    assertCan(p, "document:write", { branchId: doc.branchId });
    if (doc.status === "DELETED") return toDocument(doc);
    const updated = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await tx.patientDocument.updateMany({
          where: { tenantId: p.tenantId, id, status: { not: "DELETED" } },
          data: { status: "DELETED", deletedBy: p.userId, deletedAt: new Date() },
        });
        return tx.patientDocument.findUniqueOrThrow({ where: { id } });
      },
      { actorId: p.userId },
    );
    await this.record(p, "document.delete", updated);
    return toDocument(updated);
  }

  private async load(p: Principal, id: string) {
    const d = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.patientDocument.findFirst({ where: { tenantId: p.tenantId, id, ...branchWhere(p) } }),
    );
    return d ?? notFound();
  }

  private record(p: Principal, action: string, d: PatientDocument) {
    return this.audit.record(p, {
      action,
      resource: "PatientDocument",
      resourceId: d.id,
      branchId: d.branchId,
      outcome: "success",
    });
  }
}
