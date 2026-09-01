import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __testing,
  acknowledgeLargeRosterShrink,
  getImportExecutionPreflight,
  ImportExecutionPreflightError,
} from "../src/lib/import-execution-preflight.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const actor = (role = "membership_data_manager") => ({ organizationId, userId, role });
const proposedHash = "a".repeat(64);
const changesHash = "b".repeat(64);
const sourceHash = "c".repeat(64);
const rowSetHash = "d".repeat(64);
const archivedMissingHash = "e".repeat(64);

function summaryRow(overrides = {}) {
  return {
    total_rows: "100",
    included_rows: "100",
    excluded_rows: "0",
    rejected_rows: "0",
    unchanged_existing: "80",
    existing_with_changes: "10",
    proposed_new: "10",
    needs_attention: "0",
    rejected: "0",
    blocking_error_count: "0",
    unassociated_blocking_error_count: "0",
    eligible_new_set_hash: proposedHash,
    existing_changes_set_hash: changesHash,
    import_kind: "current_roster",
    previous_snapshot_date: "2026-07-31",
    previous_snapshot_count: "100",
    proposed_snapshot_count: "100",
    entering_snapshot: "10",
    leaving_snapshot: "10",
    archived_missing_set_hash: archivedMissingHash,
    ...overrides,
  };
}

function metaRow(overrides = {}) {
  return {
    id: batchId,
    import_kind: "current_roster",
    state: "under_review",
    processing_stage: "ready_for_review",
    file_count: "1",
    source_sha256: sourceHash,
    malware_scan_status: "clean",
    snapshot_date: "2026-08-15",
    effective_date: null,
    duplicate_source_acknowledged: false,
    large_roster_shrink_acknowledged: false,
    large_roster_shrink_set_hash: null,
    duplicate_source_exists: false,
    row_set_hash: rowSetHash,
    ...overrides,
  };
}

