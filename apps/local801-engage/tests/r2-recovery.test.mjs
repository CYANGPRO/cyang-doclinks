import assert from "node:assert/strict";
import test from "node:test";
import { assertOpaqueRecoveryObject, getR2RecoveryConfiguration } from "../scripts/lib/r2-recovery-policy.mjs";

function environment(overrides = {}) {
  return {
    LOCAL801_R2_RECOVERY_SOURCE_ACCOUNT_ID: "source123",
    LOCAL801_R2_RECOVERY_SOURCE_ENDPOINT: "https://source123.r2.cloudflarestorage.com",
    LOCAL801_R2_RECOVERY_SOURCE_BUCKET: "local801-production-private",
    LOCAL801_R2_RECOVERY_DESTINATION_ACCOUNT_ID: "destination456",
    LOCAL801_R2_RECOVERY_DESTINATION_ENDPOINT: "https://destination456.r2.cloudflarestorage.com",
    LOCAL801_R2_RECOVERY_DESTINATION_BUCKET: "local801-production-recovery",
    ...overrides,
  };
}

test("R2 recovery inventory is bounded and uses distinct CAT-only private endpoints", () => {
  const config = getR2RecoveryConfiguration(environment(), "inventory");
  assert.equal(config.batchSize, 25);
  assert.equal(config.prefix, "local801/");
  assert.throws(() => getR2RecoveryConfiguration(environment({ LOCAL801_R2_RECOVERY_DESTINATION_BUCKET: "local801-production-private" }), "inventory"), /distinct/);
  assert.throws(() => getR2RecoveryConfiguration(environment({ LOCAL801_R2_RECOVERY_SOURCE_ENDPOINT: "https://public.r2.dev" }), "inventory"), /private R2/);
});

test("R2 ciphertext copy requires explicit opt-in and exact typed bucket confirmation", () => {
  assert.throws(() => getR2RecoveryConfiguration(environment(), "copy"), /opt-in/);
  const accepted = getR2RecoveryConfiguration(environment({
    LOCAL801_R2_RECOVERY_COPY: "1",
    LOCAL801_R2_RECOVERY_CONFIRMATION: "COPY LOCAL801 CIPHERTEXT local801-production-private TO local801-production-recovery",
  }), "copy");
  assert.equal(accepted.mode, "copy");
  assert.throws(() => getR2RecoveryConfiguration(environment({
    LOCAL801_R2_RECOVERY_COPY: "1", LOCAL801_R2_RECOVERY_CONFIRMATION: "COPY",
  }), "copy"), /does not match/);
});

test("R2 recovery rejects unbounded batches and object sizes", () => {
  assert.throws(() => getR2RecoveryConfiguration(environment({ LOCAL801_R2_RECOVERY_BATCH_SIZE: "101" }), "dry-run"), /bound is invalid/);
  assert.throws(() => getR2RecoveryConfiguration(environment({ LOCAL801_R2_RECOVERY_MAX_OBJECT_BYTES: String(101 * 1024 * 1024) }), "dry-run"), /bound is invalid/);
});

test("R2 recovery accepts only bounded opaque CAT object keys", () => {
  const accepted = assertOpaqueRecoveryObject({
    Key: "local801/documents/2026/08/11111111-1111-4111-8111-111111111111",
    Size: 4096,
  }, 8192);
  assert.equal(accepted.Size, 4096);
  assert.throws(() => assertOpaqueRecoveryObject({ Key: "local801/documents/member-name.pdf", Size: 1 }, 8192), /invalid opaque/);
  assert.throws(() => assertOpaqueRecoveryObject({ Key: accepted.Key, Size: 8193 }, 8192), /invalid opaque/);
});

test("R2 recovery implementation uses separate credentials, explicit retries, checksum metadata, and zeroizes ciphertext", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/recover-r2-objects.mjs", import.meta.url), "utf8"));
  assert.match(source, /separate source-read and destination-write credentials/);
  assert.match(source, /maxAttempts: 4/);
  assert.match(source, /retryMode: "standard"/);
  assert.match(source, /local801-recovery-sha256/);
  assert.match(source, /checksumSha256/);
  assert.match(source, /finally\s*\{\s*ciphertext\.fill\(0\)/);
  assert.doesNotMatch(source, /DeleteObjectCommand|--delete/);
});
