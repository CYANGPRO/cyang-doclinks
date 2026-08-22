const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const opaqueObjectKeyPattern = /^local801\/(documents|imports|reports)\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`R2 recovery requires ${name}.`);
  return value;
}

function privateEndpoint(value, accountId, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} endpoint is invalid.`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port
    || (parsed.pathname !== "" && parsed.pathname !== "/") || parsed.search || parsed.hash
    || parsed.hostname.toLowerCase() !== `${accountId.toLowerCase()}.r2.cloudflarestorage.com`) {
    throw new Error(`${label} endpoint is not the exact private R2 account endpoint.`);
  }
  return parsed.origin;
}

export function getR2RecoveryConfiguration(env = process.env, mode = "inventory") {
  if (!new Set(["inventory", "dry-run", "copy"]).has(mode)) throw new Error("R2 recovery mode is invalid.");
  const sourceAccountId = required(env, "LOCAL801_R2_RECOVERY_SOURCE_ACCOUNT_ID");
  const destinationAccountId = required(env, "LOCAL801_R2_RECOVERY_DESTINATION_ACCOUNT_ID");
  const sourceBucket = required(env, "LOCAL801_R2_RECOVERY_SOURCE_BUCKET");
  const destinationBucket = required(env, "LOCAL801_R2_RECOVERY_DESTINATION_BUCKET");
  if (!bucketPattern.test(sourceBucket) || !bucketPattern.test(destinationBucket)
    || !sourceBucket.startsWith("local801-") || !destinationBucket.startsWith("local801-")
    || sourceBucket === destinationBucket) {
    throw new Error("R2 recovery requires distinct, explicitly CAT-named buckets.");
  }
  const sourceEndpoint = privateEndpoint(required(env, "LOCAL801_R2_RECOVERY_SOURCE_ENDPOINT"), sourceAccountId, "Source");
  const destinationEndpoint = privateEndpoint(required(env, "LOCAL801_R2_RECOVERY_DESTINATION_ENDPOINT"), destinationAccountId, "Destination");
  const batchSize = Number(env.LOCAL801_R2_RECOVERY_BATCH_SIZE ?? "25");
  const maximumBytes = Number(env.LOCAL801_R2_RECOVERY_MAX_OBJECT_BYTES ?? String(32 * 1024 * 1024));
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 100 * 1024 * 1024) {
    throw new Error("R2 recovery batch or object bound is invalid.");
  }
  if (mode === "copy") {
    if (env.LOCAL801_R2_RECOVERY_COPY !== "1") throw new Error("R2 recovery copy opt-in is missing.");
    const expected = `COPY LOCAL801 CIPHERTEXT ${sourceBucket} TO ${destinationBucket}`;
    if (env.LOCAL801_R2_RECOVERY_CONFIRMATION !== expected) throw new Error("R2 recovery typed confirmation does not match the exact buckets.");
  }
  return Object.freeze({ mode, sourceAccountId, destinationAccountId, sourceBucket, destinationBucket,
    sourceEndpoint, destinationEndpoint, batchSize, maximumBytes, prefix: "local801/" });
}

export function getR2RecoveryKeyReadTestConfiguration(env = process.env) {
  const base = getR2RecoveryConfiguration(env, "inventory");
  if (env.LOCAL801_R2_RECOVERY_KEY_READ_TEST !== "1") {
    throw new Error("R2 recovery key-read test opt-in is missing.");
  }
  const expected = `TEST AND CLEAN LOCAL801 ENCRYPTED OBJECT ${base.sourceBucket} TO ${base.destinationBucket}`;
  if (env.LOCAL801_R2_RECOVERY_KEY_READ_CONFIRMATION !== expected) {
    throw new Error("R2 recovery key-read typed confirmation does not match the exact buckets.");
  }
  return Object.freeze({ ...base, mode: "key-read-test" });
}

export function assertOpaqueRecoveryObject(entry, maximumBytes) {
  if (!entry || typeof entry.Key !== "string" || !opaqueObjectKeyPattern.test(entry.Key)
    || !Number.isSafeInteger(entry.Size) || entry.Size < 0 || entry.Size > maximumBytes) {
    throw new Error("R2 recovery source inventory contains an invalid opaque encrypted-object record.");
  }
  return Object.freeze({ Key: entry.Key, Size: entry.Size });
}

export const __testing = { bucketPattern, opaqueObjectKeyPattern };
