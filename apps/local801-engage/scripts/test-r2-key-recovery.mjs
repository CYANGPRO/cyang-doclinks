import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { decryptEnvelope, encryptEnvelope } from "../src/lib/encryption.ts";
import { getR2RecoveryKeyReadTestConfiguration } from "./lib/r2-recovery-policy.mjs";

const config = getR2RecoveryKeyReadTestConfiguration(process.env);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`R2 key-read recovery requires ${name}.`);
  return value;
}

function client(endpoint, accessKeyIdName, secretName) {
  return new S3Client({
    endpoint,
    region: "auto",
    maxAttempts: 4,
    retryMode: "standard",
    credentials: {
      accessKeyId: required(accessKeyIdName),
      secretAccessKey: required(secretName),
    },
  });
}

const sourceReadId = required("LOCAL801_R2_RECOVERY_SOURCE_ACCESS_KEY_ID");
const sourceWriteId = required("LOCAL801_R2_RECOVERY_DRILL_SOURCE_ACCESS_KEY_ID");
const destinationId = required("LOCAL801_R2_RECOVERY_DESTINATION_ACCESS_KEY_ID");
if (new Set([sourceReadId, sourceWriteId, destinationId]).size !== 3) {
  throw new Error("R2 key-read recovery requires three distinct bucket-scoped credentials.");
}

const encryptionEnvironment = {
  LOCAL801_ENCRYPTION_MASTER_KEYS: required("LOCAL801_R2_RECOVERY_ENCRYPTION_MASTER_KEYS"),
  LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: required("LOCAL801_R2_RECOVERY_ACTIVE_ENCRYPTION_KEY_VERSION"),
};
const sourceReader = client(
  config.sourceEndpoint,
  "LOCAL801_R2_RECOVERY_SOURCE_ACCESS_KEY_ID",
  "LOCAL801_R2_RECOVERY_SOURCE_SECRET_ACCESS_KEY",
);
const sourceWriter = client(
  config.sourceEndpoint,
  "LOCAL801_R2_RECOVERY_DRILL_SOURCE_ACCESS_KEY_ID",
  "LOCAL801_R2_RECOVERY_DRILL_SOURCE_SECRET_ACCESS_KEY",
);
const destination = client(
  config.destinationEndpoint,
  "LOCAL801_R2_RECOVERY_DESTINATION_ACCESS_KEY_ID",
  "LOCAL801_R2_RECOVERY_DESTINATION_SECRET_ACCESS_KEY",
);

function keyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function boundedBody(response) {
  const declaredLength = response.ContentLength;
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > config.maximumBytes) {
    throw new Error("Synthetic recovery object size is invalid or exceeds the configured bound.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.Body ?? []) {
    const buffered = Buffer.from(chunk);
    total += buffered.byteLength;
    if (total > config.maximumBytes) throw new Error("Synthetic recovery object exceeded the configured bound.");
    chunks.push(buffered);
  }
  if (total !== declaredLength) throw new Error("Synthetic recovery object size changed during read.");
  return Buffer.concat(chunks, total);
}

