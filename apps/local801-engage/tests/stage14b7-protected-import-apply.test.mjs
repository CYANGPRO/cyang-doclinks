import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROTECTED_IMPORT_APPLY_SQL, __testing } from "../src/lib/pii-protected-import-apply.ts";
import { __testing as membershipTesting } from "../src/lib/pii-protected-import-membership-transaction.ts";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("protected authoritative execution remains disabled unless every protected gate is explicit", () => {
  const base = {
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1",
    LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED: "1",
  };
  assert.equal(__testing.enabled(base), true);
  for (const key of [
    "LOCAL801_DATABASE_PII_PROTECTION_ENABLED",
    "LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED",
    "LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED",
  ]) assert.equal(__testing.enabled({ ...base, [key]: "0" }), false, key);
  assert.equal(__testing.enabled({ ...base, LOCAL801_PII_DUAL_WRITE_ENABLED: "1" }), false);
  assert.equal(__testing.enabled({ ...base, LOCAL801_PII_BACKFILL_ENABLED: "1" }), false);
});

test("protected mutation fingerprint exactly binds source, review, and sorted mutation hashes", () => {
  const source = "a".repeat(64);
  const review = "b".repeat(64);
  const rows = [
    { mutation_hash: "d".repeat(64) },
    { mutation_hash: "c".repeat(64) },
  ];
  const canonical = `{"mutationHashes":["${"c".repeat(64)}","${"d".repeat(64)}"],"reviewFingerprint":"${review}","sourceFingerprint":"${source}"}`;
  assert.equal(__testing.mutationFingerprint(source, review, rows), sha256(canonical));
});

test("protected apply SQL is set-based, protected-companion aware, and never reads direct PII from operational JSON", () => {
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /protected_import_execution_mutations/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /mutation\.operational_json \?\| ARRAY\[[\s\S]*'first_name'[\s\S]*'home_email'[\s\S]*'home_phone'[\s\S]*\]/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_identifier_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_contact_method_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.pii_exact_indexes/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_search_tokens/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /state = 'executed'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.import_approvals/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /SET state = 'approved'/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'first_name'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'last_name'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'work_email'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'employee_identifier'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'member_identifier'/i);
});

test("protected apply implementation revalidates under locks before any authoritative writes", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-import-apply.ts", import.meta.url), "utf8");
  assert.match(source, /FOR UPDATE OF batch, execution/);
  assert.match(source, /FOR SHARE/);
  assert.match(source, /getProtectedImportReviewSummary\(actor, batchId, query\)/);
  assert.match(source, /locked\.source_fingerprint !== input\.currentSourceFingerprint/);
  assert.match(source, /locked\.review_fingerprint !== input\.currentReviewFingerprint/);
  assert.match(source, /locked\.mutation_fingerprint !== input\.currentMutationFingerprint/);
  assert.match(source, /large_roster_shrink_set_hash === input\.currentPreflightFingerprint/);
  assert.match(source, /prepareAtomicAuditStatement/);
  assert.match(source, /withLocal801Transaction/);
});

test("identifier and primary work-email application reuses matching protected indexes instead of blindly duplicating entities", () => {
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /resolved_identifiers AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /existing_index\.index_hash = candidate\.index_hash/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /existing_person_id IS DISTINCT FROM target_person_id/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /resolved_contacts AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /contact\.archived_at IS NULL/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /archived_primary_contacts AS/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /promoted_existing_contacts AS/);
});

test("membership event planning preserves legacy change-only semantics", () => {
  const mutations = [
    { target_person_id: "a", mutation_kind: "existing", imported_status: "member" },
    { target_person_id: "b", mutation_kind: "existing", imported_status: "nonmember" },
    { target_person_id: "c", mutation_kind: "new", imported_status: "member" },
    { target_person_id: "d", mutation_kind: "existing", imported_status: null },
  ];
  const prior = new Map([["a", "member"], ["b", "member"], ["d", "unknown"]]);
  assert.deepEqual(membershipTesting.expectedMembershipEvents("current_roster", mutations, prior), ["b"]);
  assert.deepEqual(membershipTesting.expectedMembershipEvents("membership_additions", mutations, prior), ["c", "d"]);
  const priorDrops = new Map([["a", "nonmember"], ["b", "member"], ["d", "nonmember"]]);
  assert.deepEqual(membershipTesting.expectedMembershipEvents("membership_drops", mutations, priorDrops), ["b", "c"]);
  assert.deepEqual(membershipTesting.expectedMembershipEvents("new_hires", mutations, prior), []);
});

test("protected membership reconciliation locks prior state and deletes only transaction-local no-op events", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-import-membership-transaction.ts", import.meta.url), "utf8");
  assert.match(source, /FOR UPDATE OF person/);
  assert.match(source, /statement !== PROTECTED_IMPORT_APPLY_SQL/);
  assert.match(source, /remove-noop-membership-events/);
  assert.match(source, /event\.created_at = transaction_timestamp\(\)/);
  assert.match(source, /event\.source_import_file_id = \$2::uuid/);
  assert.match(source, /Number\(count\?\.event_count \?\? -1\) !== expectedIds\.length/);
});

test("protected execute route supplies the membership reconciliation transaction to atomic apply", async () => {
  const source = await readFile(new URL("../src/app/api/imports/[batchId]/execute/route.ts", import.meta.url), "utf8");
  assert.match(source, /protectedImportMembershipTransaction/);
  assert.match(source, /\{ transaction: protectedImportMembershipTransaction \}/);
});
