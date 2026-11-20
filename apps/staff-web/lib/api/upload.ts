import type { DocumentResponse, RequestUploadRequest } from "@dentalos/validation";
import { MOCK_MODE } from "./client";
import { api } from "./endpoints";
import { ApiError } from "./errors";

async function sha256Hex(file: Blob): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined; // integrity hash is optional; never block an upload on it
  }
}

/**
 * Presigned upload: 1) POST /documents/uploads (row created PENDING_UPLOAD, returns a signed URL),
 * 2) PUT the file straight to object storage, 3) POST /documents/:id/confirm (row → AVAILABLE).
 * The file never passes through the API server.
 */
export async function uploadDocument(
  file: File,
  meta: Omit<RequestUploadRequest, "fileName" | "contentType" | "sizeBytes">,
  onStage?: (stage: "requesting" | "uploading" | "confirming") => void,
): Promise<DocumentResponse> {
  onStage?.("requesting");
  const signed = await api.documents.requestUpload({
    ...meta,
    fileName: file.name,
    contentType: file.type as RequestUploadRequest["contentType"],
    sizeBytes: file.size,
  });
  onStage?.("uploading");
  if (!MOCK_MODE) {
    // The API signs a PUT (current contract). A presigned POST (non-empty `fields`) is also handled.
    const usePost = Object.keys(signed.fields ?? {}).length > 0;
    let res: Response;
    try {
      if (usePost) {
        const form = new FormData();
        for (const [k, v] of Object.entries(signed.fields)) form.append(k, v);
        form.append("file", file);
        res = await fetch(signed.url, { method: "POST", body: form });
      } else {
        res = await fetch(signed.url, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": file.type,
            ...((signed as { headers?: Record<string, string> }).headers ?? {}),
          },
        });
      }
    } catch {
      throw new ApiError({ kind: "network", status: 0, message: "Upload to storage failed." });
    }
    if (!res.ok)
      throw new ApiError({
        kind: "server",
        status: res.status,
        message: "Storage rejected the upload. Try again.",
      });
  }
  onStage?.("confirming");
  return api.documents.confirm(signed.documentId, await sha256Hex(file));
}
