import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const persistence = await import("../src/lib/import-persistence.ts");
const importErrors = await import("../src/lib/import-errors.ts");

function csvFile(name = "synthetic.csv") {
  return new File([
    "Employee ID,Work Email,Local #,First Name\n100,worker@example.test,0801,Avery\n101,other@example.test,0802,Riley\n",
  ], name, { type: "text/csv" });
}

function dependencies(sqls, storeCalls = []) {
  return {
    id: (() => {
      let count = 0;
      return () => `11111111-1111-4111-8111-${String(++count).padStart(12, "0")}`;
    })(),
    storeFile: async (input) => {
      storeCalls.push(input);
      return { id: "22222222-2222-4222-8222-222222222222", byteSize: input.content.byteLength };
    },
    audit: async () => ({ id: "33333333-3333-4333-8333-333333333333" }),
    query: async (sql, parameters = []) => {
      sqls.push({ sql, parameters });
      if (sql.includes("INSERT INTO local801.import_batches")) return [{ id: parameters[0] }];
      if (sql.includes("FROM local801.people")) return [];
      return [];
    },
  };
}

test("unauthorized import actors fail before persistence or storage", async () => {
  let calls = 0;
  await assert.rejects(
    persistence.persistImportReview({
      actor: { organizationId: "org", userId: "user", role: "cat_admin" },
      file: csvFile(),
      importKind: "current_roster",
      dependencies: {
        query: async () => { calls += 1; return []; },
        storeFile: async () => { calls += 1; throw new Error("must not store"); },
      },
    }),
    /Forbidden/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    persistence.listImportBatches({ organizationId: "org", userId: "user", role: "cat_member" }, async () => []),
    /Forbidden/,
  );
});

test("persistent review stores every included normalized row and excludes non-0801 rows", async () => {
  const sqls = [];
  const stores = [];
  const result = await persistence.persistImportReview({
    actor: { organizationId: "org", userId: "user", role: "membership_data_manager" },
    file: csvFile(),
    importKind: "current_roster",
    dependencies: dependencies(sqls, stores),
  });
  assert.equal(stores.length, 1);
  assert.equal(result.totalRows, 2);
  assert.equal(result.includedRows, 1);
  assert.equal(result.excludedRows, 1);
  assert.equal(sqls.filter(({ sql }) => sql.includes("INSERT INTO local801.import_rows")).length, 1);
  assert.equal(sqls.some(({ sql }) => /INSERT INTO local801\.(people|person_identifiers|person_contact_methods|membership_events|employment_events|membership_snapshots|membership_snapshot_rows|import_approvals)/.test(sql)), false);
  assert.equal(sqls.every(({ sql }) => !/FROM local801\.people/.test(sql) || /organization_id/.test(sql)), true);
});

test("synthetic Phase 2A rows persist exact, no-match, and rejected review outcomes", async () => {
  const sqls = [];
  const fixture = new File([
    "First Name,Last Name,Work Email,Local #\n" +
    "Avery,Morgan,avery.morgan@example.test,0801\n" +
    "Phase,Two,new.phase2a.person@example.test,0801\n" +
    "Missing,Identifier,,0801\n" +
    "Avery,Morgan,similar.name@example.test,0801\n" +
    "Outside,Local,outside.local@example.test,0999\n",
  ], "phase2a-review.csv", { type: "text/csv" });
  const reviewDependencies = dependencies(sqls);
  reviewDependencies.query = async (sql, parameters = []) => {
    sqls.push({ sql, parameters });
    if (sql.includes("INSERT INTO local801.import_batches")) return [{ id: parameters[0] }];
    return [];
  };

  await persistence.persistImportReview({
    actor: { organizationId: "org", userId: "user", role: "membership_data_manager" },
    file: fixture,
    importKind: "current_roster",
    dependencies: reviewDependencies,
  });

  const persistedRows = sqls.filter(({ sql }) => sql.includes("INSERT INTO local801.import_rows"));
  const rowPayloads = persistedRows.flatMap((statement) => JSON.parse(statement.parameters[2]));
  const rowByEmail = new Map(rowPayloads.map((row) => [row.normalized_json.work_email, row]));
  const missingRow = rowPayloads.find((row) => row.normalized_json.first_name === "Missing");
  const candidates = sqls.filter(({ sql }) => sql.includes("INSERT INTO local801.import_match_candidates"));

  assert.equal(persistedRows.length, 1);
  assert.equal(rowPayloads.length, 4);
  assert.equal(rowByEmail.has("outside.local@example.test"), false);
  assert.equal(missingRow.state, "rejected");
  assert.equal(candidates.length, 2);
  assert.equal(candidates.some(({ sql }) => sql.includes("import:set-based-authoritative-matching")), true);
  assert.equal(candidates.some(({ sql }) => sql.includes("NULL, 'no_exact_match', 0, true")), true);
  assert.equal(sqls.some(({ sql }) => sql.includes("jsonb_to_recordset") && sql.includes("local801.import_errors")), true);
  assert.equal(sqls.some(({ sql }) => /person\.(first_name|last_name|preferred_name)\s*=|lower\(person\.(first_name|last_name|preferred_name)\)/i.test(sql)), false);
});

