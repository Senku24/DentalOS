import { z } from "zod";
import { isoDateTime, optionalText, pageQuery, uuid } from "./common";

// Patient documents & attachments: presigned upload -> confirm -> presigned download (PRD 4.2, 4.10).

export const DOCUMENT_CATEGORIES = [
  "ID_PROOF",
  "CONSENT_FORM",
  "REFERRAL",
  "LAB_REPORT",
  "XRAY",
  "PHOTO",
  "PRESCRIPTION",
  "INSURANCE",
  "OTHER",
] as const;
export const DOCUMENT_STATUSES = ["PENDING_UPLOAD", "AVAILABLE", "DELETED"] as const;
export const documentCategory = z.enum(DOCUMENT_CATEGORIES);

/** Allow-list; anything else is rejected before a URL is signed. */
export const DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/dicom",
] as const;
/** Mirrors apps/api StorageService MAX_UPLOAD_BYTES (the storage layer enforces it too). */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const fileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // No path separators or control characters (code points < 0x20, DEL).
  .refine(
    (n) => ![...n].some((c) => c === "/" || c === "\\" || c.charCodeAt(0) < 32 || c === "\x7f"),
    "Invalid file name",
  );

export const requestUploadRequest = z.object({
  patientId: uuid,
  /** Branch the document is filed under; must be in the caller's scope (`document:write`). */
  branchId: uuid,
  fileName,
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  category: documentCategory.default("OTHER"),
  description: optionalText(500),
});
export type RequestUploadRequest = z.infer<typeof requestUploadRequest>;

/** Presigned POST: the client posts `fields` + file to `url` before `expiresAt`, then confirms. */
export const requestUploadResponse = z.object({
  documentId: uuid,
  url: z.string(),
  fields: z.record(z.string(), z.string()),
  expiresAt: isoDateTime,
});
export type RequestUploadResponse = z.infer<typeof requestUploadResponse>;

export const confirmUploadRequest = z.object({
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ConfirmUploadRequest = z.infer<typeof confirmUploadRequest>;

export const listDocumentsQuery = pageQuery.extend({
  patientId: uuid,
  category: documentCategory.optional(),
  branchId: uuid.optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuery>;

export const documentResponse = z.object({
  id: uuid,
  patientId: uuid,
  branchId: uuid,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  category: documentCategory,
  description: z.string().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  uploadedBy: z.string(),
  createdAt: isoDateTime,
  /** M2: encounter the document (X-ray, photo) is attached to. Optional until the API returns it. */
  encounterId: uuid.nullable().optional(),
  /** Stored since 0005; optional until the API returns it. */
  deletedReason: z.string().nullable().optional(),
});
export type DocumentResponse = z.infer<typeof documentResponse>;

export const downloadUrlResponse = z.object({ url: z.string(), expiresInSeconds: z.number() });

/** Soft delete (status DELETED); the object is retained per retention policy. */
export const deleteDocumentRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type DeleteDocumentRequest = z.infer<typeof deleteDocumentRequest>;
