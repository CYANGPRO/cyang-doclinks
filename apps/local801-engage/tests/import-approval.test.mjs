import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as access from "../src/lib/access.ts";
import {
  acknowledgeDuplicateImportSource,
  clearImportRowResolution,
  getImportApprovalReview,
  saveImportApprovalPlan,
  setImportRowResolution,
  __testing,
} from "../src/lib/import-approval.ts";
import { publicImportApprovalError } from "../src/lib/import-approval-errors.ts";

const actor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  role: "membership_data_manager",
};

function batch(overrides = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    import_kind: "current_roster",
    state: "under_review",
    import_file_id: "44444444-4444-4444-8444-444444444444",
    import_file_count: 1,
    sha256: "a".repeat(64),
    malware_scan_status: "clean",
    snapshot_date: "2026-08-01",
    effective_date: null,
    duplicate_source_acknowledged: false,
    duplicate_source_exists: false,
    total_blocking_error_count: 0,
    ...overrides,
  };
}

function row(index = 1, overrides = {}) {
  return {
    import_row_id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    import_row_hash: `${index}`.padStart(64, "0"),
    sheet_name: "Roster",
    source_row_number: index + 1,
    row_state: "included",
    normalized_json: {
      first_name: "Phase",
      last_name: `Two ${index}`,
      work_email: `phase.two.${index}@example.test`,
      employee_identifier: null,
      member_identifier: null,
      membership_status: "member",
      hire_date: null,
    },
    resolution_type: "create_new",
    resolution_person_id: null,
    resolution_id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    blocking_error_count: 0,
    candidate_person_count: 0,
    resolution_is_candidate: false,
    existing_person_active: false,
    existing_preferred_name: null,
    existing_first_name: null,
    existing_last_name: null,
    existing_membership_status: null,
    existing_department: null,
    existing_section: null,
    existing_classification: null,
    existing_work_location: null,
    existing_primary_work_email: null,
    ...overrides,
  };
}

async function review({
  batchRow = batch(),
  rows = [row()],
  live = [],
  identifiers = [],
  previous = [],
  env = { VERCEL_ENV: "preview" },
} = {}) {
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("approval:batch")) return batchRow ? [batchRow] : [];
    if (sql.includes("approval:rows-entire-batch")) return rows;
    if (sql.includes("approval:live-identities-entire-batch")) return live;
    if (sql.includes("approval:existing-identifiers")) return identifiers;
    if (sql.includes("approval:previous-snapshot")) return previous;
    throw new Error(`Unexpected query: ${sql}`);
  };
  return { result: await getImportApprovalReview(actor, batchRow?.id ?? "missing", { query, env }), calls };
}

test("approveImports is separate and limited to the three approval roles", () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager"]) {
    assert.equal(access.can(role, "approveImports"), true, role);
  }
  for (const role of ["cat_admin", "cat_lead", "cat_member", "report_viewer"]) {
    assert.equal(access.can(role, "approveImports"), false, role);
  }
  assert.ok(access.permissions.manageImports);
});

test("unexpected approval failures map to a controlled public response", () => {
  const failure = publicImportApprovalError(new Error("postgres constraint R2 secret storage/key"));
  assert.deepEqual(failure, {
    code: "SERVICE_UNAVAILABLE",
    message: "Import approval readiness is temporarily unavailable.",
    status: 503,
  });
});

test("work email alone supports create_new and names do not establish identity", async () => {
  const { result } = await review();
  assert.equal(result.readiness.ready, true);
  assert.equal(result.preview.counts.plannedNewPeople, 1);

  const nameOnly = row(1, {
    normalized_json: { first_name: "Avery", last_name: "Morgan", work_email: null, employee_identifier: null, member_identifier: null },
  });
  const blocked = await review({ rows: [nameOnly] });
  assert.equal(blocked.result.readiness.ready, false);
  assert.ok(blocked.result.readiness.reasons.some((reason) => reason.code === "STALE_RESOLUTION"));
});

