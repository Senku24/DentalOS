import { randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Principal } from "../auth/roles";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 60;
const UPLOAD_TTL_SECONDS = 300;

/**
 * Private-bucket access only through short-lived presigned URLs minted AFTER the caller has been
 * authorised (PRD 4.10: never public object URLs). Keys are tenant-prefixed and every key a caller
 * names is checked against that prefix, so a guessed/foreign key cannot be signed.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? "dentalos-dev";
    this.s3 = new S3Client({
      region: process.env.AWS_REGION ?? "ap-south-1",
      endpoint: process.env.S3_ENDPOINT, // MinIO/localstack in dev; unset on AWS
      forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      credentials: process.env.S3_ENDPOINT
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY ?? "dev",
            secretAccessKey: process.env.S3_SECRET_KEY ?? "dev",
          }
        : undefined, // default AWS chain (task role) in production
    });
  }

  static keyPrefix(tenantId: string) {
    return `t/${tenantId}/`;
  }

  /** Throws unless `key` belongs to the principal's tenant. Callers must still authorise the document. */
  assertOwnKey(p: Principal, key: string) {
    if (!key.startsWith(StorageService.keyPrefix(p.tenantId)) || key.includes("..")) {
      throw new ForbiddenException();
    }
  }

  async presignDownload(p: Principal, key: string) {
    this.assertOwnKey(p, key);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: DOWNLOAD_TTL_SECONDS,
    });
  }

  /** Presigned POST so the size limit is enforced by the storage layer, not trusted from the client. */
  async presignUpload(p: Principal, opts: { contentType: string; maxBytes?: number }) {
    const key = `${StorageService.keyPrefix(p.tenantId)}${randomUUID()}`;
    const max = Math.min(opts.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
    const post = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Expires: UPLOAD_TTL_SECONDS,
      Conditions: [
        ["content-length-range", 1, max],
        ["eq", "$Content-Type", opts.contentType],
      ],
      Fields: { "Content-Type": opts.contentType },
    });
    return { key, ...post };
  }
}
