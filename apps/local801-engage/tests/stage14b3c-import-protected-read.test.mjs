import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hydrateImportBatchQueueFromProtectedPii,
  hydrateImportBatchFromProtectedPii,
  hydrateImportReviewDetailFromProtectedPii,
} from "../src/lib/pii-protected-import-read.ts";
import { createPiiIntegrityHash, encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const importFileId = "33333333-3333-4333-8333-333333333333";
const importRowId = "44444444-4444-4444-8444-444444444444";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const blindKey = Buffer.alloc(32, 9).toString("base64");

function env(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "1",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: encryptionKey }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: blindKey }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
    ...overrides,
  };
}

function state(mode = "preview") {
  const cutover = mode === "protected" ? new Date().toISOString() : null;
  return [{
    write_mode: mode === "protected" ? "protected" : "dual",
    backfill_state: "complete",
    backfill_completed_at: new Date().toISOString(),
    protected_read_enabled_at: cutover,
    protected_write_enabled_at: cutover,
    verified_at: cutover,
  }];
}

function protectedImportFile(keyConfig, filename = "synthetic-roster.xlsx") {
  const encrypted = encryptPiiField(
    filename,
    { organizationId, entity: "import-file", recordId: importFileId, field: "original-filename" },
    keyConfig,
  );
  return {
    batch_id: batchId,
    import_file_id: importFileId,
    original_filename_encrypted_payload: encrypted.encryptedPayload,
    encryption_key_version: encrypted.encryptionKeyVersion,
    encryption_format_version: encrypted.encryptionFormatVersion,
  };
}

function protectedImportRow(keyConfig, values = {
  first_name: "Synthetic",
  last_name: "Avery",
  work_email: "avery.morgan@example.test",
}) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
  const encrypted = encryptPiiField(
    canonical,
    { organizationId, entity: "import-row", recordId: importRowId, field: "direct-pii" },
    keyConfig,
  );
  const integrity = createPiiIntegrityHash(canonical, { organizationId, domain: "import-row" }, keyConfig);
  return {
    sheet_name: "Roster",
    source_row_number: 2,
    import_row_id: importRowId,
    direct_pii_encrypted_payload: encrypted.encryptedPayload,
    encryption_key_version: encrypted.encryptionKeyVersion,
    encryption_format_version: encrypted.encryptionFormatVersion,
    direct_pii_field_set_version: 2,
    direct_pii_presence_mask: 11,
    direct_pii_validity_mask: 11,
    row_integrity_hash: integrity.blindIndex,
    row_integrity_key_version: integrity.blindIndexKeyVersion,
  };
}

function legacyBatch(filename = "WRONG-LEGACY-NAME.xlsx") {
  return {
    id: batchId,
    original_filename: filename,
    import_kind: "current_roster",
    state: "under_review",
  };
}

function legacyReviewDetail() {
  return {
    rows: [{
      sheet_name: "Roster",
      source_row_number: 2,
      category: "proposed_new",
      first_name: "WRONG",
      last_name: "LEGACY",
      work_email: "wrong@example.test",
      department: "Health Licensing",
      classification: "Clerical",
      membership_status: "member",
    }],
    nextCursor: null,
    pageSize: 50,
  };
}

test("import queue source filename is replaced from protected import_file_pii", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("queue-files")) return [protectedImportFile(keyConfig)];
    throw new Error("unexpected query");
  };
  const [result] = await hydrateImportBatchQueueFromProtectedPii(organizationId, [legacyBatch()], { query, env: environment, keyConfig });
  assert.equal(result.original_filename, "synthetic-roster.xlsx");
});

test("import detail source filename is replaced from protected import_file_pii", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("detail-file")) return [protectedImportFile(keyConfig, "synthetic-detail.csv")];
    throw new Error("unexpected query");
  };
  const result = await hydrateImportBatchFromProtectedPii(organizationId, legacyBatch(), { query, env: environment, keyConfig });
  assert.equal(result.original_filename, "synthetic-detail.csv");
});

