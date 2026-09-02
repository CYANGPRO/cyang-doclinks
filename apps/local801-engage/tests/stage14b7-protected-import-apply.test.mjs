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
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /mutation\.operational_json \?\| ARRAY\['first_name','last_name','preferred_name','work_email','personal_email','employee_identifier','member_identifier'\]/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_identifier_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_contact_method_pii/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.pii_exact_indexes/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.person_search_tokens/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /state = 'executed'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /INSERT INTO local801\.import_approvals/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /SET state = 'approved'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /COALESCE\(NULLIF\(btrim\(mutation\.operational_json ->> 'hire_date'\), ''\)::date, batch\.effective_date\)/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /batch\.import_kind IN \('new_hires','recent_hires'\)/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'first_name'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'last_name'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'work_email'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'employee_identifier'/i);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /operational_json\s*->>\s*'member_identifier'/i);
});

test("protected new-hire execution replaces only omitted people whose CAT work is already assigned", () => {
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /cleared_prior_new_hire_queue AS/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /UPDATE local801\.new_hire_roster_entries roster/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /NOT EXISTS \([\s\S]*mutations mutation[\s\S]*mutation\.target_person_id = roster\.person_id/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /UPDATE local801\.engagement_assignments|DELETE FROM local801\.engagement_assignments/i);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /upserted_new_hire_queue AS[\s\S]*archived_at = NULL/);
});

test("current-roster snapshots use the rows returned by insert and update CTEs", () => {
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /RETURNING id, membership_status, department, work_location, classification/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /RETURNING person\.id, person\.membership_status, person\.department, person\.work_location, person\.classification/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /applied_people AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /inserted_snapshot_rows AS[\s\S]*JOIN applied_people person ON person\.id = mutation\.target_person_id/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /membership_event_rows AS MATERIALIZED[\s\S]*JOIN applied_people person ON person\.id = mutation\.target_person_id/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /SELECT 1 \/ CASE/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.applied_people_count = counts\.mutation_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.snapshot_row_count = counts\.mutation_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /omitted_active_people AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /archived_omitted_people AS[\s\S]*SET archived_at = now\(\), updated_at = now\(\)/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.omitted_person_count = counts\.archived_omitted_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.omitted_person_set_hash = \$8::text/);
});

test("same-date current-roster replacement supersedes the prior snapshot atomically", () => {
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /superseded_same_date_snapshot AS[\s\S]*SET status = 'superseded'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /snapshot\.snapshot_date = batch\.snapshot_date/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /snapshot\.source_import_batch_id IS DISTINCT FROM batch\.id/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /supersession_barrier/);
});

function reconciledResult({ mutations, newPeople, archivedMissing = 0, archivedMissingSetHash = "e".repeat(64) }) {
  return {
    approved_batch_count: 1,
    executed_set_count: 1,
    inserted_approval_count: 1,
    mutation_count: mutations,
    applied_people_count: mutations,
    person_pii_count: mutations,
    new_people_count: newPeople,
    snapshot_count: 1,
    snapshot_row_count: mutations,
    omitted_person_count: archivedMissing,
    omitted_person_set_hash: archivedMissingSetHash,
    archived_omitted_count: archivedMissing,
    reconciliation_ok: true,
  };
}

test("all-new current roster reconciles every applied and snapshot row", () => {
  assert.doesNotThrow(() => __testing.assertAtomicApplyReconciled(
    reconciledResult({ mutations: 787, newPeople: 787 }),
    { mutationCount: 787, newPeopleCount: 787, archivedMissingCount: 0, archivedMissingSetHash: "e".repeat(64), importKind: "current_roster" },
  ));
});

test("mixed new and existing current roster reconciles exact counts", () => {
  assert.doesNotThrow(() => __testing.assertAtomicApplyReconciled(
    reconciledResult({ mutations: 6, newPeople: 2, archivedMissing: 3 }),
    { mutationCount: 6, newPeopleCount: 2, archivedMissingCount: 3, archivedMissingSetHash: "e".repeat(64), importKind: "current_roster" },
  ));
});

