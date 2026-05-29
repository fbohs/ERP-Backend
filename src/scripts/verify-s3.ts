/**
 * One-shot S3 connectivity check. Run via:
 *   node --env-file-if-exists=.env.local --import tsx/esm src/scripts/verify-s3.ts
 *
 * Deletes the test object on success. Safe to run repeatedly.
 */
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../shared/config/index.js';

const TEST_KEY = `_verify/s3-check-${Date.now()}.txt`;
const TEST_BODY = 'erp-s3-verify-ok';

const out = (msg: string) => process.stdout.write(msg + '\n');
const err = (msg: string, e?: unknown) => {
  process.stderr.write(`  ❌  ${msg}\n`);
  if (e) process.stderr.write(String(e) + '\n');
  process.exit(1);
};

async function run() {
  out('\n── AWS S3 Verification ─────────────────────────────────');
  out(`  region : ${config.awsRegion}`);
  out(`  bucket : ${config.awsS3Bucket}`);
  out(`  key id : ${config.awsAccessKeyId.slice(0, 4)}${'*'.repeat(12)}`);
  out('────────────────────────────────────────────────────────\n');

  if (!config.awsS3Bucket) err('AWS_S3_BUCKET is not set in .env.local');
  if (!config.awsAccessKeyId) err('AWS_ACCESS_KEY_ID is not set in .env.local');
  if (!config.awsSecretAccessKey) err('AWS_SECRET_ACCESS_KEY is not set in .env.local');

  const client = new S3Client({
    region: config.awsRegion,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  });

  // 1. Bucket reachability
  out('1. Bucket reachability (HeadBucket)');
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.awsS3Bucket }));
    out(`  ✅  Bucket "${config.awsS3Bucket}" is accessible`);
  } catch (e) {
    err(`Cannot reach bucket — check bucket name, region, and IAM permissions`, e);
  }

  // 2. Presigned URL generation
  out('\n2. Presigned PUT URL generation');
  let uploadUrl: string;
  try {
    const cmd = new PutObjectCommand({
      Bucket: config.awsS3Bucket,
      Key: TEST_KEY,
      ContentType: 'text/plain',
    });
    uploadUrl = await getSignedUrl(client, cmd, { expiresIn: 300 });
    out(`  ✅  Presigned URL generated (expires in 5 min)`);
    out(`     ${uploadUrl.slice(0, 90)}…`);
  } catch (e) {
    err('Failed to generate presigned URL', e);
    return;
  }

  // 3. Upload via presigned URL (simulates what the browser does)
  out('\n3. Upload via presigned URL (PUT)');
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: TEST_BODY,
    });
    if (!res.ok) err(`S3 rejected the PUT — HTTP ${res.status}: ${await res.text()}`);
    out(`  ✅  Object uploaded (HTTP ${res.status})`);
  } catch (e) {
    err('fetch to presigned URL failed', e);
  }

  // 4. HeadObject — verify the object exists with expected size
  out('\n4. HeadObject (verify upload arrived)');
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: config.awsS3Bucket, Key: TEST_KEY }),
    );
    out(`  ✅  Object exists — size: ${head.ContentLength} bytes, type: ${head.ContentType}`);
    if (head.ContentLength !== Buffer.byteLength(TEST_BODY)) {
      process.stderr.write(
        `  ⚠️   Size mismatch: expected ${Buffer.byteLength(TEST_BODY)}, got ${head.ContentLength}\n`,
      );
    }
  } catch (e) {
    err('HeadObject failed — object may not have arrived', e);
  }

  // 5. Delete (cleanup)
  out('\n5. Cleanup (DeleteObject)');
  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.awsS3Bucket, Key: TEST_KEY }));
    out(`  ✅  Test object deleted`);
  } catch (e) {
    process.stderr.write(
      `  ⚠️   Delete failed — test object left in bucket at: ${TEST_KEY}\n${String(e)}\n`,
    );
  }

  out('\n── All checks passed ───────────────────────────────────\n');
}

run().catch((e) => {
  process.stderr.write('\nUnhandled error:\n' + String(e) + '\n');
  process.exit(1);
});