test("resolution writes derive the person from persisted exact candidates and are atomic with audit", async () => {
  const statements = [];
  const personId = "77777777-7777-4777-8777-777777777777";
  const query = async (sql) => {
    if (sql.includes("approval:resolution-facts")) return [{
      batch_state: "under_review", import_kind: "current_roster", import_row_id: row().import_row_id,
      row_state: "included", normalized_json: row().normalized_json, blocking_error_count: 0,
      candidate_person_id: personId,
    }];
    if (sql.includes("approval:single-row-live-identities")) return [{ person_id: personId, evidence_type: "work_email" }];
    if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
    throw new Error("Unexpected query");
  };
  const result = await setImportRowResolution(actor, {
    batchId: batch().id,
    rowId: row().import_row_id,
    resolutionType: "confirm_existing",
  }, {
    query,
    transaction: async (value) => statements.push(...value),
    id: () => "88888888-8888-4888-8888-888888888888",
  });
  assert.deepEqual(result, { resolutionType: "confirm_existing" });
  assert.equal("personId" in result, false);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO local801\.import_row_resolutions/i);
  assert.equal(statements[0].parameters[4], personId);
  assert.match(statements[0].sql, /person\.archived_at IS NULL/i);
  assert.match(statements[0].sql, /lower\(btrim\(contact\.contact_value\)\)/i);
  assert.match(statements[1].sql, /INSERT INTO local801\.audit_events/i);
});

test("work-email-only create_new resolution is accepted after live uniqueness recheck", async () => {
  const statements = [];
  const query = async (sql) => {
    if (sql.includes("approval:resolution-facts")) return [{
      batch_state: "under_review", import_kind: "current_roster", import_row_id: row().import_row_id,
      row_state: "included", normalized_json: row().normalized_json, blocking_error_count: 0,
      candidate_person_id: null,
    }];
    if (sql.includes("approval:single-row-live-identities")) return [];
    if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
    throw new Error("Unexpected query");
  };
  await setImportRowResolution(actor, {
    batchId: batch().id,
    rowId: row().import_row_id,
    resolutionType: "create_new",
  }, { query, transaction: async (value) => statements.push(...value) });
  assert.match(statements[0].sql, /normalized_json ->> 'work_email'/i);
  assert.match(statements[0].sql, /NOT EXISTS[\s\S]*person_contact_methods/i);
});

test("name-only create_new is rejected before any transaction", async () => {
  let transactionCalls = 0;
  const query = async (sql) => {
    if (sql.includes("approval:resolution-facts")) return [{
      batch_state: "under_review", import_kind: "current_roster", import_row_id: row().import_row_id,
      row_state: "included", normalized_json: { first_name: "Avery", last_name: "Morgan" }, blocking_error_count: 0,
      candidate_person_id: null,
    }];
    if (sql.includes("approval:single-row-live-identities")) return [];
    throw new Error("Unexpected query");
  };
  await assert.rejects(
    setImportRowResolution(actor, { batchId: batch().id, rowId: row().import_row_id, resolutionType: "create_new" }, {
      query,
      transaction: async () => { transactionCalls += 1; },
    }),
    (error) => error.code === "INVALID_RESOLUTION",
  );
  assert.equal(transactionCalls, 0);
});

test("create_new becomes stale when any authoritative identity is assigned", async () => {
  const live = [{ import_row_id: row().import_row_id, person_id: "person-other", evidence_type: "work_email" }];
  const { result } = await review({ live });
  assert.equal(result.readiness.ready, false);
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "STALE_RESOLUTION"));
});

test("confirm_existing becomes stale for archived people or changed live identity ownership", async () => {
  const personId = "person-one";
  const confirmed = row(1, {
    resolution_type: "confirm_existing", resolution_person_id: personId,
    candidate_person_count: 1, resolution_is_candidate: true, existing_person_active: false,
  });
  let result = (await review({
    rows: [confirmed],
    live: [{ import_row_id: confirmed.import_row_id, person_id: personId, evidence_type: "work_email" }],
  })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "STALE_RESOLUTION"));

  confirmed.existing_person_active = true;
  result = (await review({
    rows: [confirmed],
    live: [{ import_row_id: confirmed.import_row_id, person_id: "person-two", evidence_type: "work_email" }],
  })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "STALE_RESOLUTION"));
});

