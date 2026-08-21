import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSyntheticPiiBackfillPlan } from "../src/lib/pii-backfill.ts";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";
import { PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE } from "../src/lib/pii-protected-import-classification.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const rowId = "22222222-2222-4222-8222-222222222222";

function config() {
  return getPiiKeyConfiguration({
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 11).toString("base64") }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 13).toString("base64") }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  });
}

test("protected import planner emits v3 field metadata and destination-compatible blind indexes", () => {
  const plan = buildSyntheticPiiBackfillPlan({
    users: [], authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], importFiles: [], pushSubscriptions: [],
    importRows: [{
      id: rowId,
      organization_id: organizationId,
      normalized_json: {
        first_name: "Synthetic",
        last_name: "Person",
        work_email: "synthetic.person@example.test",
        employee_identifier: "EMPL-100",
        department: "Health Licensing",
      },
    }],
  }, config());
  const row = plan.importRows[0];
  assert.equal(row.fieldSetVersion, 3);
  assert.equal(row.presenceMask, 1 | 2 | 8 | 16);
  assert.equal(row.validityMask, row.presenceMask);
  assert.match(row.integrityHash, /^[0-9a-f]{64}$/);
  const domains = new Set(plan.exactIndexes.map((item) => item.domain));
  for (const domain of ["person:first-name", "person:last-name", "contact:work-email", "identifier:employee-identifier"]) {
    assert.equal(domains.has(domain), true, domain);
  }
});

test("invalid direct PII stays encrypted but is marked invalid instead of entering a blind index", () => {
  const plan = buildSyntheticPiiBackfillPlan({
    users: [], authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], importFiles: [], pushSubscriptions: [],
    importRows: [{
      id: rowId,
      organization_id: organizationId,
      normalized_json: { first_name: "Synthetic", last_name: "Person", work_email: "not-an-email" },
    }],
  }, config());
  const row = plan.importRows[0];
  assert.equal((row.presenceMask & 8) !== 0, true);
  assert.equal((row.validityMask & 8) !== 0, false);
  assert.equal(plan.exactIndexes.some((item) => item.domain === "contact:work-email"), false);
  assert.equal(JSON.stringify(plan).includes("not-an-email"), false);
});

test("protected import classifier never reads direct PII from normalized_json and uses keyed integrity", () => {
  for (const field of ["first_name", "last_name", "preferred_name", "work_email", "employee_identifier", "member_identifier", "home_email", "work_phone", "cell_phone", "home_phone"]) {
    assert.doesNotMatch(PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE, new RegExp(`normalized_json\\s*->>\\s*['\"]${field}['\"]`, "i"));
  }
  assert.match(PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE, /protected\.row_integrity_hash AS row_hash/);
  assert.match(PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE, /local801\.pii_exact_indexes/);
  assert.match(PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE, /direct_pii_presence_mask/);
  assert.match(PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE, /direct_pii_validity_mask/);
});

test("protected review service does not select direct import PII from normalized_json", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-import-review.ts", import.meta.url), "utf8");
  for (const field of ["first_name", "last_name", "preferred_name", "work_email", "employee_identifier", "member_identifier", "home_email", "work_phone", "cell_phone", "home_phone"]) {
    assert.doesNotMatch(source, new RegExp(`normalized_json\\s*->>\\s*['\"]${field}['\"]`, "i"));
  }
  assert.match(source, /NULL::text AS first_name/);
  assert.match(source, /pii_exact_indexes/);
});

test("migration 0014 adds field masks and blind-index uniqueness without removing legacy columns", async () => {
  const migration = await readFile(new URL("../db/migrations/0014__protected_import_metadata_and_uniqueness.sql", import.meta.url), "utf8");
  assert.match(migration, /direct_pii_presence_mask smallint/);
  assert.match(migration, /direct_pii_validity_mask smallint/);
  assert.match(migration, /pii_exact_user_email_uq/);
  assert.match(migration, /pii_exact_identifier_value_uq/);
  assert.match(migration, /pii_exact_auth_provider_subject_uq/);
  assert.doesNotMatch(migration, /drop\s+(column|table)/i);
});