test("match review reads are bounded, deterministic, and organization scoped", async () => {
  const calls = [];
  const base = {
    sheet_name: "CSV",
    row_state: "pending",
    imported_department: "Operations",
    imported_classification: "Tech",
    existing_department: null,
    existing_classification: null,
    existing_work_email: null,
    requires_review: true,
  };
  const reviews = await persistence.getImportMatchCandidates(
    { organizationId: "org-a", userId: "user-a", role: "membership_data_manager" },
    "batch-a",
    async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [
        {
          ...base,
          candidate_id: "candidate-exact",
          import_row_id: "row-exact",
          source_row_number: 2,
          imported_first_name: "Avery",
          imported_last_name: "Morgan",
          imported_work_email: "avery.morgan@example.test",
          has_authoritative_identifier: true,
          person_id: "person-avery",
          match_rule: "work_email",
          existing_preferred_name: "Avery",
          existing_first_name: "Avery",
          existing_last_name: "Morgan",
          existing_work_email: "avery.morgan@example.test",
          matched_person_count: 1,
        },
        {
          ...base,
          candidate_id: "candidate-new",
          import_row_id: "row-new",
          source_row_number: 3,
          imported_first_name: "Phase",
          imported_last_name: "Two",
          imported_work_email: "new.phase2a.person@example.test",
          has_authoritative_identifier: true,
          person_id: null,
          match_rule: "no_exact_match",
          existing_preferred_name: null,
          existing_first_name: null,
          existing_last_name: null,
          matched_person_count: 0,
        },
        {
          ...base,
          candidate_id: "candidate-rejected",
          import_row_id: "row-rejected",
          source_row_number: 4,
          row_state: "rejected",
          imported_first_name: "Missing",
          imported_last_name: "Identifier",
          imported_work_email: null,
          has_authoritative_identifier: false,
          person_id: null,
          match_rule: "no_exact_match",
          existing_preferred_name: null,
          existing_first_name: null,
          existing_last_name: null,
          matched_person_count: 0,
        },
        {
          ...base,
          candidate_id: "candidate-conflict-a",
          import_row_id: "row-conflict",
          source_row_number: 5,
          row_state: "rejected",
          imported_first_name: "Conflict",
          imported_last_name: "Review",
          imported_work_email: "conflict@example.test",
          has_authoritative_identifier: true,
          person_id: "person-a",
          match_rule: "employee_identifier",
          existing_preferred_name: null,
          existing_first_name: "Existing",
          existing_last_name: "One",
          matched_person_count: 2,
        },
        {
          ...base,
          candidate_id: "candidate-conflict-b",
          import_row_id: "row-conflict",
          source_row_number: 5,
          row_state: "rejected",
          imported_first_name: "Conflict",
          imported_last_name: "Review",
          imported_work_email: "conflict@example.test",
          has_authoritative_identifier: true,
          person_id: "person-b",
          match_rule: "member_identifier",
          existing_preferred_name: null,
          existing_first_name: "Existing",
          existing_last_name: "Two",
          matched_person_count: 2,
        },
      ];
    },
  );

  assert.deepEqual(calls[0].parameters, ["org-a", "batch-a"]);
  assert.match(calls[0].sql, /WHERE candidate\.organization_id = \$1/);
  assert.match(calls[0].sql, /batch\.organization_id = \$1/);
  assert.match(calls[0].sql, /batch\.id = \$2/);
  assert.match(calls[0].sql, /ORDER BY sheet\.created_at, sheet\.id, row\.source_row_number, candidate\.id/);
  assert.match(calls[0].sql, /LIMIT 50/);
  assert.match(calls[0].sql, /WHEN candidate\.match_rule LIKE '%work_email%'/);
  assert.doesNotMatch(calls[0].sql, /personal_email|phone|mailing_address|engagement|storage_key|encryption/i);
  assert.deepEqual(reviews.map((review) => review.status), ["exact_match", "no_exact_match", "rejected", "conflicting_match"]);
  assert.equal(reviews[0].candidates[0].matchRule, "work_email");
  assert.equal(reviews[0].requiresReview, true);
  assert.equal(reviews[1].candidates[0].personId, null);
  assert.equal(reviews[1].candidates[0].matchRule, "no_exact_match");
  assert.equal(reviews[2].hasAuthoritativeIdentifier, false);
  assert.equal(reviews[3].candidates.length, 2);
});

