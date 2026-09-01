import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import {
  applyCampaignPopulationChange,
  previewCampaignPopulationChange,
} from "../src/lib/campaign-bulk-population.ts";
import {
  getCampaignOrganizerProgress,
  getCampaignPopulationPage,
} from "../src/lib/campaigns.ts";

const databaseUrl = process.env.LOCAL801_SQL_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.log("SKIP Stage 18 campaign scale: LOCAL801_SQL_TEST_DATABASE_URL is not configured.");
  process.exit(0);
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Stage 18 campaign scale acceptance is forbidden in Production.");
}
const parsed = new URL(databaseUrl);
if (decodeURIComponent(parsed.pathname.replace(/^\//, "")) !== "local801_sql_test") {
  throw new Error("Stage 18 campaign scale acceptance requires a database named exactly local801_sql_test.");
}
if (process.env.LOCAL801_DATABASE_URL) {
  const application = new URL(process.env.LOCAL801_DATABASE_URL);
  if (`${application.hostname}${application.pathname}` === `${parsed.hostname}${parsed.pathname}`) {
    throw new Error("Stage 18 campaign scale acceptance refuses the configured application database.");
  }
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const statements = new Map();
const queryCounts = new Map();
let phase = "setup";
const countQuery = () => queryCounts.set(phase, (queryCounts.get(phase) ?? 0) + 1);
const query = async (statement, parameters = []) => {
  countQuery();
  const purpose = statement.match(/\/\*\s*([^*]+?)\s*\*\//)?.[1]?.trim();
  if (purpose?.startsWith("campaign")) statements.set(purpose, { statement, parameters: [...parameters] });
  return sql.unsafe(statement, [...parameters]);
};
const transaction = (callback) => sql.begin(async (tx) => callback(async (statement, parameters = []) => {
  countQuery();
  const purpose = statement.match(/\/\*\s*([^*]+?)\s*\*\//)?.[1]?.trim();
  if (purpose?.startsWith("campaign")) statements.set(purpose, { statement, parameters: [...parameters] });
  if (phase.endsWith("Retry")) console.log(`RUN Stage 18 retry query: ${purpose ?? "audit"}`);
  const result = await tx.unsafe(statement, [...parameters]);
  if (phase.endsWith("Retry")) console.log(`DONE Stage 18 retry query: ${purpose ?? "audit"}`);
  return result;
}));
const tokenSecret = "stage18-synthetic-scale-confirmation-secret";
const searchMaterial = async () => ({ protectedMode: false, tokens: [], email: null });

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function timed(name, callback) {
  phase = name;
  console.log(`RUN Stage 18 scale: ${name}`);
  const beforeMemory = process.memoryUsage().rss;
  const before = performance.now();
  const value = await callback();
  const result = {
    value,
    metrics: {
      milliseconds: Math.round((performance.now() - before) * 10) / 10,
      queryCount: queryCounts.get(name) ?? 0,
      responseBytes: bytes(value),
      rssDeltaBytes: process.memoryUsage().rss - beforeMemory,
    },
  };
  console.log(`DONE Stage 18 scale: ${name} (${result.metrics.milliseconds} ms)`);
  return result;
}

function planSummary(row) {
  const document = row?.["QUERY PLAN"] ?? row?.["query_plan"];
  const root = Array.isArray(document) ? document[0] : null;
  const plan = root?.Plan;
  return {
    node: plan?.["Node Type"] ?? "unavailable",
    planningMilliseconds: root?.["Planning Time"] ?? null,
    executionMilliseconds: root?.["Execution Time"] ?? null,
    rows: plan?.["Actual Rows"] ?? plan?.["Plan Rows"] ?? null,
    sharedHitBlocks: plan?.["Shared Hit Blocks"] ?? null,
    sharedReadBlocks: plan?.["Shared Read Blocks"] ?? null,
  };
}

async function explain(purpose, analyze) {
  const captured = statements.get(purpose);
  assert.ok(captured, `Missing captured SQL for ${purpose}.`);
  const prefix = analyze ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN (BUFFERS, FORMAT JSON)";
  console.log(`RUN Stage 18 plan: ${purpose} (${analyze ? "analyze" : "estimated"})`);
  const rows = await sql.unsafe(`${prefix} ${captured.statement}`, captured.parameters);
  const result = { analyzed: analyze, ...planSummary(rows[0]) };
  console.log(`DONE Stage 18 plan: ${purpose}`);
  return result;
}

try {
  const [{ current_database: currentDatabase }] = await sql`SELECT current_database()`;
  assert.equal(currentDatabase, "local801_sql_test");
  await sql.unsafe("SET statement_timeout = '10s'");
  if (process.env.LOCAL801_SQL_TEST_RESET === "1") {
    await sql.unsafe("DROP SCHEMA IF EXISTS local801 CASCADE; DROP SCHEMA IF EXISTS reporting CASCADE;");
  }
  const [existing] = await sql`SELECT to_regnamespace('local801') IS NOT NULL AS local801,
    to_regnamespace('reporting') IS NOT NULL AS reporting`;
  assert.equal(existing.local801 || existing.reporting, false, "Disposable scale database must start empty.");

  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) await sql.unsafe(await readFile(new URL(migration, migrationsUrl), "utf8"));

  const [fixture] = await sql.unsafe(`
    WITH organization AS (
      INSERT INTO local801.organizations (slug, name)
      VALUES ('stage18-scale', 'Stage 18 Synthetic Scale') RETURNING id
    ), actor AS (
      INSERT INTO local801.users (organization_id, email, display_name)
      SELECT id, 'stage18-admin@example.test', 'Stage 18 Synthetic Admin' FROM organization
      RETURNING id, organization_id
    ), role AS (
      INSERT INTO local801.workspace_roles (organization_id, code, name, session_seconds)
      SELECT organization_id, 'local_admin', 'Local administrator', 43200 FROM actor RETURNING id
    ), assigned_role AS (
      INSERT INTO local801.workspace_user_roles (user_id, role_id, assigned_by)
      SELECT actor.id, role.id, actor.id FROM actor CROSS JOIN role
    ), campaign AS (
      INSERT INTO local801.outreach_campaigns (organization_id, name, status, created_by)
      SELECT organization_id, 'Stage 18 Synthetic Campaign', 'draft', id FROM actor RETURNING id, organization_id
    )
    SELECT actor.organization_id::text, actor.id::text AS actor_id, campaign.id::text AS campaign_id,
      encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle
    FROM actor CROSS JOIN campaign
  `);
  const insertStart = performance.now();
  await sql.unsafe(`
    INSERT INTO local801.people
      (organization_id, first_name, last_name, membership_status, department, classification, work_location, local_number)
    SELECT $1::uuid, 'Synthetic', 'Member' || lpad(value::text, 5, '0'), 'member',
      CASE WHEN value <= 12000 THEN 'Operations' ELSE 'Field' END,
      CASE WHEN value % 2 = 0 THEN 'Specialist' ELSE 'Representative' END,
      CASE WHEN value % 3 = 0 THEN 'North' ELSE 'Central' END, '0801'
    FROM generate_series(1, 20000) value
  `, [fixture.organization_id]);
  const fixtureMilliseconds = Math.round((performance.now() - insertStart) * 10) / 10;
  const context = { organizationId: fixture.organization_id, organizationSlug: "stage18-scale",
    userId: fixture.actor_id, email: "stage18-admin@example.test", role: "local_admin" };
  const populationCriteria = { membershipStatus: "member", department: "", classification: "", workLocation: "",
    search: "", includeHandles: [], excludeHandles: [] };

  const populationPreview = await timed("populationPreview", () => previewCampaignPopulationChange(
    context, fixture.campaign_handle, { operation: "add", criteria: populationCriteria },
    { query, tokenSecret, searchMaterial },
  ));
  assert.equal(populationPreview.value.matched, 20000);
  assert.equal(populationPreview.value.wouldChange, 20000);
  const populationPreviewPlan = await explain("campaign-bulk-population:preview", true);

  const populationApply = await timed("populationApply", () => applyCampaignPopulationChange(
    context, fixture.campaign_handle,
    { operation: "add", criteria: populationCriteria, confirmationToken: populationPreview.value.confirmationToken },
    { query, transaction, tokenSecret, searchMaterial },
  ));
  assert.equal(populationApply.value.changed, 20000);
  const populationApplyPlan = await explain("campaign-bulk-population:apply", false);
  phase = "populationRetry";
  await assert.rejects(applyCampaignPopulationChange(context, fixture.campaign_handle,
    { operation: "add", criteria: populationCriteria, confirmationToken: populationPreview.value.confirmationToken },
    { query, transaction, tokenSecret, searchMaterial }), (error) => error?.code === "STALE_CONFIRMATION");

  const participantPage = await timed("participantPage", () => getCampaignPopulationPage(
    context, fixture.campaign_handle, { pageSize: 100, assignment: "unassigned", workflow: "not_contacted" }, query,
  ));
  assert.equal(participantPage.value.people.length, 100);
  assert.equal(participantPage.value.total, 20000);
  assert.equal(participantPage.value.hasNext, true);
  assert.ok(participantPage.metrics.responseBytes < 128_000);
  const participantPagePlan = await explain("campaigns:population-keyset-page", false);

  const organizerProgress = await timed("organizerProgress", () => getCampaignOrganizerProgress(
    context, fixture.campaign_handle, query,
  ));
  assert.deepEqual(organizerProgress.value, []);
  const organizerProgressPlan = await explain("campaigns:organizer-progress", false);

  const [databaseState] = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM local801.people WHERE organization_id = $1::uuid) AS people,
      (SELECT count(*)::int FROM local801.outreach_campaign_population WHERE organization_id = $1::uuid) AS population,
      (SELECT count(*)::int FROM local801.engagement_assignments WHERE organization_id = $1::uuid AND archived_at IS NULL) AS assignments,
      (SELECT count(*)::int FROM local801.audit_events WHERE organization_id = $1::uuid
        AND subject_type = 'outreach_campaign' AND payload ? 'bulkPopulation') AS bulk_audits
  `, [fixture.organization_id]);
  assert.deepEqual(databaseState, { people: 20000, population: 20000, assignments: 0, bulk_audits: 1 });

  const evidence = {
    target: { database: currentDatabase, syntheticOnly: true, representedPeople: databaseState.people },
    migrations: migrations.length,
    fixtureMilliseconds,
    operations: {
      populationPreview: populationPreview.metrics,
      populationApply: populationApply.metrics,
      populationRetryQueries: queryCounts.get("populationRetry") ?? 0,
      participantPage: participantPage.metrics,
      organizerProgress: organizerProgress.metrics,
    },
    plans: { populationPreview: populationPreviewPlan, populationApply: populationApplyPlan,
      participantPage: participantPagePlan, organizerProgress: organizerProgressPlan },
    databaseState,
  };
  assert.ok(populationPreview.metrics.responseBytes < 8_192);
  assert.ok(populationPreview.metrics.milliseconds < 30_000);
  assert.ok(populationApply.metrics.milliseconds < 30_000);
  assert.ok(participantPage.metrics.milliseconds < 5_000);
  console.log(`STAGE18_SCALE_EVIDENCE ${JSON.stringify(evidence)}`);
  console.log("PASS Stage 18 campaign scale: real 20K population, retry, audit, pagination, payload, memory, timing, and query-plan evidence.");
} finally {
  await sql.end({ timeout: 5 });
}
