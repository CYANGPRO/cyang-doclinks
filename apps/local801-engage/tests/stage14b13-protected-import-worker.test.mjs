import assert from "node:assert/strict";
import test from "node:test";
import { rewriteProtectedImportWorkerStatements } from "../src/lib/pii-protected-import-worker.ts";

const protectedEnv = { LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1" };

test("protected durable validation uses companion masks instead of direct import JSON", () => {
  const statements = rewriteProtectedImportWorkerStatements([{
    sql: `INSERT INTO local801.import_errors (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'identifier', 'Rows require an authoritative identifier; names are not used for merging.'
      FROM local801.import_rows row WHERE row.normalized_json ->> 'work_email' IS NULL`,
    parameters: ["org", "batch"],
  }, {
    sql: `INSERT INTO local801.import_errors (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'work_email', 'The work email format is invalid.'
      FROM local801.import_rows row WHERE row.normalized_json ->> 'work_email' IS NOT NULL`,
    parameters: ["org", "batch"],
  }], protectedEnv);

  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /pii-protected-import-worker:validate-authoritative-identity/);
  assert.match(statements[0].sql, /direct_pii_presence_mask/);
  assert.doesNotMatch(statements[0].sql, /normalized_json\s*->>/);
  assert.match(statements[1].sql, /pii-protected-import-worker:validate-work-email/);
  assert.match(statements[1].sql, /direct_pii_validity_mask/);
  assert.doesNotMatch(statements[1].sql, /normalized_json\s*->>/);
});

test("protected duplicate detection and identity matching use keyed exact indexes", () => {
  const statements = rewriteProtectedImportWorkerStatements([{
    sql: `WITH evidence AS (SELECT row.id FROM local801.import_rows row)
      INSERT INTO local801.import_errors (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, id, 'error', 'identifier', 'A duplicate authoritative identifier was detected in this source.' FROM evidence`,
    parameters: ["org", "batch"],
  }, {
    sql: `WITH evidence AS (
      SELECT row.id AS import_row_id, identifier.person_id, identifier.identifier_type::text AS rule
      FROM local801.import_rows row JOIN local801.person_identifiers identifier ON identifier.identifier_value = row.normalized_json ->> 'employee_identifier'
      UNION ALL SELECT row.id, contact.person_id, 'work_email' FROM local801.import_rows row JOIN local801.person_contact_methods contact ON contact.contact_value = row.normalized_json ->> 'work_email'
    ), grouped AS (SELECT import_row_id, person_id, string_agg(DISTINCT rule, '+' ORDER BY rule) AS match_rule FROM evidence GROUP BY import_row_id, person_id)
    INSERT INTO local801.import_match_candidates (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
    SELECT gen_random_uuid(), $1, import_row_id, person_id, match_rule, 1, false FROM grouped`,
    parameters: ["org", "batch"],
  }], protectedEnv);

  assert.match(statements[0].sql, /pii-protected-import-worker:validate-duplicate-identity/);
  assert.match(statements[0].sql, /local801\.pii_exact_indexes/);
  assert.doesNotMatch(statements[0].sql, /normalized_json\s*->>/);
  assert.match(statements[1].sql, /pii-protected-import-worker:match-identities/);
  assert.match(statements[1].sql, /entity_type = 'import_row'/);
  assert.match(statements[1].sql, /entity_type = 'person_identifier'/);
  assert.match(statements[1].sql, /entity_type = 'person_contact_method'/);
  assert.doesNotMatch(statements[1].sql, /identifier_value|contact_value|normalized_json\s*->>/i);
});

test("legacy mode leaves worker SQL unchanged", () => {
  const statement = { sql: "SELECT row.normalized_json ->> 'work_email' FROM local801.import_rows row", parameters: [] };
  const result = rewriteProtectedImportWorkerStatements([statement], { LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0" });
  assert.equal(result[0], statement);
});
