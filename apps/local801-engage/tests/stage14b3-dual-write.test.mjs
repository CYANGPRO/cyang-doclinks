import test from "node:test";
import assert from "node:assert/strict";
import {
  augmentPiiDualWriteTransactionStatements,
  preparePiiDualWriteDirectQuery,
  validatePiiDualWriteEnvironment,
} from "../src/lib/pii-dual-write.ts";
import {
  serializeBackfillImportRow,
  serializeBackfillUser,
} from "../src/lib/pii-backfill-serialization.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";
const ROW = "55555555-5555-4555-8555-555555555555";
const ENC = Buffer.alloc(32, 17).toString("base64");
const IDX = Buffer.alloc(32, 29).toString("base64");

function env(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "1",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: ENC }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: IDX }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
    ...overrides,
  };
}

test("dual-write environment fails closed in Vercel Production", () => {
  assert.throws(() => validatePiiDualWriteEnvironment(env({ VERCEL_ENV: "production" })), /never allowed/i);
});

test("non-PII transactions remain unchanged without loading PII keys", () => {
  const statements = [{ sql: "update local801.users set auth_session_version=auth_session_version+1 where id=$1", parameters: [USER] }];
  const result = augmentPiiDualWriteTransactionStatements(statements, {
    VERCEL_ENV: "preview",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "1",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
  });
  assert.equal(result, statements);
});

test("team provisioning is augmented atomically with encrypted user PII and email blind index", () => {
  const legacy = {
    sql: "INSERT INTO local801.users (id, organization_id, email, display_name, invited_at, invited_by) SELECT $4,$1,$5,$7,now(),$2",
    parameters: [ORG, USER, "local_admin", USER, "synthetic.new@example.test", "cat_member", "Synthetic New"],
  };
  const result = augmentPiiDualWriteTransactionStatements([legacy], env());
  assert.equal(result.length, 4);
  assert.match(result[0].sql, /pii-dual-write:gate/);
  assert.equal(result[1], legacy);
  assert.match(result[2].sql, /INSERT INTO local801\.user_pii/i);
  assert.match(result[3].sql, /INSERT INTO local801\.pii_exact_indexes/i);
  const protectedParameters = JSON.stringify([result[2].parameters, result[3].parameters]);
  assert.doesNotMatch(protectedParameters, /synthetic\.new@example\.test/i);
  assert.doesNotMatch(protectedParameters, /Synthetic New/);
  assert.match(String(result[2].parameters?.[2]), /^p1\./);
});

test("import-row transaction receives protected row bundle and keyed exact indexes", () => {
  const payload = JSON.stringify([{
    id: ROW,
    source_row_number: 2,
    row_hash: "a".repeat(64),
    normalized_json: {
      first_name: "Synthetic",
      last_name: "Member",
      work_email: "synthetic.member@example.test",
      employee_identifier: "EMP-801",
      department: "Test Department",
    },
    state: "pending",
  }]);
  const legacy = {
    sql: "INSERT INTO local801.import_rows (id, organization_id, import_sheet_id, source_row_number, row_hash, normalized_json, state) SELECT source.id, $1, $2, source.source_row_number, source.row_hash, source.normalized_json, source.state FROM jsonb_to_recordset($3::jsonb) source",
    parameters: [ORG, FILE, payload],
  };
  const result = augmentPiiDualWriteTransactionStatements([legacy], env());
  assert.equal(result.length, 4);
  assert.match(result[2].sql, /INSERT INTO local801\.import_row_pii/i);
  assert.match(result[3].sql, /INSERT INTO local801\.pii_exact_indexes/i);
  const protectedParameters = JSON.stringify([result[2].parameters, result[3].parameters]);
  assert.doesNotMatch(protectedParameters, /synthetic\.member@example\.test/i);
  assert.doesNotMatch(protectedParameters, /EMP-801/);
  assert.doesNotMatch(protectedParameters, /Synthetic/);
});

test("import-file direct write is rewritten to commit legacy and protected metadata together", () => {
  const prepared = preparePiiDualWriteDirectQuery(
    "INSERT INTO local801.import_files (organization_id, import_batch_id, original_filename, media_type, byte_size, storage_key, encryption_key_version, sha256) SELECT $1,$2,$3,$4,$5,$6,$7,$8 RETURNING id",
    [ORG, BATCH, "Synthetic Roster.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 1234, "imports/test", "v1", "b".repeat(64)],
    env(),
    () => FILE,
  );
  assert.ok(prepared);
  assert.match(prepared.sql, /inserted_file/i);
  assert.match(prepared.sql, /INSERT INTO local801\.import_file_pii/i);
  assert.equal(prepared.parameters[8], FILE);
  assert.match(String(prepared.parameters[9]), /^p1\./);
  assert.notEqual(prepared.parameters[9], "Synthetic Roster.xlsx");
});

test("unsupported legacy person mutation is blocked while dual write is enabled", () => {
  assert.throws(() => augmentPiiDualWriteTransactionStatements([{
    sql: "INSERT INTO local801.people (id, organization_id, first_name, last_name) VALUES ($1,$2,$3,$4)",
    parameters: [USER, ORG, "Synthetic", "Unsafe"],
  }], env()), /unsupported legacy PII transaction/i);
});

test("backfill serializers explicitly translate camelCase planner rows to SQL snake_case", () => {
  const user = serializeBackfillUser({
    organizationId: ORG,
    userId: USER,
    emailEncryptedPayload: "p1.example",
    emailEncryptionKeyVersion: "v1",
    emailEncryptionFormatVersion: 1,
    displayNameEncryptedPayload: "p1.example2",
    displayNameEncryptionKeyVersion: "v1",
    displayNameEncryptionFormatVersion: 1,
  });
  assert.deepEqual(Object.keys(user), [
    "organization_id", "user_id", "email_encrypted_payload", "email_encryption_key_version",
    "email_encryption_format_version", "display_name_encrypted_payload",
    "display_name_encryption_key_version", "display_name_encryption_format_version",
  ]);

  const importRow = serializeBackfillImportRow({
    organizationId: ORG,
    importRowId: ROW,
    encryptedPayload: "p1.bundle",
    encryptionKeyVersion: "v1",
    encryptionFormatVersion: 1,
    fieldSetVersion: 1,
    integrityHash: "c".repeat(64),
    integrityKeyVersion: "v1",
  });
  assert.equal(importRow.import_row_id, ROW);
  assert.equal(importRow.integrity_hash, "c".repeat(64));
  assert.equal(importRow.organizationId, undefined);
});
