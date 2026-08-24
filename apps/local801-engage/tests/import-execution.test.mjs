import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __testing,
  authoritativeExecutionEnabled,
  executeAuthoritativeImport,
  IMPORT_EXECUTION_SQL,
  ImportExecutionError,
} from "../src/lib/import-execution.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const fingerprint = "f".repeat(64);
const proposedHash = "a".repeat(64);
const changesHash = "b".repeat(64);
const sourceHash = "c".repeat(64);
const rowSetHash = "d".repeat(64);
const actor = (role = "membership_data_manager") => ({ organizationId, userId, role });

function summaryRow(overrides = {}) {
  return {
    total_rows: "2",
    included_rows: "2",
    excluded_rows: "0",
    rejected_rows: "0",
    unchanged_existing: "0",
    existing_with_changes: "1",
    proposed_new: "1",
    needs_attention: "0",
    rejected: "0",
    blocking_error_count: "0",
    unassociated_blocking_error_count: "0",
    eligible_new_set_hash: proposedHash,
    existing_changes_set_hash: changesHash,
    import_kind: "membership_additions",
    previous_snapshot_date: null,
    previous_snapshot_count: "0",
    proposed_snapshot_count: "0",
    entering_snapshot: "0",
    leaving_snapshot: "0",
    ...overrides,
  };
}

function metaRow(overrides = {}) {
  return {
    id: batchId,
    import_kind: "membership_additions",
    state: "under_review",
    processing_stage: "ready_for_review",
    file_count: "1",
    source_sha256: sourceHash,
    malware_scan_status: "clean",
    snapshot_date: null,
    effective_date: "2026-08-15",
    duplicate_source_acknowledged: false,
    large_roster_shrink_acknowledged: false,
    large_roster_shrink_set_hash: null,
    duplicate_source_exists: false,
    row_set_hash: rowSetHash,
    ...overrides,
  };
}

function preflightQuery({ summary = summaryRow(), meta = metaRow(), decisions = true } = {}) {
  return async (sql) => {
    if (sql.includes("SELECT decision_type, set_hash, set_count")) {
      return decisions ? [
        { decision_type: "allow_proposed_new", set_hash: proposedHash, set_count: "1", decided_at: new Date() },
        { decision_type: "acknowledge_existing_changes", set_hash: changesHash, set_count: "1", decided_at: new Date() },
      ] : [];
    }
    if (sql.includes("set_hashes AS") && sql.includes("previous_snapshot AS")) return [summary];
    if (sql.includes("large_roster_shrink_acknowledged")) return [meta];
    throw new Error(`Unexpected preflight SQL: ${sql.slice(0, 100)}`);
  };
}

