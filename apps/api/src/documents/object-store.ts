import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

let client: S3Client | undefined;

/** Same configuration as StorageService (env-driven: MinIO/SeaweedFS in dev, task role on AWS). */
function s3() {
  client ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-south-1",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials: process.env.S3_ENDPOINT
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY ?? "dev",
          secretAccessKey: process.env.S3_SECRET_KEY ?? "dev",
        }
      : undefined,
  });
  return client;
}

/**
 * Upload verification (HEAD) for the confirm step. StorageService has no HEAD method yet, so this
 * documents-local seam does it; tests replace `objectStore.head`. Callers must have already checked
 * the key belongs to the tenant (`StorageService.assertOwnKey`). Never call inside `withTenant`.
 */
export const objectStore = {
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const r = await s3().send(
        new HeadObjectCommand({ Bucket: process.env.S3_BUCKET ?? "dentalos-dev", Key: key }),
      );
      return { contentLength: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === "NotFound") return null;
      throw e;
    }
  },
};