test("conflicting candidates, rejected rows, and batch-level errors block the whole batch", async () => {
  const conflict = row(1, { candidate_person_count: 2, resolution_type: null, resolution_id: null });
  const rejected = row(2, { row_state: "rejected", resolution_type: null, resolution_id: null });
  const { result } = await review({
    batchRow: batch({ total_blocking_error_count: 1 }),
    rows: [conflict, rejected],
  });
  const codes = new Set(result.readiness.reasons.map((reason) => reason.code));
  assert.ok(codes.has("IDENTIFIER_CONFLICT"));
  assert.ok(codes.has("REJECTED_ROWS"));
  assert.ok(codes.has("BLOCKING_VALIDATION_ERROR"));
  assert.ok(codes.has("UNRESOLVED_ROWS"));
});

test("current roster preview compares snapshots without planning archive, drop, or separation", async () => {
  const existing = row(1, {
    resolution_type: "confirm_existing", resolution_person_id: "person-current", candidate_person_count: 1,
    resolution_is_candidate: true, existing_person_active: true, existing_membership_status: "nonmember",
  });
  const { result } = await review({
    rows: [existing],
    live: [{ import_row_id: existing.import_row_id, person_id: "person-current", evidence_type: "work_email" }],
    previous: [
      { snapshot_id: "snapshot", snapshot_date: "2026-07-01", person_id: "person-current" },
      { snapshot_id: "snapshot", snapshot_date: "2026-07-01", person_id: "person-missing" },
    ],
  });
  assert.equal(result.preview.counts.snapshotRows, 1);
  assert.equal(result.preview.counts.leavingSnapshot, 1);
  assert.equal(result.preview.rows[0].eventAction, "correction");
  assert.doesNotMatch(JSON.stringify(result.preview), /archive|separation|set_nonmember/);
});

test("new-hire row dates override fallback and missing dates require a fallback", async () => {
  const withDate = row(1, { normalized_json: { ...row().normalized_json, hire_date: "2026-07-04" } });
  let result = (await review({
    batchRow: batch({ import_kind: "new_hires", snapshot_date: null, effective_date: "2026-08-01" }),
    rows: [withDate],
  })).result;
  assert.equal(result.preview.rows[0].eventDate, "2026-07-04");

  const withoutDate = row(1, { normalized_json: { ...row().normalized_json, hire_date: null } });
  result = (await review({
    batchRow: batch({ import_kind: "new_hires", snapshot_date: null, effective_date: null }),
    rows: [withoutDate],
  })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "EFFECTIVE_DATE_REQUIRED"));
});

test("addition and drop previews preserve meaningful-event no-op behavior", async () => {
  const personId = "person-current";
  const existing = row(1, {
    resolution_type: "confirm_existing", resolution_person_id: personId, candidate_person_count: 1,
    resolution_is_candidate: true, existing_person_active: true, existing_membership_status: "member",
  });
  const live = [{ import_row_id: existing.import_row_id, person_id: personId, evidence_type: "work_email" }];
  let result = (await review({
    batchRow: batch({ import_kind: "membership_additions", snapshot_date: null, effective_date: "2026-08-01" }), rows: [existing], live,
  })).result;
  assert.equal(result.preview.rows[0].eventAction, "none");
  assert.equal(result.preview.counts.membershipEvents, 0);

  existing.existing_membership_status = "nonmember";
  result = (await review({
    batchRow: batch({ import_kind: "membership_drops", snapshot_date: null, effective_date: "2026-08-01" }), rows: [existing], live,
  })).result;
  assert.equal(result.preview.rows[0].eventAction, "none");
  assert.equal(result.preview.counts.membershipEvents, 0);
  assert.doesNotMatch(JSON.stringify(result.preview), /archive|delete/);
});

test("duplicate SHA requires persisted acknowledgement and filenames are irrelevant", async () => {
  let result = (await review({ batchRow: batch({ duplicate_source_exists: true }) })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "DUPLICATE_SOURCE_ACK_REQUIRED"));
  result = (await review({ batchRow: batch({ duplicate_source_exists: true, duplicate_source_acknowledged: true }) })).result;
  assert.equal(result.readiness.reasons.some((reason) => reason.code === "DUPLICATE_SOURCE_ACK_REQUIRED"), false);
});

