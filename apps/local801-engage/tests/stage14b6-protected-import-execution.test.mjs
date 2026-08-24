import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";
import { __testing } from "../src/lib/pii-protected-import-execution.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const importRowId = "22222222-2222-4222-8222-222222222222";
const existingPersonId = "33333333-3333-4333-8333-333333333333";

function config() {
  return getPiiKeyConfiguration({
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 31).toString("base64") }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 37).toString("base64") }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  });
}

function encryptedImportRow(category = "existing_with_changes", personId = existingPersonId) {
  const backfill = requireBackfill();
  const plan = backfill({
    users: [], authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], importFiles: [], pushSubscriptions: [],
    importRows: [{
      id: importRowId,
      organization_id: organizationId,
      normalized_json: {
        first_name: "TargetBoundGiven",
        last_name: "TargetBoundFamily",
        preferred_name: "TargetAlias",
        work_email: "target.bound@example.test",
        employee_identifier: "EMP-TARGET-900",
        member_identifier: "MEM-TARGET-900",
        home_email: "target.home@example.test",
        work_phone: "651-555-0100",
        cell_phone: "651-555-0101",
        home_phone: "651-555-0102",
        department: "Health Licensing",
        classification: "Clerical",
        work_location: "Downtown",
        membership_status: "member",
      },
    }],
  }, config());
  const protectedRow = plan.importRows[0];
  return {
    import_row_id: importRowId,
    category,
    person_id: category === "proposed_new" ? null : personId,
    normalized_json: {
      first_name: "TargetBoundGiven",
      last_name: "TargetBoundFamily",
      preferred_name: "TargetAlias",
      work_email: "target.bound@example.test",
      employee_identifier: "EMP-TARGET-900",
      member_identifier: "MEM-TARGET-900",
      home_email: "target.home@example.test",
      work_phone: "651-555-0100",
      cell_phone: "651-555-0101",
      home_phone: "651-555-0102",
      department: "Health Licensing",
      classification: "Clerical",
      work_location: "Downtown",
      membership_status: "member",
    },
    direct_pii_encrypted_payload: protectedRow.encryptedPayload,
    encryption_key_version: protectedRow.encryptionKeyVersion,
    encryption_format_version: protectedRow.encryptionFormatVersion,
    direct_pii_field_set_version: protectedRow.fieldSetVersion,
    direct_pii_presence_mask: protectedRow.presenceMask,
    direct_pii_validity_mask: protectedRow.validityMask,
    row_integrity_hash: protectedRow.integrityHash,
    row_integrity_key_version: protectedRow.integrityKeyVersion,
  };
}

let backfillBuilder;
function requireBackfill() {
  if (!backfillBuilder) throw new Error("backfill builder not initialized");
  return backfillBuilder;
}

test.before(async () => {
  ({ buildSyntheticPiiBackfillPlan: backfillBuilder } = await import("../src/lib/pii-backfill.ts"));
});

test("protected execution staging migration is additive and makes mutation rows immutable", async () => {
  const migration = await readFile(new URL("../db/migrations/0015__protected_import_execution_staging.sql", import.meta.url), "utf8");
  assert.match(migration, /create table if not exists local801\.protected_import_execution_sets/);
  assert.match(migration, /create table if not exists local801\.protected_import_execution_mutations/);
  assert.match(migration, /mutation_fingerprint text not null/);
  assert.match(migration, /before update or delete on local801\.protected_import_execution_mutations/i);
  assert.match(migration, /protected import execution mutations are immutable/);
  assert.match(migration, /mutation_count <= 25000/);
  assert.doesNotMatch(migration, /drop\s+(column|table)/i);
});