test("legacy authoritative executor feature flag is Preview-only and triple-gated", () => {
  assert.equal(authoritativeExecutionEnabled({ VERCEL_ENV: "preview", LOCAL801_PREVIEW_AUTH_ENABLED: "1", LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1" }), true);
  assert.equal(authoritativeExecutionEnabled({ VERCEL_ENV: "production", LOCAL801_PREVIEW_AUTH_ENABLED: "1", LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1" }), false);
  assert.equal(authoritativeExecutionEnabled({ VERCEL_ENV: "preview", LOCAL801_PREVIEW_AUTH_ENABLED: "0", LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1" }), false);
  assert.equal(authoritativeExecutionEnabled({ VERCEL_ENV: "preview", LOCAL801_PREVIEW_AUTH_ENABLED: "1", LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0" }), false);
});

test("authoritative execution requires valid batch and fingerprint before database work", async () => {
  let calls = 0;
  const query = async () => { calls += 1; return []; };
  await assert.rejects(executeAuthoritativeImport(actor(), "bad", fingerprint, { query }), (error) => error instanceof ImportExecutionError && error.code === "IMPORT_NOT_FOUND");
  await assert.rejects(executeAuthoritativeImport(actor(), batchId, "bad", { query }), (error) => error instanceof ImportExecutionError && error.code === "INVALID_FINGERPRINT");
  assert.equal(calls, 0);
  assert.throws(() => __testing.requireFingerprint("not-a-hash"), /invalid/i);
});

test("unauthorized role fails before preflight SQL or transaction work", async () => {
  let calls = 0;
  await assert.rejects(executeAuthoritativeImport(actor("cat_admin"), batchId, fingerprint, {
    query: async () => { calls += 1; return []; },
    transaction: async () => { calls += 1; },
  }), /not authorized/i);
  assert.equal(calls, 0);
});

test("executor refuses a stale operator fingerprint before submitting a write transaction", async () => {
  const query = preflightQuery();
  const preflightModule = await import("../src/lib/import-execution-preflight.ts");
  const current = await preflightModule.getImportExecutionPreflight(actor(), batchId, query);
  assert.match(current.fingerprint, /^[0-9a-f]{64}$/);
  let transactions = 0;
  await assert.rejects(executeAuthoritativeImport(actor(), batchId, "0".repeat(64), {
    query: preflightQuery(),
    transaction: async () => { transactions += 1; },
  }), (error) => error instanceof ImportExecutionError && error.code === "STALE_FINGERPRINT");
  assert.equal(transactions, 0);
});

test("ready execution submits exactly the set-based write statement plus audit in one database transaction", async () => {
  const preflightModule = await import("../src/lib/import-execution-preflight.ts");
  const current = await preflightModule.getImportExecutionPreflight(actor(), batchId, preflightQuery());
  assert.equal(current.ready, true);
  const transactions = [];
  const audits = [];
  const result = await executeAuthoritativeImport(actor(), batchId, current.fingerprint, {
    query: preflightQuery(),
    transaction: async (statements) => { transactions.push(statements); },
    prepareAudit: async (event) => {
      audits.push(event);
      return { sql: "/* audit */ SELECT 1", parameters: [] };
    },
  });
  assert.equal(result.executed, true);
  assert.equal(result.fingerprint, current.fingerprint);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  assert.equal(transactions[0][0].sql, IMPORT_EXECUTION_SQL);
  assert.deepEqual(transactions[0][0].parameters, [organizationId, batchId, userId, "membership_data_manager", current.fingerprint]);
  assert.equal(audits[0].eventType, "import.execute");
  assert.equal(audits[0].subjectType, "import_batch");
  assert.deepEqual(audits[0].payload, {
    fingerprint: current.fingerprint,
    importKind: "membership_additions",
    totalRows: 2,
    existingChanges: 1,
    proposedNew: 1,
  });
});

test("set-based legacy execution SQL independently rechecks security, review, fingerprint, synthetic data, and idempotency", () => {
  const sql = IMPORT_EXECUTION_SQL;
  assert.match(sql, /organization_slug = 'local801-preview'/);
  assert.match(sql, /role\.code = \$4::text/);
  assert.match(sql, /role\.code IN \('system_owner','local_admin','membership_data_manager'\)/);
  assert.match(sql, /malware_scan_status = 'clean'/);
  assert.match(sql, /processing_stage = 'ready_for_review'/);
  assert.match(sql, /state = 'under_review'/);
  assert.match(sql, /decision\.decision_type = 'allow_proposed_new'/);
  assert.match(sql, /decision\.set_hash = fingerprint\.proposed_new_set_hash/);
  assert.match(sql, /decision\.decision_type = 'acknowledge_existing_changes'/);
  assert.match(sql, /large_roster_shrink_set_hash = gate\.current_fingerprint/);
  assert.match(sql, /lower\(btrim\(normalized_json ->> 'work_email'\)\) LIKE '%@example\.test'/);
  assert.match(sql, /gate\.synthetic_rows = gate\.synthetic_total_rows/);
  assert.match(sql, /NOT gate\.approval_exists/);
  assert.match(sql, /gate\.current_fingerprint = \$5::text/);
  assert.match(sql, /INSERT INTO local801\.import_approvals/);
  assert.match(sql, /UPDATE local801\.import_batches batch[\s\S]*state = 'approved'/);
  assert.match(sql, /ELSE 1 \/ 0/);
});

test("legacy execution performs roster work through SQL CTEs, not JavaScript per-row loops", async () => {
  const service = await readFile(new URL("../src/lib/import-execution.ts", import.meta.url), "utf8");
  assert.match(service, /new_people_map AS MATERIALIZED/);
  assert.match(service, /target_rows AS MATERIALIZED/);
  assert.match(service, /INSERT INTO local801\.people/);
  assert.match(service, /UPDATE local801\.people person/);
  assert.match(service, /INSERT INTO local801\.person_contact_methods/);
  assert.match(service, /INSERT INTO local801\.person_identifiers/);
  assert.match(service, /INSERT INTO local801\.membership_events/);
  assert.match(service, /INSERT INTO local801\.employment_events/);
  assert.match(service, /INSERT INTO local801\.membership_snapshots/);
  assert.match(service, /INSERT INTO local801\.membership_snapshot_rows/);
  assert.doesNotMatch(service, /for\s*\(.*target|for\s+const\s+.*row|\.map\(async\s*\(.*row/i);
  assert.doesNotMatch(service, /OFFSET/i);
});

test("current-roster absence is snapshot history only, never an inferred drop, separation, archive, or person deletion", () => {
  const sql = IMPORT_EXECUTION_SQL;
  assert.match(sql, /inserted_snapshot AS/);
  assert.match(sql, /inserted_snapshot_rows AS/);
  assert.doesNotMatch(sql, /DELETE FROM local801\.people/i);
  assert.doesNotMatch(sql, /person\.archived_at\s*=\s*now/i);
  assert.doesNotMatch(sql, /event_type[^\n]*'separation'/i);
  assert.doesNotMatch(sql, /leaving_snapshot[\s\S]*INSERT INTO local801\.membership_events/i);
});

test("execution route is same-origin, small-body, permission checked, and hidden unless an explicit legacy Preview or protected gate is on", async () => {
  const route = await readFile(new URL("../src/app/api/imports/[batchId]/execute/route.ts", import.meta.url), "utf8");
  assert.match(route, /executionRouteEnabled\(\)/);
  assert.match(route, /protectedExecutionEnabled\(env/);
  assert.match(route, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/);
  assert.match(route, /LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"/);
  assert.match(route, /LOCAL801_PII_BACKFILL_ENABLED !== "1"/);
  assert.match(route, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"/);
  assert.match(route, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1"/);
  assert.match(route, /authoritativeExecutionEnabled\(env\)/);
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /requirePreviewUser\("approveImports"\)/);
  assert.match(route, /MAX_BODY_BYTES = 512/);
  assert.match(route, /prepareProtectedImportExecution/);
  assert.match(route, /applyPreparedProtectedImport/);
  assert.match(route, /executeAuthoritativeImport/);
  assert.match(route, /No roster changes were applied/);
  assert.match(route, /safeProtectedImportExecutionDiagnostic\(executionStage, error\)/);
  assert.match(route, /local801-protected-import-safe-failure/);
  assert.match(route, /supportReference: diagnostic\.supportReference/);
});

test("execution UI is fingerprint-confirmed and all authoritative/protected gates default disabled", async () => {
  const [page, control, example, checklist, config] = await Promise.all([
    readFile(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ImportExecutionControl.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../DEPLOYMENT_CHECKLIST.md", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"/);
  assert.match(page, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"/);
  assert.match(page, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1"/);
  assert.match(page, /Applying changes is temporarily unavailable/);
  assert.match(page, /ImportExecutionControl/);
  assert.match(control, /confirmation\.trim\(\)\.toUpperCase\(\) !== fingerprintShort/);
  assert.match(control, /window\.confirm/);
  assert.match(example, /LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED=0/);
  assert.match(example, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED=0/);
  assert.match(example, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED=0/);
  assert.match(checklist, /legacy Stage 12 synthetic executor remains disabled in Production/i);
  assert.match(checklist, /Stage 14B protected authoritative import gate/i);
});