test("duplicate-source SQL is organization scoped, approval-only, and has no invalid derived-column reference", () => {
  const sql = __testing.duplicateSourceSql;
  assert.match(sql, /current_batch\.id = \$2 AND current_batch\.organization_id = \$1/i);
  assert.match(sql, /current_file\.organization_id = current_batch\.organization_id/i);
  assert.match(sql, /prior_file\.organization_id = \$1/i);
  assert.match(sql, /prior_batch\.organization_id = \$1/i);
  assert.match(sql, /prior_batch\.state = 'approved'/i);
  assert.match(sql, /prior_batch\.id <> current_source\.import_batch_id/i);
  assert.match(sql, /prior_file\.sha256 = current_source\.sha256/i);
  assert.match(sql, /source_file_count = 1 AND EXISTS/i);
  assert.doesNotMatch(sql, /filename/i);
  assert.doesNotMatch(sql, /JOIN\s+LATERAL/i);
});

test("duplicate-source status rejects non-approved, cross-org, self, and ambiguous sources by SQL shape", () => {
  const sql = __testing.duplicateSourceSql;
  assert.doesNotMatch(sql, /state\s+IN\s*\([^)]*rejected/i);
  assert.doesNotMatch(sql, /state\s+IN\s*\([^)]*validated/i);
  assert.match(sql, /state = 'approved'/i);
  assert.match(sql, /organization_id = \$1/i);
  assert.match(sql, /<> current_source\.import_batch_id/i);
  assert.match(sql, /count\(current_file\.id\)::int AS source_file_count/i);
});

test("pending malware exception is strict synthetic Preview/local opt-in only", async () => {
  let result = (await review({ batchRow: batch({ malware_scan_status: "pending" }) })).result;
  assert.equal(result.readiness.reasons.some((reason) => reason.code === "MALWARE_NOT_CLEAN"), false);

  const nonSyntheticAddress = row(1, { normalized_json: { ...row().normalized_json, work_email: "not-an-example-test-address" } });
  result = (await review({ batchRow: batch({ malware_scan_status: "pending" }), rows: [nonSyntheticAddress] })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "SYNTHETIC_PREVIEW_REQUIRED"));

  result = (await review({ batchRow: batch({ malware_scan_status: "pending" }), env: { VERCEL_ENV: "production" } })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "MALWARE_NOT_CLEAN"));

  result = (await review({
    batchRow: batch({ malware_scan_status: "pending" }), env: { VERCEL_ENV: "development", LOCAL801_ALLOW_SYNTHETIC_SEED: "1" },
  })).result;
  assert.equal(result.readiness.reasons.some((reason) => reason.code === "MALWARE_NOT_CLEAN"), false);

  result = (await review({
    batchRow: batch({ malware_scan_status: "pending" }),
    env: { NODE_ENV: "production", LOCAL801_ALLOW_SYNTHETIC_SEED: "1" },
  })).result;
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "MALWARE_NOT_CLEAN"));
});

test("legacy, approved, rejected, missing source, and required date states have safe reason codes", async () => {
  const cases = [
    [batch({ import_kind: "mystery_import", snapshot_date: null }), "UNSUPPORTED_IMPORT_KIND"],
    [batch({ import_kind: "legacy_cat", snapshot_date: null }), "LEGACY_CAT_NOT_APPROVABLE"],
    [batch({ state: "approved" }), "ALREADY_APPROVED"],
    [batch({ state: "rejected" }), "BATCH_REJECTED"],
    [batch({ import_file_id: null, sha256: null }), "SOURCE_FILE_MISSING"],
    [batch({ import_file_count: 2 }), "SOURCE_FILE_AMBIGUOUS"],
    [batch({ snapshot_date: null }), "SNAPSHOT_DATE_REQUIRED"],
    [batch({ import_kind: "membership_additions", snapshot_date: null, effective_date: null }), "EFFECTIVE_DATE_REQUIRED"],
  ];
  for (const [batchRow, code] of cases) {
    const { result } = await review({ batchRow });
    assert.ok(result.readiness.reasons.some((reason) => reason.code === code), code);
  }
});

