import "server-only";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { STORAGE_UNAVAILABLE_MESSAGE, storageFailure, type StorageFailure } from "@stage-ready/shared";
import { logger } from "./ai";
import { ApiError } from "./api";
import { env } from "./env";

const g = globalThis as unknown as { stageReadyS3?: S3Client; stageReadyBucket?: Promise<void> | undefined; stageReadyStorageCheck?: { at: number; result: StorageHealth } };

/** S3 refused or could not be reached: a 503 with the friendly message; the raw error is only logged. */
export class StorageUnavailable extends ApiError {
  constructor(readonly reason: StorageFailure) {
    super(503, "storage_unavailable", STORAGE_UNAVAILABLE_MESSAGE);
    this.name = "StorageUnavailable";
  }
}

function client(): S3Client {
  const e = env();
  g.stageReadyS3 ??= new S3Client({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY } });
  return g.stageReadyS3;
}

async function guard<T>(op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof StorageUnavailable) throw err;
    const reason = storageFailure(err);
    logger.error({ err, op, reason }, "storage call failed");
    throw new StorageUnavailable(reason);
  }
}

function ensureBucket(): Promise<void> {
  g.stageReadyBucket ??= guard("ensure-bucket", () =>
    client()
      .send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }))
      .then(
        () => undefined,
        async () => void (await client().send(new CreateBucketCommand({ Bucket: env().S3_BUCKET }))),
      ),
  ).catch((err) => {
    g.stageReadyBucket = undefined; // retry on the next call once the secret is fixed
    throw err;
  });
  return g.stageReadyBucket;
}

/** A presigned PUT, valid for 15 minutes. The browser uploads straight to S3/R2. */
export async function presignPut(key: string, contentType: string): Promise<{ url: string; key: string; expiresIn: number }> {
  await ensureBucket();
  const expiresIn = 900;
  const url = await guard("presign-put", () => getSignedUrl(client(), new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn }));
  return { url, key, expiresIn };
}

/** A presigned GET, valid for 15 minutes, for an s3:// URI in this project's bucket. */
export async function presignGet(uri: string, expiresIn = 900): Promise<string | null> {
  const prefix = `s3://${env().S3_BUCKET}/`;
  if (!uri.startsWith(prefix)) return null;
  return guard("presign-get", () => getSignedUrl(client(), new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: uri.slice(prefix.length) }), { expiresIn }));
}

/** A JSON object from the bucket, or null if it is missing or storage does not answer within `timeoutMs`. */
export async function getJson<T>(key: string, timeoutMs = 1_500): Promise<T | null> {
  try {
    const out = await client().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    const text = await out.Body?.transformToString();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

export const s3Uri = (key: string) => `s3://${env().S3_BUCKET}/${key}`;

export type StorageHealth = { ok: true } | { ok: false; reason: StorageFailure };

/** HEAD on the bucket with the configured keys, cached for 30 s so health checks do not hammer S3. */
export async function storageHealth(): Promise<StorageHealth> {
  const cached = g.stageReadyStorageCheck;
  if (cached && Date.now() - cached.at < 30_000) return cached.result;
  let result: StorageHealth;
  try {
    await client().send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }), { abortSignal: AbortSignal.timeout(5_000) });
    result = { ok: true };
  } catch (err) {
    const reason = storageFailure(err);
    logger.warn({ err, reason }, "storage health check failed");
    result = { ok: false, reason };
  }
  g.stageReadyStorageCheck = { at: Date.now(), result };
  return result;
}