function isMissing(error) {
  return error?.name === "NotFound" || error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

async function deleteAndConfirm(target, bucket, key) {
  await target.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  try {
    await target.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    throw new Error("Synthetic recovery object still exists after exact-key cleanup.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

const now = new Date();
const year = String(now.getUTCFullYear());
const month = String(now.getUTCMonth() + 1).padStart(2, "0");
const objectKey = `local801/reports/${year}/${month}/${randomUUID()}`;
const startedAt = Date.now();
let plaintext = Buffer.from(`local801-recovery-synthetic-v1:${randomBytes(32).toString("hex")}`, "utf8");
let encryptedPayload;
let sourceCiphertext;
let recoveredCiphertext;
let recoveredPlaintext;
let sourceCreated = false;
let destinationCreated = false;
let result;
let operationError;
const cleanupErrors = [];

try {
  const expectedPlaintextSha256 = createHash("sha256").update(plaintext).digest("hex");
  const encrypted = encryptEnvelope(plaintext, encryptionEnvironment);
  encryptedPayload = encrypted.payload;
  const ciphertextSha256 = createHash("sha256").update(encryptedPayload).digest("hex");

  await sourceWriter.send(new PutObjectCommand({
    Bucket: config.sourceBucket,
    Key: objectKey,
    Body: encryptedPayload,
    ContentType: "application/octet-stream",
    Metadata: {
      "local801-recovery-test": "synthetic-v1",
      "local801-encryption-key-version": encrypted.keyVersion,
    },
  }));
  sourceCreated = true;

  const sourceObject = await sourceReader.send(new GetObjectCommand({ Bucket: config.sourceBucket, Key: objectKey }));
  sourceCiphertext = await boundedBody(sourceObject);
  if (createHash("sha256").update(sourceCiphertext).digest("hex") !== ciphertextSha256) {
    throw new Error("Synthetic source ciphertext checksum verification failed.");
  }

  await destination.send(new PutObjectCommand({
    Bucket: config.destinationBucket,
    Key: objectKey,
    Body: sourceCiphertext,
    ContentType: "application/octet-stream",
    Metadata: {
      ...(sourceObject.Metadata ?? {}),
      "local801-recovery-sha256": ciphertextSha256,
    },
  }));
  destinationCreated = true;

  const destinationHead = await destination.send(new HeadObjectCommand({ Bucket: config.destinationBucket, Key: objectKey }));
  if (destinationHead.ContentLength !== sourceCiphertext.byteLength
    || destinationHead.Metadata?.["local801-recovery-sha256"] !== ciphertextSha256
    || destinationHead.Metadata?.["local801-recovery-test"] !== "synthetic-v1") {
    throw new Error("Synthetic recovery destination metadata verification failed.");
  }

  const destinationObject = await destination.send(new GetObjectCommand({ Bucket: config.destinationBucket, Key: objectKey }));
  recoveredCiphertext = await boundedBody(destinationObject);
  const decrypted = decryptEnvelope(recoveredCiphertext, encryptionEnvironment);
  recoveredPlaintext = decrypted.plaintext;
  const recoveredPlaintextSha256 = createHash("sha256").update(recoveredPlaintext).digest("hex");
  if (recoveredPlaintext.byteLength !== plaintext.byteLength
    || !timingSafeEqual(recoveredPlaintext, plaintext)
    || recoveredPlaintextSha256 !== expectedPlaintextSha256
    || decrypted.keyVersion !== encrypted.keyVersion) {
    throw new Error("Synthetic recovery key read or plaintext verification failed.");
  }

  result = {
    status: "verified",
    keyFingerprint: keyFingerprint(objectKey),
    encryptedByteSize: recoveredCiphertext.byteLength,
    plaintextSha256: expectedPlaintextSha256,
    encryptionKeyVersion: decrypted.keyVersion,
    durationMs: Date.now() - startedAt,
  };
} catch (error) {
  operationError = error;
} finally {
  if (destinationCreated) {
    try {
      await deleteAndConfirm(destination, config.destinationBucket, objectKey);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (sourceCreated) {
    try {
      await deleteAndConfirm(sourceWriter, config.sourceBucket, objectKey);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  plaintext?.fill(0);
  encryptedPayload?.fill(0);
  sourceCiphertext?.fill(0);
  recoveredCiphertext?.fill(0);
  recoveredPlaintext?.fill(0);
  sourceReader.destroy();
  sourceWriter.destroy();
  destination.destroy();
}

if (operationError || cleanupErrors.length > 0 || !result) {
  console.error(JSON.stringify({
    status: "failed",
    operation: operationError instanceof Error ? operationError.message : null,
    cleanup: cleanupErrors.map((error) => error instanceof Error ? error.message : "Cleanup failed safely."),
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ...result, cleanup: "source-and-destination-confirmed-absent" }));
}