test("operational staging strips every direct import PII key", () => {
  const source = {
    first_name: "RawGiven",
    last_name: "RawFamily",
    preferred_name: "RawAlias",
    work_email: "raw@example.test",
    employee_identifier: "EMP-RAW",
    member_identifier: "MEM-RAW",
    home_email: "raw.home@example.test",
    work_phone: "651-555-0100",
    cell_phone: "651-555-0101",
    home_phone: "651-555-0102",
    department: "Health Licensing",
    classification: "Clerical",
  };
  const operational = __testing.operationalOnly(source);
  for (const field of ["first_name", "last_name", "preferred_name", "work_email", "personal_email", "employee_identifier", "member_identifier"]) {
    assert.equal(Object.hasOwn(operational, field), false, field);
  }
  assert.equal(operational.department, "Health Licensing");
});

test("prepared target mutation contains no raw direct PII and uses ciphertext bound to the final target UUID", () => {
  const row = encryptedImportRow();
  const prepared = __testing.prepareTargetMutation(row, organizationId, config());
  assert.equal(prepared.target_person_id, existingPersonId);
  assert.equal(prepared.mutation_kind, "existing");
  const serialized = JSON.stringify(prepared);
  for (const raw of ["TargetBoundGiven", "TargetBoundFamily", "TargetAlias", "target.bound@example.test", "target.home@example.test", "651-555-0100", "651-555-0101", "651-555-0102", "EMP-TARGET-900", "MEM-TARGET-900"]) {
    assert.equal(serialized.includes(raw), false, raw);
  }
  assert.match(prepared.mutation_hash, /^[0-9a-f]{64}$/);
  assert.equal(prepared.operational_json.department, "Health Licensing");
  assert.match(String(prepared.person_protected_json.firstNameEncryptedPayload), /^p1\./);
  assert.equal(prepared.exact_indexes_json.length >= 5, true);
  assert.equal(prepared.contact_protected_json.length, 5);
  assert.deepEqual(prepared.contact_protected_json.map((contact) => [contact.contactType, contact.contactLabel, contact.isPrimary]), [
    ["work_email", "work", true], ["personal_email", "home", true], ["phone", "work", false], ["phone", "cell", true], ["phone", "home", false],
  ]);
  const domains = new Set(prepared.exact_indexes_json.map((index) => index.domain));
  for (const domain of ["contact:work-phone", "contact:cell-phone", "contact:home-phone"]) assert.equal(domains.has(domain), true, domain);
  assert.equal(prepared.search_tokens_json.length > 0, true);
});

test("changing the target UUID changes target-bound protected mutation content and hash", () => {
  const first = __testing.prepareTargetMutation(encryptedImportRow("existing_with_changes", existingPersonId), organizationId, config());
  const secondPersonId = "44444444-4444-4444-8444-444444444444";
  const second = __testing.prepareTargetMutation(encryptedImportRow("existing_with_changes", secondPersonId), organizationId, config());
  assert.notEqual(first.person_protected_json.firstNameEncryptedPayload, second.person_protected_json.firstNameEncryptedPayload);
  assert.notEqual(first.mutation_hash, second.mutation_hash);
});

test("mutation fingerprint input is canonical and sensitive to protected mutation changes", () => {
  const base = { sourceFingerprint: "a".repeat(64), reviewFingerprint: "b".repeat(64), mutationHashes: ["c".repeat(64)] };
  const first = __testing.canonical(base);
  const sameDifferentOrder = __testing.canonical({ mutationHashes: ["c".repeat(64)], reviewFingerprint: "b".repeat(64), sourceFingerprint: "a".repeat(64) });
  assert.equal(first, sameDifferentOrder);
  assert.notEqual(first, __testing.canonical({ ...base, mutationHashes: ["d".repeat(64)] }));
});

test("protected execution preparation remains disabled by default and production has an additional protected-mode gate", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-import-execution.ts", import.meta.url), "utf8");
  assert.match(source, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED !== "1"/);
  assert.match(source, /VERCEL_ENV === "production"/);
  assert.match(source, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1"/);
  assert.match(source, /MAX_PREPARED_ROWS = 25_000/);
  assert.match(source, /summary\.blockers > 0/);
  assert.match(source, /summary\.decisions\.proposedNew/);
  assert.match(source, /summary\.decisions\.existingChanges/);
  assert.match(source, /row_integrity_hash/);
  assert.match(source, /mutationFingerprint/);
});