test("import review display names and work email are replaced from protected import_row_pii", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("review-rows")) return [protectedImportRow(keyConfig)];
    throw new Error("unexpected query");
  };
  const result = await hydrateImportReviewDetailFromProtectedPii(organizationId, batchId, legacyReviewDetail(), { query, env: environment, keyConfig });
  assert.equal(result.rows[0].first_name, "Synthetic");
  assert.equal(result.rows[0].last_name, "Avery");
  assert.equal(result.rows[0].work_email, "avery.morgan@example.test");
  assert.equal(result.rows[0].department, "Health Licensing");
});

test("import filename and review direct PII continue to hydrate in verified protected-only mode", async () => {
  const environment = env({
    VERCEL_ENV: "production",
    LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "0",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
  });
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state("protected");
    if (sql.includes("detail-file")) return [protectedImportFile(keyConfig, "protected-roster.xlsx")];
    if (sql.includes("review-rows")) return [protectedImportRow(keyConfig)];
    throw new Error("unexpected query");
  };
  const batch = await hydrateImportBatchFromProtectedPii(organizationId, legacyBatch("protected-placeholder.upload"), { query, env: environment, keyConfig });
  const detail = await hydrateImportReviewDetailFromProtectedPii(organizationId, batchId, legacyReviewDetail(), { query, env: environment, keyConfig });
  assert.equal(batch.original_filename, "protected-roster.xlsx");
  assert.equal(detail.rows[0].first_name, "Synthetic");
  assert.equal(detail.rows[0].work_email, "avery.morgan@example.test");
});

test("protected import review rows fail closed when a displayed row lacks its companion", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("review-rows")) return [];
    throw new Error("unexpected query");
  };
  await assert.rejects(
    hydrateImportReviewDetailFromProtectedPii(organizationId, batchId, legacyReviewDetail(), { query, env: environment, keyConfig }),
    /missing its protected direct-PII companion/i,
  );
});

test("protected import review rows fail closed when integrity verification fails", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const protectedRow = { ...protectedImportRow(keyConfig), row_integrity_hash: "0".repeat(64) };
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("review-rows")) return [protectedRow];
    throw new Error("unexpected query");
  };
  await assert.rejects(
    hydrateImportReviewDetailFromProtectedPii(organizationId, batchId, legacyReviewDetail(), { query, env: environment, keyConfig }),
    /failed integrity verification/i,
  );
});

test("protected import queue filename reads fail closed when a visible legacy filename lacks a companion", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("queue-files")) return [];
    throw new Error("unexpected query");
  };
  await assert.rejects(
    hydrateImportBatchQueueFromProtectedPii(organizationId, [legacyBatch()], { query, env: environment, keyConfig }),
    /missing its protected source-filename companion/i,
  );
});

test("protected import detail filename reads fail closed when a visible legacy filename lacks a companion", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("acceptance-state")) return state();
    if (sql.includes("detail-file")) return [];
    throw new Error("unexpected query");
  };
  await assert.rejects(
    hydrateImportBatchFromProtectedPii(organizationId, legacyBatch(), { query, env: environment, keyConfig }),
    /missing its protected source-filename companion/i,
  );
});

test("Data Imports queue wires cutover-aware protected filename hydration", () => {
  const page = readFileSync(new URL("../src/app/imports/page.tsx", import.meta.url), "utf8");
  assert.match(page, /hydrateImportBatchQueueFromProtectedPii/);
  assert.match(page, /getPiiProtectedReadMode/);
  assert.match(page, /protectedReadMode = getPiiProtectedReadMode\(\)/);
  assert.match(page, /protectedReadMode !== "legacy"/);
  assert.match(page, /Imports unavailable/);
});

test("Data Imports detail wires cutover-aware filename, review rows, and protected execution", () => {
  const page = readFileSync(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /hydrateImportBatchFromProtectedPii/);
  assert.match(page, /hydrateImportReviewDetailFromProtectedPii/);
  assert.match(page, /getPiiProtectedReadMode/);
  assert.match(page, /Protected-read Preview/);
  assert.match(page, /Member information is protected/);
  assert.match(page, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED/);
  assert.match(page, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED/);
  assert.match(page, /mode=\{executionMode\}/);
  assert.match(page, /Import details unavailable/);
  assert.match(page, /batch = null/);
});