function queryFor({ summary = summaryRow(), meta = metaRow(), decisions = true, migrationPending = false } = {}) {
  let modernMetaCalls = 0;
  return async (sql) => {
    if (sql.includes("SELECT decision_type, set_hash, set_count")) {
      return decisions ? [
        { decision_type: "allow_proposed_new", set_hash: proposedHash, set_count: "10", decided_at: new Date() },
        { decision_type: "acknowledge_existing_changes", set_hash: changesHash, set_count: "10", decided_at: new Date() },
      ] : [];
    }
    if (sql.includes("IMPORT")) throw new Error("unexpected marker");
    if (sql.includes("set_hashes AS") && sql.includes("previous_snapshot AS")) return [summary];
    if (sql.includes("large_roster_shrink_acknowledged")) {
      modernMetaCalls += 1;
      if (migrationPending) throw Object.assign(new Error("column missing"), { code: "42703" });
      return [meta];
    }
    if (sql.includes("row_fingerprint AS") && sql.includes("duplicate_source_acknowledged")) return [meta];
    if (sql.includes("SELECT event_hash")) return [{ event_hash: "previous" }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
  };
}

test("execution preflight is ready only for the exact clean, reviewed, dated set", async () => {
  const preflight = await getImportExecutionPreflight(actor(), batchId, queryFor());
  assert.equal(preflight.ready, true);
  assert.match(preflight.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(preflight.fingerprintShort, preflight.fingerprint.slice(0, 12).toUpperCase());
  assert.deepEqual(preflight.reasons, []);
  assert.equal(preflight.source.fileCount, 1);
  assert.equal(preflight.source.malwareStatus, "clean");
  assert.equal(preflight.plan.snapshotDate, "2026-08-15");
  assert.equal(preflight.shrink.required, false);
  assert.equal(preflight.review.archivedMissing, 10);
});

test("fingerprint changes when source rows or execution dates change", async () => {
  const first = await getImportExecutionPreflight(actor(), batchId, queryFor());
  const second = await getImportExecutionPreflight(actor(), batchId, queryFor({ meta: metaRow({ row_set_hash: "f".repeat(64) }) }));
  const third = await getImportExecutionPreflight(actor(), batchId, queryFor({ meta: metaRow({ snapshot_date: "2026-08-16" }) }));
  const fourth = await getImportExecutionPreflight(actor(), batchId, queryFor({ summary: summaryRow({ archived_missing_set_hash: "9".repeat(64) }) }));
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.notEqual(first.fingerprint, third.fingerprint);
  assert.notEqual(first.fingerprint, fourth.fingerprint);
});

test("preflight blocks dirty/missing sources, stale review decisions, dates, and duplicate approved sources", async () => {
  const preflight = await getImportExecutionPreflight(actor(), batchId, queryFor({
    meta: metaRow({ file_count: "2", source_sha256: null, malware_scan_status: "infected", snapshot_date: null, duplicate_source_exists: true }),
    decisions: false,
    summary: summaryRow({ needs_attention: "2", blocking_error_count: "2" }),
  }));
  const codes = preflight.reasons.map((item) => item.code);
  assert.equal(preflight.ready, false);
  for (const code of [
    "SOURCE_FILE_REQUIRED",
    "MALWARE_NOT_CLEAN",
    "REVIEW_BLOCKERS",
    "PROPOSED_NEW_DECISION_REQUIRED",
    "EXISTING_CHANGES_ACK_REQUIRED",
    "SNAPSHOT_DATE_REQUIRED",
    "DUPLICATE_SOURCE_ACK_REQUIRED",
  ]) assert.equal(codes.includes(code), true, code);
});

test("non-roster execution requires an effective date and unsupported kinds remain blocked", async () => {
  const addition = await getImportExecutionPreflight(actor(), batchId, queryFor({
    meta: metaRow({ import_kind: "membership_additions", snapshot_date: null, effective_date: null }),
    summary: summaryRow({ import_kind: "membership_additions", previous_snapshot_date: null, previous_snapshot_count: "0", proposed_snapshot_count: "0", entering_snapshot: "0", leaving_snapshot: "0" }),
  }));
  assert.equal(addition.reasons.some((item) => item.code === "EFFECTIVE_DATE_REQUIRED"), true);

  const legacy = await getImportExecutionPreflight(actor(), batchId, queryFor({
    meta: metaRow({ import_kind: "legacy_cat", snapshot_date: null, effective_date: null }),
    summary: summaryRow({ import_kind: "legacy_cat", previous_snapshot_date: null, previous_snapshot_count: "0", proposed_snapshot_count: "0", entering_snapshot: "0", leaving_snapshot: "0" }),
  }));
  assert.equal(legacy.reasons.some((item) => item.code === "UNSUPPORTED_IMPORT_KIND"), true);
});

test("migration 0010 absence is detected without hiding the rest of preflight", async () => {
  const preflight = await getImportExecutionPreflight(actor(), batchId, queryFor({ migrationPending: true }));
  assert.equal(preflight.plan.migrationPending, true);
  assert.equal(preflight.reasons.some((item) => item.code === "EXECUTION_MIGRATION_REQUIRED"), true);
  assert.match(preflight.fingerprint, /^[0-9a-f]{64}$/);
});

test("large roster shrink acknowledgement is fingerprint-bound", async () => {
  const shrinkingSummary = summaryRow({ previous_snapshot_count: "200", proposed_snapshot_count: "150", entering_snapshot: "0", leaving_snapshot: "50" });
  const first = await getImportExecutionPreflight(actor(), batchId, queryFor({ summary: shrinkingSummary }));
  assert.equal(first.shrink.required, true);
  assert.equal(first.reasons.some((item) => item.code === "LARGE_ROSTER_SHRINK_ACK_REQUIRED"), true);

  const acknowledged = await getImportExecutionPreflight(actor(), batchId, queryFor({
    summary: shrinkingSummary,
    meta: metaRow({ large_roster_shrink_acknowledged: true, large_roster_shrink_set_hash: first.fingerprint }),
  }));
  assert.equal(acknowledged.plan.largeRosterShrinkAcknowledged, true);
  assert.equal(acknowledged.reasons.some((item) => item.code === "LARGE_ROSTER_SHRINK_ACK_REQUIRED"), false);
  assert.equal(acknowledged.ready, true);

  const stale = await getImportExecutionPreflight(actor(), batchId, queryFor({
    summary: shrinkingSummary,
    meta: metaRow({ large_roster_shrink_acknowledged: true, large_roster_shrink_set_hash: "0".repeat(64), row_set_hash: "f".repeat(64) }),
  }));
  assert.equal(stale.plan.largeRosterShrinkAcknowledged, false);
  assert.equal(stale.reasons.some((item) => item.code === "LARGE_ROSTER_SHRINK_ACK_REQUIRED"), true);
});

test("saving large-shrink acknowledgement rechecks approver role in SQL and audits atomically", async () => {
  const shrinkingSummary = summaryRow({ previous_snapshot_count: "200", proposed_snapshot_count: "150", entering_snapshot: "0", leaving_snapshot: "50" });
  const preflight = await getImportExecutionPreflight(actor(), batchId, queryFor({ summary: shrinkingSummary }));
  const transactions = [];
  const query = queryFor({ summary: shrinkingSummary });
  const result = await acknowledgeLargeRosterShrink(actor(), batchId, preflight.fingerprint, {
    query,
    transaction: async (statements) => transactions.push(statements),
  });
  assert.equal(result.acknowledged, true);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  const mutation = transactions[0][0];
  assert.match(mutation.sql, /UPDATE local801\.import_approval_plans plan/);
  assert.match(mutation.sql, /large_roster_shrink_set_hash = \$5::text/);
  assert.match(mutation.sql, /role\.code = \$4::text/);
  assert.match(mutation.sql, /role\.code IN \('system_owner','local_admin','membership_data_manager'\)/);
  assert.deepEqual(mutation.parameters, [organizationId, batchId, userId, "membership_data_manager", preflight.fingerprint]);
  assert.match(transactions[0][1].sql, /local801\.audit_events/);
});

test("large-shrink acknowledgement rejects stale fingerprints and unauthorized roles", async () => {
  const shrinkingSummary = summaryRow({ previous_snapshot_count: "200", proposed_snapshot_count: "150", entering_snapshot: "0", leaving_snapshot: "50" });
  await assert.rejects(
    acknowledgeLargeRosterShrink(actor(), batchId, "0".repeat(64), { query: queryFor({ summary: shrinkingSummary }) }),
    (error) => error instanceof ImportExecutionPreflightError && error.code === "STALE_FINGERPRINT",
  );
  let calls = 0;
  await assert.rejects(
    getImportExecutionPreflight(actor("cat_admin"), batchId, async () => { calls += 1; return []; }),
    /not authorized/i,
  );
  assert.equal(calls, 0);
});

test("Stage 12A migration remains additive and preflight controls themselves perform no roster mutation", async () => {
  const [migration, page, route, controls, service] = await Promise.all([
    readFile(new URL("../db/migrations/0010__import_execution_preflight.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/imports/[batchId]/large-shrink-ack/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ImportExecutionPreflightControls.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/import-execution-preflight.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /^begin;/i);
  assert.match(migration, /large_roster_shrink_acknowledged/);
  assert.match(migration, /large_roster_shrink_set_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /alter table local801\.person_contact_methods[\s\S]*source_import_file_id uuid references local801\.import_files\(id\)/i);
  assert.match(migration, /commit;\s*$/i);
  for (const table of ["people", "person_identifiers", "person_contact_methods", "membership_events", "employment_events", "membership_snapshots", "membership_snapshot_rows"]) {
    assert.doesNotMatch(migration, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+local801\\.${table}\\b`, "i"));
  }
  assert.match(page, /Approval required before changes are applied/);
  assert.match(page, /Applying changes is temporarily unavailable/);
  assert.match(page, /Final approval and apply/);
  assert.match(page, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED/);
  assert.match(route, /operationalRuntimeEnabled\(\)/);
  assert.match(route, /enforceWorkspaceRateLimit\(context, "import"\)/);
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /MAX_BODY_BYTES = 512/);
  assert.doesNotMatch(`${controls}\n${service}`, /INSERT INTO local801\.people|UPDATE local801\.people|INSERT INTO local801\.membership_events|INSERT INTO local801\.employment_events/);
  assert.equal(__testing.LARGE_SHRINK_THRESHOLD_PERCENT, -20);
});
