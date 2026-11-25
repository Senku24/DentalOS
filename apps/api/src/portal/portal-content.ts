import { PrismaClient, withTenant } from "@dentalos/db";
import {
  type ListPortalDocumentsQuery,
  type ListPortalNotificationsQuery,
  PORTAL_HIDDEN_NOTIFICATION_CODES,
  type PortalDocumentDownloadResponse,
  listPortalDocumentsQuery,
  listPortalNotificationsQuery,
  portalNotificationTitle,
} from "@dentalos/validation";
import { Controller, Get, Inject, Injectable, Param, Query } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PortalAuditService } from "../auth/portal-audit";
import { PortalAuth } from "../auth/portal.guard";
import { ZodPipe } from "../common/zod.pipe";
import { DOWNLOAD_TTL_SECONDS, StorageService } from "../storage/storage.service";
import { UUID, attribution, decodeCursor, iso, isoOrNull, notFound, pageOf } from "./portal-common";

/** What a patient may open: staff-flagged (`portalVisible`), AVAILABLE, never an ID proof, same patient. */
const visibleDocument = (me: PatientPrincipal, id?: string) => ({
  ...(id ? { id } : {}),
  patientId: { in: me.patientIds },
  status: "AVAILABLE" as const,
  portalVisible: true,
  category: { not: "ID_PROOF" as const },
});

/** Documents (short-lived presigned download, audited) and the patient's own notification history. */
@Injectable()
export class PortalContentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: PortalAuditService,
    private readonly storage: StorageService,
  ) {}

  async documents(me: PatientPrincipal, q: ListPortalDocumentsQuery) {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const c = decodeCursor(q.cursor);
      const rows = await tx.patientDocument.findMany({
        where: {
          ...visibleDocument(me),
          ...(c
            ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => r.createdAt);
      return {
        items: page.items.map((d) => ({
          id: d.id,
          fileName: d.fileName,
          category: d.category,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          description: d.description,
          createdAt: iso(d.createdAt),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  /** Never a public object URL: a presigned GET of the tenant-prefixed key, minted after the visibility check. */
  async download(me: PatientPrincipal, id: string): Promise<PortalDocumentDownloadResponse> {
    const doc = await withTenant(this.prisma, me.tenantId, (tx) =>
      tx.patientDocument.findFirst({ where: visibleDocument(me, id) }),
    );
    if (!doc) throw notFound("document_not_available");
    const url = await this.storage.presignDownload(attribution(me), doc.storageKey);
    await this.audit.record(me, {
      action: "portal.document.download",
      resource: "document",
      resourceId: doc.id,
      branchId: doc.branchId,
      outcome: "success",
    });
    return { url, expiresAt: iso(new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000)) };
  }

  /** The patient's own outbox rows: no addresses, no variables, no codes; messages that never went out are not listed. */
  async notifications(me: PatientPrincipal, q: ListPortalNotificationsQuery) {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const c = decodeCursor(q.cursor);
      const rows = await tx.notificationOutbox.findMany({
        where: {
          patientId: { in: me.patientIds },
          status: { in: ["QUEUED", "SENT", "FAILED"] },
          templateCode: { notIn: [...PORTAL_HIDDEN_NOTIFICATION_CODES] },
          ...(c
            ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        select: {
          id: true,
          templateCode: true,
          channel: true,
          status: true,
          createdAt: true,
          sentAt: true,
        },
      });
      const page = pageOf(rows, q.limit, (r) => r.createdAt);
      return {
        items: page.items.map((n) => ({
          id: n.id,
          kind: n.templateCode,
          title: portalNotificationTitle(n.templateCode),
          channel: (n.channel === "VOICE" ? "SMS" : n.channel) as "SMS" | "WHATSAPP" | "EMAIL",
          status: n.status as "QUEUED" | "SENT" | "FAILED",
          createdAt: iso(n.createdAt),
          sentAt: isoOrNull(n.sentAt),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}

@Controller("portal")
export class PortalContentController {
  constructor(private readonly svc: PortalContentService) {}

  @PortalAuth()
  @Get("documents")
  documents(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(listPortalDocumentsQuery)) q: ListPortalDocumentsQuery,
  ) {
    return this.svc.documents(me, q);
  }

  @PortalAuth()
  @Get("documents/:id/download-url")
  download(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.download(me, id);
  }

  @PortalAuth()
  @Get("notifications")
  notifications(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(listPortalNotificationsQuery)) q: ListPortalNotificationsQuery,
  ) {
    return this.svc.notifications(me, q);
  }
}