test("changed omitted-person identity set fails closed even when the removal count is unchanged", () => {
  assert.throws(
    () => __testing.assertAtomicApplyReconciled(
      reconciledResult({ mutations: 6, newPeople: 2, archivedMissing: 3, archivedMissingSetHash: "f".repeat(64) }),
      { mutationCount: 6, newPeopleCount: 2, archivedMissingCount: 3, archivedMissingSetHash: "e".repeat(64), importKind: "current_roster" },
    ),
    (error) => error.code === "ATOMIC_RECONCILIATION_FAILED" && error.status === 503,
  );
});

test("snapshot reconciliation mismatch raises a named safe rollback error", () => {
  const result = reconciledResult({ mutations: 6, newPeople: 2 });
  result.snapshot_row_count = 5;
  assert.throws(
    () => __testing.assertAtomicApplyReconciled(
      result,
      { mutationCount: 6, newPeopleCount: 2, archivedMissingCount: 0, archivedMissingSetHash: "e".repeat(64), importKind: "current_roster" },
    ),
    (error) => {
      assert.equal(error.code, "ATOMIC_RECONCILIATION_FAILED");
      assert.equal(error.status, 503);
      assert.match(error.message, /not committed.*exactly match.*No roster changes were applied/i);
      assert.doesNotMatch(error.message, /division|SQLSTATE|member|email/i);
      return true;
    },
  );
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
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /AS identifier_item\(item\)/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /identifier_item\.item ->> 'personIdentifierId'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /AS contact_item\(item\)/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /contact_item\.item ->> 'contactMethodId'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /contact_item\.item ->> 'contactType'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /NULLIF\(contact_item\.item ->> 'contactLabel', ''\) AS contact_label/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /WHEN contact_item\.item ->> 'contactType' = 'phone'/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /WHEN 'cell' THEN 1 WHEN 'home' THEN 2 WHEN 'work' THEN 3/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /jsonb_array_elements\(mutation\.contact_protected_json\) item/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /resolved_identifiers AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /existing_index\.index_hash = candidate\.index_hash/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /existing_person_id IS DISTINCT FROM target_person_id/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /resolved_contacts AS MATERIALIZED/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /contact\.archived_at IS NULL/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /candidate\.contact_type IN \('work_email','personal_email'\)[\s\S]*contact\.contact_label IS NOT DISTINCT FROM candidate\.contact_label/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /archived_primary_contacts AS/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /candidate\.is_primary = true AND contact\.is_primary = true/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /candidate\.existing_id IS NULL/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /promoted_existing_contacts AS/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /SET is_primary = candidate\.is_primary/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /contact_label = candidate\.contact_label/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /candidate\.source_file_id, candidate\.contact_label\s+FROM resolved_contacts candidate/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.contact_candidate_count = counts\.contact_applied_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.inserted_contact_count = counts\.inserted_contact_pii_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /counts\.inserted_contact_count = counts\.inserted_contact_index_count/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /count\(DISTINCT contact_index\.entity_id\)::int/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /FROM upserted_contact_indexes contact_index/);
  assert.match(PROTECTED_IMPORT_APPLY_SQL, /JOIN inserted_contacts inserted_contact ON inserted_contact\.id = contact_index\.entity_id/);
  assert.doesNotMatch(PROTECTED_IMPORT_APPLY_SQL, /FROM inserted_contact_indexes/);
});

test("contact reconciliation mismatches fail the application-level atomic guard", () => {
  const result = reconciledResult({ mutations: 787, newPeople: 0 });
  result.contact_candidate_count = 1472;
  result.contact_applied_count = 1;
  assert.throws(
    () => __testing.assertAtomicApplyReconciled(
      result,
      { mutationCount: 787, newPeopleCount: 0, archivedMissingCount: 0, archivedMissingSetHash: "e".repeat(64), importKind: "current_roster" },
    ),
    (error) => error.code === "ATOMIC_RECONCILIATION_FAILED" && error.status === 503,
  );
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
  assert.deepEqual(membershipTesting.expectedMembershipEvents("recent_hires", mutations, prior), []);
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