test("readiness evaluates all rows but limits serialized row details to 50", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => row(index + 1));
  const { result, calls } = await review({ rows });
  assert.equal(result.preview.counts.plannedNewPeople, 51);
  assert.equal(result.preview.rows.length, 50);
  assert.equal(result.preview.entireBatchEvaluated, true);
  const rowsQuery = calls.find((call) => call.sql.includes("approval:rows-entire-batch"));
  assert.doesNotMatch(rowsQuery.sql, /LIMIT\s+50/i);
  assert.match(rowsQuery.sql, /ORDER BY sheet\.created_at, sheet\.id, row\.source_row_number, row\.id/i);
});

test("ready fingerprints are deterministic and stale/blocked plans have no hash", async () => {
  const first = (await review()).result.preview;
  const second = (await review()).result.preview;
  assert.equal(first.fullHash, second.fullHash);
  assert.equal(first.fullHash.length, 64);
  assert.equal(first.fingerprint, first.fullHash.slice(0, 12).toUpperCase());
  const blocked = (await review({ rows: [row(1, { resolution_type: null, resolution_id: null })] })).result.preview;
  assert.equal(blocked.fullHash, null);
});

test("plan, clear, and duplicate acknowledgement writes pair one control-plane mutation with one audit statement", async () => {
  async function run(operation, query) {
    const statements = [];
    await operation({ query, transaction: async (value) => statements.push(...value), id: () => "99999999-9999-4999-8999-999999999999" });
    assert.equal(statements.length, 2);
    assert.match(statements[1].sql, /INSERT INTO local801\.audit_events/i);
    return statements[0];
  }
  const auditAware = (handler) => async (sql, parameters) => {
    if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
    return handler(sql, parameters);
  };
  let mutation = await run(
    (deps) => saveImportApprovalPlan(actor, { batchId: batch().id, snapshotDate: "2026-08-01" }, deps),
    auditAware(async (sql) => sql.includes("SELECT id, import_kind, state") ? [{ id: batch().id, import_kind: "current_roster", state: "under_review" }] : []),
  );
  assert.match(mutation.sql, /INSERT INTO local801\.import_approval_plans/i);

  mutation = await run(
    (deps) => clearImportRowResolution(actor, { batchId: batch().id, rowId: row().import_row_id }, deps),
    auditAware(async () => []),
  );
  assert.match(mutation.sql, /DELETE FROM local801\.import_row_resolutions/i);

  mutation = await run(
    (deps) => acknowledgeDuplicateImportSource(actor, batch().id, deps),
    auditAware(async (sql) => sql.includes("approval:duplicate-source")
      ? [{ duplicate_exists: true, source_file_count: 1 }]
      : []),
  );
  assert.match(mutation.sql, /INSERT INTO local801\.import_approval_plans/i);
  assert.match(mutation.sql, /duplicate_source_acknowledged = true/i);
  assert.match(mutation.sql, /HAVING count\(current_file\.id\) = 1/i);
});

test("duplicate-source acknowledgement fails closed for multiple source files", async () => {
  let transactionCalls = 0;
  await assert.rejects(
    acknowledgeDuplicateImportSource(actor, batch().id, {
      query: async (sql) => sql.includes("approval:duplicate-source")
        ? [{ duplicate_exists: true, source_file_count: 2 }]
        : [],
      transaction: async () => { transactionCalls += 1; },
    }),
    (error) => error.code === "SOURCE_FILE_AMBIGUOUS",
  );
  assert.equal(transactionCalls, 0);
});

test("review mutations deny unauthorized roles before any database call", async () => {
  let queries = 0;
  await assert.rejects(
    setImportRowResolution({ ...actor, role: "cat_admin" }, {
      batchId: batch().id, rowId: row().import_row_id, resolutionType: "create_new",
    }, { query: async () => { queries += 1; return []; } }),
    (error) => error.code === "FORBIDDEN",
  );
  assert.equal(queries, 0);
});

test("cross-organization row injection fails before a transaction", async () => {
  let transactions = 0;
  await assert.rejects(
    setImportRowResolution(actor, {
      batchId: batch().id, rowId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resolutionType: "create_new",
    }, {
      query: async (sql, parameters) => {
        assert.equal(parameters[0], actor.organizationId);
        assert.match(sql, /batch\.organization_id = \$1|error\.organization_id = \$1/i);
        return [];
      },
      transaction: async () => { transactions += 1; },
    }),
    (error) => error.code === "IMPORT_NOT_FOUND",
  );
  assert.equal(transactions, 0);
});

