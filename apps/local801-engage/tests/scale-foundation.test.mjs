import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardForRole } from "../src/lib/access.ts";
import { __testing as campaignTesting, getCampaignPopulationPage, getCampaignsPage } from "../src/lib/campaigns.ts";
import { getDirectoryPage, MAX_DIRECTORY_PAGE_SIZE } from "../src/lib/directory.ts";
import { getImportReviewDetail, getImportReviewSummary, IMPORT_REVIEW_CLASSIFICATION_CTE, IMPORT_REVIEW_TOKEN_CTE, setImportReviewDecision, summarizeGeneratedReviewRows } from "../src/lib/import-review.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const context = (role = "local_admin") => ({ organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role });
const uuid = (index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
const opaqueHandle = (index) => Number(index).toString(16).padStart(64, "0");

test("generated 20,000-row review remains summary/exception driven with at most two routine decisions", () => {
  const categories = [
    ...Array(12_000).fill("unchanged_existing"),
    ...Array(5_000).fill("existing_with_changes"),
    ...Array(2_500).fill("proposed_new"),
    ...Array(400).fill("needs_attention"),
    ...Array(100).fill("rejected"),
  ];
  const summary = summarizeGeneratedReviewRows(categories);
  assert.equal(categories.length, 20_000);
  assert.deepEqual(summary.counts, { unchanged_existing: 12_000, existing_with_changes: 5_000, proposed_new: 2_500, needs_attention: 400, rejected: 100 });
  assert.equal(summary.routineDecisionCount, 2);
  assert.equal(summary.blocked, true);
});

test("import classification uses live authoritative evidence, set hashing, and no name matching", () => {
  assert.match(IMPORT_REVIEW_CLASSIFICATION_CTE, /person_identifiers/);
  assert.match(IMPORT_REVIEW_CLASSIFICATION_CTE, /person_contact_methods/);
  assert.match(IMPORT_REVIEW_CLASSIFICATION_CTE, /organization_id = \$1/g);
  assert.doesNotMatch(IMPORT_REVIEW_CLASSIFICATION_CTE, /person\.(first_name|last_name|preferred_name)\s*=\s*row/i);
  assert.match(IMPORT_REVIEW_CLASSIFICATION_CTE, /batch_errors AS[\s\S]*error\.organization_id = \$1[\s\S]*error\.import_batch_id = \$2[\s\S]*severity = 'error'/);
  assert.match(IMPORT_REVIEW_CLASSIFICATION_CTE, /LEFT JOIN batch_rows row ON row\.import_row_id = error\.import_row_id/);
  assert.doesNotMatch(IMPORT_REVIEW_CLASSIFICATION_CTE, /SELECT count\(\*\)[\s\S]*WHERE error\.import_row_id = row\.import_row_id/);
  assert.match(IMPORT_REVIEW_TOKEN_CTE, /source_file_sha256[\s\S]*sheet_name[\s\S]*source_row_number[\s\S]*row_hash[\s\S]*category/);
  assert.doesNotMatch(IMPORT_REVIEW_TOKEN_CTE, /import_row_id|created_at|updated_at/);
});

test("review set aggregation uses valid deterministic delimiter syntax", async () => {
  const service = await readFile(new URL("../src/lib/import-review.ts", import.meta.url), "utf8");
  assert.match(service, /string_agg\(canonical_token, ':' ORDER BY canonical_token\)/);
  assert.doesNotMatch(service, /string_agg\(canonical_token\s+ORDER BY/);
});

test("20,000-row import detail response is bounded to the hard maximum and strips internal IDs", async () => {
  let calls = 0; let sqlText = "";
  const rows = Array.from({ length: 101 }, (_, index) => ({
    import_row_id: uuid(index + 1), sheet_name: "Roster", source_row_number: index + 2,
    category: "needs_attention", first_name: `Synthetic${index}`, last_name: "Person",
    work_email: `synthetic${index}@example.test`, department: "Synthetic Department",
    classification: "Synthetic Classification", membership_status: "unknown", person_id: null,
  }));
  const result = await getImportReviewDetail(context(), uuid(900), { pageSize: 100 }, async (sql, parameters) => {
    calls += 1; sqlText = sql; assert.equal(parameters.at(-1), 101); return rows;
  });
  assert.equal(calls, 1);
  assert.equal(result.rows.length, 100);
  assert.equal(typeof result.nextCursor, "string");
  assert.equal("import_row_id" in result.rows[0], false);
  assert.equal("person_id" in result.rows[0], false);
  assert.match(sqlText, /LIMIT \$8/);
  assert.doesNotMatch(sqlText, /OFFSET/i);
});

test("review decisions are hash-bound, stale when the set changes, and require no row decisions", async () => {
  const currentHash = "a".repeat(64);
  const summaryRow = {
    total_rows: "20000", included_rows: "20000", excluded_rows: "0", rejected_rows: "0",
    unchanged_existing: "15000", existing_with_changes: "3000", proposed_new: "2000",
    needs_attention: "0", rejected: "0", blocking_error_count: "0", unassociated_blocking_error_count: "0", eligible_new_set_hash: currentHash,
    existing_changes_set_hash: "c".repeat(64), import_kind: "new_hires", previous_snapshot_date: null,
    previous_snapshot_count: "0", proposed_snapshot_count: "0", entering_snapshot: "0", leaving_snapshot: "0",
  };
  let calls = 0;
  const summary = await getImportReviewSummary(context(), uuid(901), async () => {
    calls += 1;
    return calls === 1 ? [summaryRow] : [{ decision_type: "allow_proposed_new", set_hash: "b".repeat(64), set_count: "2000", decided_at: new Date() }];
  });
  assert.equal(calls, 2);
  assert.equal(summary.decisions.proposedNew, false);
  assert.equal(summary.clicksRequired, 2);
  assert.equal(summary.counts.unchangedExisting, 15_000);
});

test("batch review decision and PII-free audit statement are one atomic transaction", async () => {
  const transactions = [];
  await setImportReviewDecision(context(), uuid(902), "allow_proposed_new", "a".repeat(64), {
    query: async (sql) => sql.includes("SELECT event_hash") ? [{ event_hash: "previous" }] : [],
    transaction: async (statements) => transactions.push(statements),
  });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  assert.match(transactions[0][0].sql, /import_batch_review_decisions/);
  assert.match(transactions[0][0].sql, /batch\.organization_id = \$1/);
  assert.match(transactions[0][0].sql, /current_set\.set_hash = \$6/);
  assert.match(transactions[0][1].sql, /local801\.audit_events/);
  assert.doesNotMatch(JSON.stringify(transactions[0][1].parameters), /name|email|phone|normalized/i);
});

test("unauthorized batch review decisions fail before database or transaction work", async () => {
  let calls = 0;
  await assert.rejects(setImportReviewDecision(context("cat_admin"), uuid(903), "allow_proposed_new", "a".repeat(64), {
    query: async () => { calls += 1; return []; }, transaction: async () => { calls += 1; },
  }), /Forbidden/);
  assert.equal(calls, 0);
});

test("generated 20,000-person Directory search returns at most 100 deterministic rows", async () => {
  const fixture = Array.from({ length: 20_000 }, (_, index) => ({
    person_id: uuid(index + 1), preferred_name: null, first_name: `Synthetic${String(index).padStart(5, "0")}`,
    last_name: "Member", membership_status: "member", department: "Synthetic Department",
    section: null, classification: "Synthetic Classification", work_location: "Synthetic Location",
    work_email: `member${index}@example.test`, total_count: "20000",
  }));
  let calls = 0; let sqlText = "";
  const result = await getDirectoryPage(context(), { pageSize: "100", term: "Synthetic" }, async (sql, parameters) => {
    calls += 1; sqlText = sql; assert.equal(parameters[10], 101); assert.equal(parameters[11], true); return fixture.slice(0, 101);
  });
  assert.equal(calls, 1);
  assert.equal(result.total, 20_000);
  assert.equal(result.people.length, MAX_DIRECTORY_PAGE_SIZE);
  assert.equal(typeof result.nextCursor, "string");
  assert.match(sqlText, /person\.organization_id = \$1/);
  assert.match(sqlText, /ORDER BY last_name ASC, first_name ASC, person_id ASC/);
  assert.doesNotMatch(sqlText, /OFFSET/i);
});

test("CAT Directory scope cannot be broadened by query input in a 20,000-person search", async () => {
  let sqlText = "";
  const result = await getDirectoryPage(context("cat_member"), { scope: "authorized", pageSize: "100" }, async (sql) => { sqlText = sql; return []; });
  assert.equal(result.effectiveScope, "assigned");
  assert.match(sqlText, /engagement_assignments assignment/);
  assert.match(sqlText, /assignment\.organization_id = \$1/);
  assert.match(sqlText, /assignment\.primary_user_id = \$2::uuid OR assignment\.backup_user_id = \$2::uuid/);
});

test("large campaign populations stay aggregate-first, opaque, and detail-bounded", async () => {
  const campaignHandle = "c".repeat(64);
  let aggregateSql = "";
  const campaigns = await getCampaignsPage(context("cat_admin"), {}, async (sql) => {
    aggregateSql = sql;
    return [{
      campaign_handle: campaignHandle,
      name: "Synthetic Campaign",
      status: "active",
      starts_on: null,
      ends_on: null,
      launched_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      population_count: "20000",
      assigned_count: "18000",
      contacted_count: "12000",
      completed_count: "10000",
    }];
  });
  assert.equal(campaigns.campaigns[0].population, 20_000);
  assert.equal(campaigns.campaigns[0].remaining, 10_000);
  assert.equal(campaigns.campaigns[0].handle, campaignHandle);
  assert.equal("id" in campaigns.campaigns[0], false);
  assert.match(aggregateSql, /population_counts AS/);
  assert.match(aggregateSql, /count\(DISTINCT person_id\).*assigned_count/);
  assert.match(aggregateSql, /campaign\.organization_id = \$1/);
  assert.match(aggregateSql, /public\.digest\('campaign:'/);

  const population = Array.from({ length: 20_000 }, (_, index) => ({
    person_handle: opaqueHandle(index + 1),
    first_name: `Synthetic${index}`,
    last_name: "Participant",
    department: "Synthetic",
    assignment_status: "open",
    assignee_name: "Synthetic CAT Lead",
    assignment_due_at: null,
    total_count: "20000",
  }));
  let detailSql = "";
  const detail = await getCampaignPopulationPage(context("cat_admin"), campaignHandle, { pageSize: 100 }, async (sql, parameters) => {
    detailSql = sql;
    assert.equal(parameters[1], campaignHandle);
    assert.equal(parameters.at(-1), 101);
    return population.slice(0, 101);
  });
  assert.equal(detail.people.length, 100);
  assert.equal(detail.total, 20_000);
  assert.equal(detail.hasNext, true);
  assert.equal("person_id" in detail.people[0], false);
  assert.match(detail.people[0].personHandle, /^[0-9a-f]{64}$/);
  assert.match(detailSql, /member\.organization_id = \$1/);
  assert.match(detailSql, /person_handle > \$7::text/);
  assert.match(detailSql, /digest\(\$1::text \|\| ':' \|\| person\.id::text/);
  assert.doesNotMatch(detailSql, /OFFSET/i);
  assert.doesNotMatch(detailSql, /disabled_at/);
});

test("campaign cursors reject malformed opaque handles and overlong text", () => {
  const invalidCampaign = Buffer.from(JSON.stringify({ createdAt: "2026-08-01T00:00:00.000Z", handle: "not-an-opaque-handle" })).toString("base64url");
  const invalidPopulation = Buffer.from(JSON.stringify({ lastName: "x".repeat(201), firstName: "A", handle: opaqueHandle(1) })).toString("base64url");
  assert.equal(campaignTesting.campaignCursor(invalidCampaign), null);
  assert.equal(campaignTesting.populationCursor(invalidPopulation), null);
});

test("dashboard sections are permission-derived for all seven roles", () => {
  assert.deepEqual(dashboardForRole("membership_data_manager"), { membership: true, organizing: false, campaigns: false, catActions: false, reports: true });
  assert.deepEqual(dashboardForRole("cat_member"), { membership: false, organizing: true, campaigns: false, catActions: false, reports: false });
  assert.deepEqual(dashboardForRole("report_viewer"), { membership: false, organizing: false, campaigns: false, catActions: false, reports: true });
  for (const role of ["system_owner", "local_admin"]) assert.deepEqual(dashboardForRole(role), { membership: true, organizing: true, campaigns: true, catActions: true, reports: true });
  assert.deepEqual(dashboardForRole("cat_admin"), { membership: false, organizing: true, campaigns: true, catActions: true, reports: true });
  assert.deepEqual(dashboardForRole("cat_lead"), { membership: false, organizing: true, campaigns: false, catActions: false, reports: true });
});

test("migration 0005 is additive, transactional, organization scoped, and contains no Phase 2B-2 writes", async () => {
  const migration = await readFile(new URL("../db/migrations/0005__scale_and_review_foundation.sql", import.meta.url), "utf8");
  assert.match(migration, /^begin;/i); assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /import_batch_review_decisions/);
  assert.match(migration, /people_org_directory_order_idx/);
  assert.match(migration, /outreach_campaigns_org_created_id_idx/);
  assert.match(migration, /assignment_org_campaign_person_created_idx/);
  assert.match(migration, /engagement_events_org_campaign_person_idx/);
  assert.match(migration, /import_errors_org_batch_severity_row_idx/);
  assert.doesNotMatch(migration, /documents_org_visibility_created_id_idx/);
  assert.doesNotMatch(migration, /campaign_population_org_campaign_person_idx/);
  assert.match(migration, /organization_id/);
  for (const table of ["people", "person_identifiers", "person_contact_methods", "membership_events", "employment_events", "membership_snapshots", "membership_snapshot_rows", "import_approvals"]) {
    assert.doesNotMatch(migration, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+local801\\.${table}\\b`, "i"));
  }
});

test("20K defaults, honest progress, and bounded error export are explicit", async () => {
  const [config, example, persistence, queue, errorRoute] = await Promise.all([
    readFile(new URL("../src/lib/config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/import-persistence.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/imports/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/imports/[batchId]/errors.csv/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(config, /LOCAL801_IMPORT_MAX_ROWS:[\s\S]*default\(25000\)/);
  assert.match(example, /LOCAL801_IMPORT_MAX_ROWS=25000/);
  assert.match(persistence, /processed_row_count = \$3/);
  assert.match(persistence, /MAX_IMPORT_ERROR_EXPORT_ROWS = 50_000/);
  assert.match(persistence, /LIMIT \$\{MAX_IMPORT_ERROR_EXPORT_ROWS \+ 1\}/);
  assert.match(queue, /source rows processed/);
  assert.match(queue, /function processingLabel/);
  assert.doesNotMatch(queue, /processing_stage\?\.replaceAll/);
  assert.match(errorRoute, /No partial CSV was returned/);
});

test("upload Origin, cache namespace, focus contrast, and legacy boundary are hardened", async () => {
  const [upload, worker, styles, legacy, integration, architecture] = await Promise.all([
    readFile(new URL("../src/app/api/imports/validate/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../src/app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/import-approval.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/test-sql-integration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../docs/architecture.md", import.meta.url), "utf8"),
  ]);
  assert.match(upload, /POST\(request: Request\)[\s\S]*hasExactSameOrigin\(request\)[\s\S]*requirePreviewUser/);
  assert.match(worker, /LOCAL801_CACHE_PREFIX/);
  assert.match(worker, /key\.startsWith\(LOCAL801_CACHE_PREFIX\)/);
  assert.doesNotMatch(worker, /keys\.filter\(\(key\) => key !== CACHE_NAME\)/);
  assert.match(styles, /--focus: #134d8c/);
  assert.match(legacy, /@deprecated[\s\S]*Do not use this[\s\S]*20K approval executor/);
  assert.match(integration, /LOCAL801_SQL_TEST_DATABASE_URL/);
  assert.match(integration, /Disposable test database must not already contain local801/);
  assert.match(integration, /migrations\.map\(\(_, index\) => String\(index \+ 1\)\.padStart\(4, "0"\)\)/);
  assert.doesNotMatch(integration, /expectedMigrationPrefixes = \["0001"/);
  assert.match(integration, /Stage 17 correction integrity and PostgreSQL race guards/);
  assert.match(integration, /waitForBlockedRace/);
  assert.match(integration, /losing Data Quality writer must fail stale/);
  assert.match(integration, /second approval must not overwrite the same contact row/);
  assert.match(integration, /Concurrent protected work-email duplicates must fail/);
  assert.match(architecture, /Every SQL integration gate and migration verification must pass before a draft migration is applied to Preview or Production/);
});

test("import persistence removes per-person identity query loops and uses 500-row chunks", async () => {
  const source = await readFile(new URL("../src/lib/import-persistence.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /findExactMatches/);
  assert.match(source, /chunks<T>\(values: T\[], size = 500\)/);
  assert.match(source, /import:set-based-authoritative-matching/);
  assert.match(source, /jsonb_to_recordset/);
  assert.match(source, /validWorkEmail/);
});

test("audit display reads exclude payload, hash, and previous-hash internals", async () => {
  const source = await readFile(new URL("../src/lib/audit.ts", import.meta.url), "utf8");
  const displayQueries = [...source.matchAll(/SELECT id, event_type, actor_user_id, subject_type, subject_id, created_at/g)];
  assert.equal(displayQueries.length >= 2, true);
  const page = await readFile(new URL("../src/app/audit/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /event\.(payload|event_hash|previous_hash|subject_id)/);
});