test("match review denies unauthorized roles and cross-organization batches", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager"]) {
    let calls = 0;
    await persistence.getImportMatchCandidates(
      { organizationId: "org-a", userId: "user-a", role },
      "batch-a",
      async () => { calls += 1; return []; },
    );
    assert.equal(calls, 1);
  }
  for (const role of ["cat_admin", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(
      persistence.getImportMatchCandidates(
        { organizationId: "org-a", userId: "user-a", role },
        "batch-a",
        async () => { calls += 1; return []; },
      ),
      /Forbidden/,
    );
    assert.equal(calls, 0);
  }

  const crossOrganization = await persistence.getImportMatchCandidates(
    { organizationId: "org-b", userId: "user-b", role: "local_admin" },
    "batch-a",
    async (_sql, parameters) => parameters[0] === "org-a" ? [{ candidate_id: "must-not-return" }] : [],
  );
  assert.deepEqual(crossOrganization, []);
});

test("import review UI uses validation-error wording, refreshes the queue, and remains read-only", async () => {
  const form = await readFile(new URL("../src/components/ImportPreviewForm.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8");
  const queue = await readFile(new URL("../src/app/imports/page.tsx", import.meta.url), "utf8");
  const importUi = `${form}\n${detail}\n${queue}`;

  assert.doesNotMatch(form, />Conflicts</);
  assert.match(form, /Rows with validation errors/);
  assert.match(form, /useRouter\(\)/);
  assert.match(form, /setSummary\(body\);\s*router\.refresh\(\)/);
  assert.doesNotMatch(form, /window\.location|location\.reload/);
  assert.match(detail, /eyebrow="Data imports"/);
  assert.match(detail, /Unchanged existing/);
  assert.match(detail, /Removed \/ archived employees/);
  assert.match(detail, /summary\.snapshot\?\.leaving \?\? 0/);
  assert.match(detail, /history retained/);
  assert.doesNotMatch(importUi, /<button[^>]*>\s*(Approve|Merge|Create Person|Accept match|Reject match|Resolve match)/i);
  assert.doesNotMatch(importUi, /(INSERT|UPDATE|DELETE)[\s\S]*local801\.(people|person_identifiers|person_contact_methods|membership_events|employment_events|membership_snapshots|membership_snapshot_rows|import_approvals)/i);
});

test("row-level validation errors carry the current batch ID", async () => {
  const sqls = [];
  const file = new File(["Employee ID,Local #\n,0801\n"], "missing-id.csv", { type: "text/csv" });
  await persistence.persistImportReview({
    actor: { organizationId: "org", userId: "user", role: "local_admin" },
    file,
    importKind: "current_roster",
    dependencies: dependencies(sqls),
  });
  const batch = sqls.find(({ sql }) => sql.includes("INSERT INTO local801.import_batches"));
  const error = sqls.find(({ sql }) => sql.includes("jsonb_to_recordset") && sql.includes("INSERT INTO local801.import_errors"));
  assert.equal(error.parameters[1], batch.parameters[0]);
});

test("legacy xls candidates are rejected before encrypted storage", async () => {
  let stored = false;
  await assert.rejects(
    persistence.persistImportReview({
      actor: { organizationId: "org", userId: "user", role: "local_admin" },
      file: csvFile("legacy.xls"),
      importKind: "legacy_cat",
      dependencies: { storeFile: async () => { stored = true; throw new Error("must not store"); } },
    }),
    /Only .xlsx and .csv/,
  );
  assert.equal(stored, false);
});

test("unexpected persistence failures expose only controlled errors and reasons", async () => {
  const statements = [];
  await assert.rejects(
    persistence.persistImportReview({
      actor: { organizationId: "org", userId: "user", role: "local_admin" },
      file: csvFile(),
      importKind: "current_roster",
      dependencies: {
        storeFile: async () => ({ id: "22222222-2222-4222-8222-222222222222", byteSize: 10 }),
        audit: async () => ({ id: "audit" }),
        transaction: async () => { throw new Error("relation local801.import_rows does not exist"); },
        query: async (sql, parameters = []) => {
          statements.push({ sql, parameters });
          if (sql.includes("INSERT INTO local801.import_batches")) return [{ id: parameters[0] }];
          return [];
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "IMPORT_PERSISTENCE_FAILED");
      assert.equal(error.message.includes("relation local801.import_rows"), false);
      return true;
    },
  );
  const rejected = statements.find(({ sql }) => sql.includes("UPDATE local801.import_batches SET state = $3"));
  assert.equal(rejected.parameters[3], "persistence_failed");
  assert.equal(JSON.stringify(rejected).includes("relation local801.import_rows"), false);
});

test("durable audit failures remain controlled and persist only a safe reason", async () => {
  const statements = [];
  await assert.rejects(
    persistence.persistImportReview({
      actor: { organizationId: "org", userId: "user", role: "local_admin" },
      file: csvFile(),
      importKind: "current_roster",
      dependencies: {
        storeFile: async () => ({ id: "22222222-2222-4222-8222-222222222222", byteSize: 10 }),
        audit: async () => { throw new Error("R2 AccessDenied bucket private"); },
        query: async (sql, parameters = []) => {
          statements.push({ sql, parameters });
          if (sql.includes("INSERT INTO local801.import_batches")) return [{ id: parameters[0] }];
          return [];
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "IMPORT_PERSISTENCE_FAILED");
      assert.equal(error.message.includes("R2 AccessDenied bucket private"), false);
      return true;
    },
  );
  const rejected = statements.find(({ sql }) => sql.includes("UPDATE local801.import_batches SET state = $3"));
  assert.equal(rejected.parameters[3], "audit_failed");
  assert.equal(JSON.stringify(statements).includes("R2 AccessDenied bucket private"), false);
});

test("public mapping redacts arbitrary parser, database, R2, and encryption errors", () => {
  for (const detail of [
    "password authentication failed for user secret",
    "relation local801.import_rows does not exist",
    "R2 AccessDenied bucket private",
    "ENCRYPTION_MASTER_KEY invalid",
    "some-internal-parser-stack-detail",
  ]) {
    const response = importErrors.publicImportError(new Error(detail));
    assert.equal(response.code, "IMPORT_PERSISTENCE_FAILED");
    assert.equal(response.message.includes(detail), false);
  }
});

test("batch-scoped error retrieval does not use timestamp association", async () => {
  const queries = [];
  const sameCreatedAt = "2026-08-11T15:00:00.000Z";
  const fixtures = {
    "batch-a": { createdAt: sameCreatedAt, error: "error A" },
    "batch-b": { createdAt: sameCreatedAt, error: "error B" },
  };
  const get = (batchId) => persistence.getImportErrors(
    { organizationId: "org-x", userId: "user-x", role: "local_admin" },
    batchId,
    async (sql, parameters) => {
      queries.push({ sql, parameters });
      return [{ row_number: null, severity: "error", field_name: "file", message: fixtures[batchId].error }];
    },
  );
  assert.equal(fixtures["batch-a"].createdAt, fixtures["batch-b"].createdAt);
  assert.deepEqual(await get("batch-a"), [{ row_number: null, severity: "error", field_name: "file", message: "error A" }]);
  assert.deepEqual(await get("batch-b"), [{ row_number: null, severity: "error", field_name: "file", message: "error B" }]);
  assert.equal(queries.every(({ sql }) => sql.includes("error.import_batch_id = $2")), true);
  assert.equal(queries.some(({ sql }) => sql.includes("batch.created_at") || sql.includes("next_batch.created_at")), false);
  assert.equal(queries.every(({ sql }) => sql.includes("CASE WHEN file.import_batch_id = $2 THEN row.source_row_number ELSE NULL END")), true);
  assert.equal(queries.some(({ sql }) => sql.includes("error.import_row_id IS NULL OR")), false);
});

test("0003 is additive and directly scopes nullable file-level errors", async () => {
  const migration = await readFile(new URL("../db/migrations/0003__import_error_batch_scope.sql", import.meta.url), "utf8");
  assert.match(migration, /add column if not exists import_batch_id uuid/i);
  assert.match(migration, /foreign key \(import_batch_id\) references local801\.import_batches\(id\) on delete cascade/i);
  assert.match(migration, /organization_id, import_batch_id, created_at, id/i);
  assert.doesNotMatch(migration, /alter table local801\.(people|membership_events|import_approvals)/i);
});

test("import history uses bounded organization-scoped keyset pages and opaque cursors", async () => {
  const statements = [];
  const rows = Array.from({ length: 11 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    import_kind: "current_roster",
    state: "validated",
    original_filename: `synthetic-${index + 1}.csv`,
    byte_size: 100,
    created_at: new Date(Date.UTC(2026, 7, 18, 12, 0, 20 - index)).toISOString(),
    total_rows: 1,
    error_count: 0,
    processing_stage: null,
    processed_row_count: null,
    total_row_count: null,
    processing_error_code: null,
    cursor_token: String(index + 1).padStart(64, "a"),
  }));
  const page = await persistence.getImportBatchesPage(
    { organizationId: "11111111-1111-4111-8111-111111111111", userId: "user", role: "membership_data_manager" },
    { pageSize: 10 },
    async (sql, parameters) => {
      statements.push({ sql, parameters });
      return rows;
    },
  );

  assert.equal(page.pageSize, 10);
  assert.equal(page.items.length, 10);
  assert.equal(page.previousCursor, null);
  assert.equal(page.items.some((item) => "cursor_token" in item), false);
  assert.ok(page.nextCursor);
  const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(cursor).sort(), ["createdAt", "direction", "token"]);
  assert.equal(cursor.direction, "after");
  assert.match(cursor.token, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(cursor).includes(rows[9].id), false);
  assert.match(statements[0].sql, /\/\* imports:batch-keyset-page \*\//);
  assert.match(statements[0].sql, /WHERE batch\.organization_id = \$1::uuid/);
  assert.match(statements[0].sql, /\(created_at, cursor_token\) < \(\$2::timestamptz, \$3::text\)/);
  assert.match(statements[0].sql, /ORDER BY created_at DESC, cursor_token DESC/);
  assert.deepEqual(statements[0].parameters, ["11111111-1111-4111-8111-111111111111", null, null, 11]);

  const secondPage = await persistence.getImportBatchesPage(
    { organizationId: "11111111-1111-4111-8111-111111111111", userId: "user", role: "local_admin" },
    { cursor: page.nextCursor, pageSize: 10 },
    async (_sql, parameters) => {
      assert.deepEqual(parameters, ["11111111-1111-4111-8111-111111111111", cursor.createdAt, cursor.token, 11]);
      return [rows[10]];
    },
  );
  const previous = JSON.parse(Buffer.from(secondPage.previousCursor, "base64url").toString("utf8"));
  assert.equal(previous.direction, "before");
  assert.equal(secondPage.nextCursor, null);

  const backToFirstPage = await persistence.getImportBatchesPage(
    { organizationId: "11111111-1111-4111-8111-111111111111", userId: "user", role: "local_admin" },
    { cursor: secondPage.previousCursor, pageSize: 10 },
    async (sql, parameters) => {
      assert.match(sql, /\(created_at, cursor_token\) > \(\$2::timestamptz, \$3::text\)/);
      assert.match(sql, /ORDER BY created_at ASC, cursor_token ASC/);
      assert.deepEqual(parameters, ["11111111-1111-4111-8111-111111111111", previous.createdAt, previous.token, 11]);
      return rows.slice(0, 10).reverse();
    },
  );
  assert.deepEqual(backToFirstPage.items.map((item) => item.id), rows.slice(0, 10).map((item) => item.id));
  assert.equal(backToFirstPage.previousCursor, null);
  assert.ok(backToFirstPage.nextCursor);

  await persistence.getImportBatchesPage(
    { organizationId: "22222222-2222-4222-8222-222222222222", userId: "user", role: "local_admin" },
    { cursor: page.nextCursor, pageSize: 10 },
    async (_sql, parameters) => {
      assert.deepEqual(parameters, ["22222222-2222-4222-8222-222222222222", cursor.createdAt, cursor.token, 11]);
      return [];
    },
  );
});

test("import history ignores malformed cursors and normalizes unbounded page sizes", async () => {
  await persistence.getImportBatchesPage(
    { organizationId: "11111111-1111-4111-8111-111111111111", userId: "user", role: "local_admin" },
    { cursor: "not-a-cursor", pageSize: 500_000 },
    async (_sql, parameters) => {
      assert.deepEqual(parameters, ["11111111-1111-4111-8111-111111111111", null, null, 21]);
      return [];
    },
  );
});
