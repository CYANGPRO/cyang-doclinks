import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertOpaqueRecoveryObject, getR2RecoveryConfiguration } from "./lib/r2-recovery-policy.mjs";

const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "inventory";
const config = getR2RecoveryConfiguration(process.env, mode);

function client(endpoint, accessKeyIdName, secretName) {
  const accessKeyId = process.env[accessKeyIdName];
  const secretAccessKey = process.env[secretName];
  if (!accessKeyId || !secretAccessKey) throw new Error("R2 recovery credentials are incomplete.");
  return new S3Client({ endpoint, region: "auto", maxAttempts: 4, retryMode: "standard", credentials: { accessKeyId, secretAccessKey } });
}

if (process.env.LOCAL801_R2_RECOVERY_SOURCE_ACCESS_KEY_ID
  && process.env.LOCAL801_R2_RECOVERY_SOURCE_ACCESS_KEY_ID === process.env.LOCAL801_R2_RECOVERY_DESTINATION_ACCESS_KEY_ID) {
  throw new Error("R2 recovery requires separate source-read and destination-write credentials.");
}
const source = client(config.sourceEndpoint, "LOCAL801_R2_RECOVERY_SOURCE_ACCESS_KEY_ID", "LOCAL801_R2_RECOVERY_SOURCE_SECRET_ACCESS_KEY");
const destination = client(config.destinationEndpoint, "LOCAL801_R2_RECOVERY_DESTINATION_ACCESS_KEY_ID", "LOCAL801_R2_RECOVERY_DESTINATION_SECRET_ACCESS_KEY");

function keyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function boundedBody(body, maximumBytes, declaredLength) {
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maximumBytes) {
    throw new Error("Recovery source object size is invalid or exceeds the configured bound.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body ?? []) {
    const buffered = Buffer.from(chunk);
    total += buffered.byteLength;
    if (total > maximumBytes) throw new Error("Recovery source object exceeded the configured bound.");
    chunks.push(buffered);
  }
  if (total !== declaredLength) throw new Error("Recovery source object size changed during read.");
  return Buffer.concat(chunks, total);
}

async function copyObject(entry) {
  const sourceObject = await source.send(new GetObjectCommand({ Bucket: config.sourceBucket, Key: entry.Key }));
  const ciphertext = await boundedBody(sourceObject.Body, config.maximumBytes, sourceObject.ContentLength);
  const checksum = createHash("sha256").update(ciphertext).digest("hex");
  try {
    const metadata = { ...(sourceObject.Metadata ?? {}), "local801-recovery-sha256": checksum };
    await destination.send(new PutObjectCommand({
      Bucket: config.destinationBucket, Key: entry.Key, Body: ciphertext,
      ContentType: sourceObject.ContentType ?? "application/octet-stream", Metadata: metadata,
    }));
    const verified = await destination.send(new HeadObjectCommand({ Bucket: config.destinationBucket, Key: entry.Key }));
    if (verified.ContentLength !== sourceObject.ContentLength || verified.Metadata?.["local801-recovery-sha256"] !== checksum) {
      throw new Error("Recovery destination verification failed.");
    }
    return { checksum, metadataFieldCount: Object.keys(metadata).length };
  } finally {
    ciphertext.fill(0);
  }
}

try {
  const listed = await source.send(new ListObjectsV2Command({
    Bucket: config.sourceBucket, Prefix: config.prefix, MaxKeys: config.batchSize,
  }));
  const objects = (listed.Contents ?? []).map((entry) => assertOpaqueRecoveryObject(entry, config.maximumBytes));
  const results = [];
  for (const entry of objects) {
    const record = { keyFingerprint: keyFingerprint(entry.Key), byteSize: entry.Size ?? null, status: mode === "copy" ? "pending" : mode };
    if (mode === "copy") {
      const copied = await copyObject(entry);
      record.status = "verified";
      record.checksumSha256 = copied.checksum;
      record.metadataFieldCount = copied.metadataFieldCount;
    }
    results.push(record);
  }
  console.log(JSON.stringify({ mode, objectCount: results.length, truncated: Boolean(listed.IsTruncated), objects: results }));
} catch (error) {
  console.error(JSON.stringify({ mode, status: "failed", reason: error instanceof Error ? error.message : "R2 recovery failed safely." }));
  process.exitCode = 1;
} finally {
  source.destroy();
  destination.destroy();
}