test("approval-plan dates are real ISO calendar dates and invalid input writes nothing", async () => {
  let transactions = 0;
  await assert.rejects(
    saveImportApprovalPlan(actor, { batchId: batch().id, snapshotDate: "2026-02-30" }, {
      query: async () => [{ id: batch().id, import_kind: "current_roster", state: "under_review" }],
      transaction: async () => { transactions += 1; },
    }),
    (error) => error.code === "INVALID_DATE",
  );
  assert.equal(transactions, 0);
});

test("migration 0004 fails closed and installs normalized partial uniqueness", async () => {
  const migration = await readFile(new URL("../db/migrations/0004__import_approval_resolution.sql", import.meta.url), "utf8");
  assert.match(migration, /group by organization_id, lower\(btrim\(contact_value\)\)[\s\S]*having count\(\*\) > 1/i);
  assert.match(migration, /organization_id, lower\(btrim\(contact_value\)\)[\s\S]*contact_type = 'work_email' and archived_at is null/i);
  assert.match(migration, /organization_id, person_id[\s\S]*is_primary = true/i);
  assert.match(migration, /identifier_type = 'employee_identifier'[\s\S]*group by organization_id, lower\(btrim\(identifier_value\)\)/i);
  assert.match(migration, /identifier_type = 'member_identifier'[\s\S]*group by organization_id, lower\(btrim\(identifier_value\)\)/i);
  assert.match(migration, /source_import_file_id uuid/i);
  assert.match(migration, /import_approvals_batch_uq[\s\S]*\(import_batch_id\)/i);
  assert.match(migration, /membership_snapshots_approved_org_date_uq[\s\S]*where status = 'approved'/i);
  assert.match(migration, /create table if not exists local801\.import_row_resolutions/i);
  assert.match(migration, /create table if not exists local801\.import_approval_plans/i);
  assert.doesNotMatch(migration, /delete from|update local801\./i);
});

