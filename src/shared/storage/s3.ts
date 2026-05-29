import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index.js';

export const PRESIGN_TTL_SECONDS = 24 * 60 * 60;
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — enforced at confirm via HeadObject

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type AllowedMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return ALLOWED_MIME_TYPES.has(value);
}

function createClient(): S3Client {
  return new S3Client({
    region: config.awsRegion,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  });
}

// Lazy singleton — instantiated on first use so unit tests can stub config
// before the module resolves.
let _client: S3Client | null = null;
function getClient(): S3Client {
  _client ??= createClient();
  return _client;
}

export interface PresignedUpload {
  s3Key: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * Generate a presigned PUT URL for a direct client-to-S3 upload.
 * TTL matches the idempotency key TTL so cached responses stay valid.
 */
export async function generatePresignedPutUrl(
  s3Key: string,
  mimeType: AllowedMimeType,
): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: config.awsS3Bucket,
    Key: s3Key,
    ContentType: mimeType,
  });

  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: PRESIGN_TTL_SECONDS,
  });

  const expiresAt = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);
  return { s3Key, uploadUrl, expiresAt };
}

export interface ObjectMeta {
  sizeBytes: number;
  contentType: string | undefined;
}

/**
 * Fetch metadata for an S3 object. Returns null if the key does not exist.
 * Use this at confirm time to verify existence and enforce the size limit.
 */
export async function getObjectMeta(s3Key: string): Promise<ObjectMeta | null> {
  try {
    const res = await getClient().send(
      new HeadObjectCommand({ Bucket: config.awsS3Bucket, Key: s3Key }),
    );
    return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Build the public HTTPS URL for a confirmed S3 object.
 * Assumes the bucket is configured for public read or behind a CDN.
 */
export function buildObjectUrl(s3Key: string): string {
  return `https://${config.awsS3Bucket}.s3.${config.awsRegion}.amazonaws.com/${s3Key}`;
}

function isNotFoundError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name ?? '';
  const code = (err as { Code?: string }).Code ?? '';
  return name === 'NotFound' || code === 'NoSuchKey';
}
