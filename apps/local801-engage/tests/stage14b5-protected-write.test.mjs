import assert from "node:assert/strict";
import test from "node:test";
import {
  augmentPiiProtectedTransactionStatements,
  preparePiiProtectedDirectQuery,
  __testing,
} from "../src/lib/pii-protected-write.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const sheetId = "44444444-4444-4444-8444-444444444444";
const rowId = "55555555-5555-4555-8555-555555555555";
const fileId = "66666666-6666-4666-8666-666666666666";

function env() {
  return {
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 17).toString("base64") }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 19).toString("base64") }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  };
}

test("protected import-row transaction removes all direct PII from normalized_json and replaces unkeyed row hash", () => {
  const rows = [{
    id: rowId,
    source_row_number: 2,
    row_hash: "a".repeat(64),
    normalized_json: {
      first_name: "SyntheticGiven",
      last_name: "Cipherlastname",
      preferred_name: "SynAlias",
      work_email: "cipher.person@example.test",
      employee_identifier: "EMPL-42",
      member_identifier: "MEM-42",
      department: "Health Licensing",
      classification: "Clerical",
      membership_status: "member",
    },
  }];
  const statements = augmentPiiProtectedTransactionStatements([{
    sql: `INSERT INTO local801.import_rows (organization_id, import_sheet_id, normalized_json) SELECT $1::uuid, $2::uuid, source.normalized_json FROM jsonb_to_recordset($3::jsonb) source(normalized_json jsonb)`,
    parameters: [organizationId, sheetId, JSON.stringify(rows)],
  }], env());
  assert.equal(statements.length >= 4, true);
  const transformed = statements.find((item) => /INSERT INTO local801\.import_rows/.test(item.sql));
  assert.ok(transformed);
  const payload = JSON.parse(transformed.parameters[2]);
  const normalized = payload[0].normalized_json;
  for (const field of ["first_name", "last_name", "preferred_name", "work_email", "employee_identifier", "member_identifier"]) {
    assert.equal(Object.hasOwn(normalized, field), false, field);
  }
  assert.equal(normalized.department, "Health Licensing");
  assert.match(payload[0].row_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(payload[0].row_hash, "a".repeat(64));
  const serialized = JSON.stringify(statements);
  for (const value of ["SyntheticGiven", "Cipherlastname", "SynAlias", "cipher.person@example.test", "EMPL-42", "MEM-42"]) {
    assert.equal(serialized.includes(value), false, value);
  }
  assert.match(serialized, /direct_pii_encrypted_payload/);
  assert.match(serialized, /pii_exact_indexes/);
});

test("protected user provisioning stores non-PII placeholders in legacy columns and protected companions separately", () => {
  const original = {
    sql: `INSERT INTO local801.users (id, organization_id, email, display_name, invited_at, invited_by) SELECT $4::uuid, $1::uuid, $5::text, $7::text, now(), $2::uuid`,
    parameters: [organizationId, "77777777-7777-4777-8777-777777777777", "role", userId, "real.user@example.test", "role-id", "Real User"],
  };
  const statements = augmentPiiProtectedTransactionStatements([original], env());
  const legacy = statements.find((item) => /INSERT INTO local801\.users/.test(item.sql));
  assert.ok(legacy);
  assert.equal(legacy.parameters[4], `protected-${userId}@invalid.local`);
  assert.equal(legacy.parameters[6], `Protected user ${userId}`);
  const serialized = JSON.stringify(statements);
  assert.equal(serialized.includes("real.user@example.test"), false);
  assert.equal(serialized.includes("Real User"), false);
  assert.match(serialized, /user_pii/);
  const indexes = statements.find((item) => /pii_exact_indexes/.test(item.sql));
  assert.ok(indexes);
  assert.match(String(indexes.parameters?.[0]), /user:email/);
});

test("protected import-file direct write never sends the source filename to PostgreSQL", () => {
  const prepared = preparePiiProtectedDirectQuery(
    "INSERT INTO local801.import_files (organization_id, import_batch_id, original_filename, media_type, byte_size, storage_key, encryption_key_version, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [organizationId, batchId, "Avery roster.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 100, "key", "v1", "b".repeat(64)],
    env(),
    () => fileId,
  );
  assert.ok(prepared);
  assert.equal(prepared.parameters.includes("Avery roster.xlsx"), false);
  assert.equal(prepared.parameters[2], `protected-${fileId}.upload`);
  assert.match(prepared.sql, /import_file_pii/);
});

test("unsupported legacy PII mutations fail closed in protected-only mode", () => {
  assert.throws(() => augmentPiiProtectedTransactionStatements([{
    sql: "UPDATE local801.people SET first_name = $1 WHERE id = $2::uuid",
    parameters: ["Raw Name", rowId],
  }], env()), /unsupported legacy PII transaction/);
  assert.equal(__testing.isLegacyPiiMutation("UPDATE local801.people SET first_name = $1 WHERE id = $2"), true);
});