test("migration discovers legacy unique constraints by catalog definition rather than generated name", async () => {
  const migration = await readFile(new URL("../db/migrations/0004__import_approval_resolution.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /import_approvals_import_batch_id_approval_hash_key/i);
  assert.doesNotMatch(migration, /membership_snapshots_organization_id_snapshot_date_status_key/i);
  assert.match(migration, /pg_catalog\.pg_constraint/i);
  assert.match(migration, /pg_catalog\.pg_attribute/i);
  assert.match(migration, /conrelid = 'local801\.import_approvals'::regclass/i);
  assert.match(migration, /array\['approval_hash', 'import_batch_id'\]::text\[\]/i);
  assert.match(migration, /conrelid = 'local801\.membership_snapshots'::regclass/i);
  assert.match(migration, /array\['organization_id', 'snapshot_date', 'status'\]::text\[\]/i);
  assert.match(migration, /contype = 'u'/i);
  assert.match(migration, /cardinality\(constraint_definition\.conkey\) = 2/i);
  assert.match(migration, /cardinality\(constraint_definition\.conkey\) = 3/i);
  assert.match(migration, /multiple matching constraints exist/i);
  assert.match(migration, /format\([\s\S]*drop constraint %I/i);
  assert.equal((migration.match(/^begin;/gim) ?? []).length, 1);
  assert.equal((migration.match(/^commit;/gim) ?? []).length, 1);
  assert.ok(migration.trim().toLowerCase().startsWith("begin;"));
  assert.ok(migration.trim().toLowerCase().endsWith("commit;"));
});

test("readiness counts every batch-scoped error even when its row link is malformed", async () => {
  const { result, calls } = await review({ batchRow: batch({ total_blocking_error_count: 1 }) });
  assert.equal(result.readiness.ready, false);
  assert.ok(result.readiness.reasons.some((reason) => reason.code === "BLOCKING_VALIDATION_ERROR"));
  const batchQuery = calls.find((call) => call.sql.includes("approval:batch"));
  assert.match(batchQuery.sql, /error\.organization_id = \$1 AND error\.import_batch_id = batch\.id/i);
  assert.match(batchQuery.sql, /error\.severity = 'error'/i);
  assert.doesNotMatch(batchQuery.sql, /error\.import_row_id IS NULL/i);
});

test("row-resolution concurrency collapses to one current record", async () => {
  const migration = await readFile(new URL("../db/migrations/0004__import_approval_resolution.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/import-approval.ts", import.meta.url), "utf8");
  assert.match(migration, /unique \(import_row_id\)/i);
  assert.match(service, /ON CONFLICT \(import_row_id\) DO UPDATE/i);
});

test("authoritative uniqueness remains organization-local and preserves archived email history", async () => {
  const migration = await readFile(new URL("../db/migrations/0004__import_approval_resolution.sql", import.meta.url), "utf8");
  assert.match(migration, /\(organization_id, lower\(btrim\(contact_value\)\)\)/i);
  assert.match(migration, /where contact_type = 'work_email' and archived_at is null/i);
  assert.match(migration, /\(organization_id, lower\(btrim\(identifier_value\)\)\)[\s\S]*employee_identifier/i);
  assert.match(migration, /\(organization_id, lower\(btrim\(identifier_value\)\)\)[\s\S]*member_identifier/i);
  assert.doesNotMatch(migration, /identifier_type = 'synthetic_preview_id'[\s\S]*create unique index/i);
});

test("Phase 2B-1 runtime has no authoritative mutations or approval execution route", async () => {
  const service = await readFile(new URL("../src/lib/import-approval.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/components/ImportApprovalControls.tsx", import.meta.url), "utf8");
  const forbiddenTables = [
    "people", "person_identifiers", "person_contact_methods", "membership_events", "employment_events",
    "membership_snapshots", "membership_snapshot_rows", "import_approvals",
  ];
  for (const table of forbiddenTables) {
    assert.doesNotMatch(service, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+local801\\.${table}\\b`, "i"), table);
  }
  assert.doesNotMatch(service, /UPDATE\s+local801\.import_batches/i);
  assert.doesNotMatch(page, />\s*(Approve|Execute|Commit)\s*</i);
  const allFiles = await readFile(new URL("../src/lib/import-approval.ts", import.meta.url), "utf8");
  assert.doesNotMatch(allFiles, /\/approve|\/execute|\/commit/i);
});

test("new mutation routes require exact same-origin and server-derived approval context", async () => {
  const routes = await Promise.all([
    "../src/app/api/imports/[batchId]/rows/[rowId]/resolution/route.ts",
    "../src/app/api/imports/[batchId]/approval-plan/route.ts",
    "../src/app/api/imports/[batchId]/duplicate-source-ack/route.ts",
    "../src/app/api/imports/[batchId]/review-decisions/[decisionType]/route.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of routes) {
    assert.match(source, /hasExactSameOrigin\(request\)/);
    assert.match(source, /requirePreviewUser\("approveImports"\)/);
    assert.match(source, /resolveWorkspaceContext\(auth\.user\)/);
    assert.doesNotMatch(source, /body\?\.(organizationId|userId|role|personId)/);
    assert.match(source, /no-store, max-age=0/);
  }
});

test("review-decision failures emit only PII-safe operation diagnostics", async () => {
  const route = await readFile(new URL(
    "../src/app/api/imports/[batchId]/review-decisions/[decisionType]/route.ts",
    import.meta.url,
  ), "utf8");
  assert.match(route, /\[import-review-decision\] request failed/);
  assert.match(route, /operation[\s\S]*name[\s\S]*code/);
  assert.doesNotMatch(route, /console\.error\([^)]*(batchId|expectedHash|stack|message)/s);
});

test("server page bounds review detail and does not serialize internal person or row IDs", async () => {
  const page = await readFile(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/import-review.ts", import.meta.url), "utf8");
  assert.match(page, /getImportReviewSummary\(actor, batchId\)/);
  assert.match(page, /getImportReviewDetail\(actor, batchId/);
  assert.doesNotMatch(page, /row\.person_id|row\.import_row_id/);
  assert.match(service, /Omit<DetailRow, "import_row_id" \| "person_id">/);
  assert.match(service, /pageSize \+ 1/);
});
