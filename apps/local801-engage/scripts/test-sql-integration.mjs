import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  IMPORT_PROCESSING_VERSION,
  decideImportProcessingOwnership,
} from "../src/lib/import-processing.ts";
import {
  ensureImportProcessingJobSql,
  readImportProcessingJobOwnershipSql,
  requeueImportProcessingJobSql,
} from "../src/lib/import-processing-sql.ts";
import {
  completeImportProcessing,
  ensureImportProcessingJob,
  failImportProcessing,
  matchImportIdentities,
  parseAndStageImport,
  prepareImportReview,
  scanImportSource,
  validateStagedImport,
} from "../src/lib/import-worker.ts";

const databaseUrl = process.env.LOCAL801_SQL_TEST_DATABASE_URL;
if (!databaseUrl) {
  console.log("SKIP sql integration: LOCAL801_SQL_TEST_DATABASE_URL is not configured.");
  process.exit(0);
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("SQL integration is forbidden in Production.");
}

const parsedUrl = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
if (databaseName !== "local801_sql_test") {
  throw new Error("LOCAL801_SQL_TEST_DATABASE_URL must name exactly local801_sql_test.");
}
if (process.env.LOCAL801_DATABASE_URL) {
  const applicationUrl = new URL(process.env.LOCAL801_DATABASE_URL);
  const applicationIdentity = `${applicationUrl.hostname}:${applicationUrl.port || "5432"}/${decodeURIComponent(applicationUrl.pathname)}`;
  const testIdentity = `${parsedUrl.hostname}:${parsedUrl.port || "5432"}/${decodeURIComponent(parsedUrl.pathname)}`;
  if (applicationIdentity === testIdentity) {
    throw new Error("SQL integration refuses the configured application database.");
  }
}

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const raceSqlA = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const raceSqlB = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
let integrationStep = "disposable database setup";
function beginStep(step) {
  integrationStep = step;
  console.log(`RUN sql integration: ${step}`);
}
function safeParameterTypes(parameters) {
  return parameters.map((value, index) => ({
    position: index + 1,
    type: value === null ? "null" : value instanceof Date ? "Date" : Array.isArray(value) ? "array" : typeof value,
  }));
}
function statementPurpose(statement) {
  return statement.match(/\/\*\s*([^*]+?)\s*\*\//)?.[1]?.trim() ?? "unlabelled SQL";
}
const query = async (statement, parameters = []) => {
  try {
    return await sql.unsafe(statement, [...parameters]);
  } catch (error) {
    console.error("SQL integration failure", {
      step: integrationStep,
      statement: statementPurpose(statement),
      parameterTypes: safeParameterTypes(parameters),
      sqlstate: error && typeof error === "object" && "code" in error ? error.code : "unknown",
    });
    throw error;
  }
};
const transaction = async (statements) => sql.begin(async (tx) => {
  for (const statement of statements) await tx.unsafe(statement.sql, [...(statement.parameters ?? [])]);
});
async function expectSqlState(promise, sqlstate, message) {
  await assert.rejects(promise, (error) => error?.code === sqlstate, message);
}
async function waitForBlockedRace(applicationName) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [activity] = await sql.unsafe(`
      SELECT wait_event_type
      FROM pg_catalog.pg_stat_activity
      WHERE application_name = $1 AND state = 'active'
    `, [applicationName]);
    if (activity?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a PostgreSQL lock.`);
}

try {
  const [{ current_database: currentDatabase }] = await sql`select current_database()`;
  assert.equal(currentDatabase, "local801_sql_test", "Connected database must be exactly local801_sql_test.");
  if (process.env.LOCAL801_SQL_TEST_RESET === "1") {
    await sql.unsafe("drop schema if exists local801 cascade; drop schema if exists reporting cascade;");
  }
  const [state] = await sql`select to_regnamespace('local801') is not null as has_local801,
    to_regnamespace('reporting') is not null as has_reporting`;
  assert.equal(state.has_local801, false, "Disposable test database must not already contain local801.");
  assert.equal(state.has_reporting, false, "Disposable test database must not already contain reporting.");

  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const migrations = (await readdir(migrationsUrl)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.length > 0, "At least one migration is required.");
  const expectedMigrationPrefixes = migrations.map((_, index) => String(index + 1).padStart(4, "0"));
  assert.deepEqual(migrations.map((name) => name.slice(0, 4)), expectedMigrationPrefixes);
  migrations.forEach((migration, index) => {
    assert.match(migration, new RegExp(`^${expectedMigrationPrefixes[index]}__.+\\.sql$`));
  });
  for (const migration of migrations) await sql.unsafe(await readFile(new URL(migration, migrationsUrl), "utf8"));

  const installedConstraints = await sql.unsafe(`
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE connamespace = to_regnamespace('local801')
      AND conname = ANY($1::text[])
    ORDER BY conname
  `, [[
    "import_batches_organization_id_id_uq",
    "import_processing_jobs_attempt_count_ck",
    "import_processing_jobs_batch_org_fk",
    "import_processing_jobs_batch_uq",
    "import_processing_jobs_lifecycle_ck",
    "import_processing_jobs_organization_fk",
    "import_processing_jobs_pkey",
    "import_processing_jobs_safe_error_ck",
    "import_processing_jobs_state_ck",
    "import_processing_jobs_timestamp_order_ck",
    "import_processing_jobs_version_ck",
    "import_processing_jobs_workflow_run_ck",
  ]]);
  assert.deepEqual(installedConstraints.map(({ conname }) => conname), [
    "import_batches_organization_id_id_uq",
    "import_processing_jobs_attempt_count_ck",
    "import_processing_jobs_batch_org_fk",
    "import_processing_jobs_batch_uq",
    "import_processing_jobs_lifecycle_ck",
    "import_processing_jobs_organization_fk",
    "import_processing_jobs_pkey",
    "import_processing_jobs_safe_error_ck",
    "import_processing_jobs_state_ck",
    "import_processing_jobs_timestamp_order_ck",
    "import_processing_jobs_version_ck",
    "import_processing_jobs_workflow_run_ck",
  ]);
  const installedIndexes = await sql.unsafe(`
    SELECT indexname
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'local801'
      AND indexname = ANY($1::text[])
    ORDER BY indexname
  `, [[
    "import_batches_organization_id_id_uq",
    "import_processing_jobs_batch_uq",
    "import_processing_jobs_org_active_progress_idx",
    "import_processing_jobs_pkey",
    "import_processing_jobs_workflow_run_uq",
  ]]);
  assert.deepEqual(installedIndexes.map(({ indexname }) => indexname), [
    "import_batches_organization_id_id_uq",
    "import_processing_jobs_batch_uq",
    "import_processing_jobs_org_active_progress_idx",
    "import_processing_jobs_pkey",
    "import_processing_jobs_workflow_run_uq",
  ]);

  const [{ organization_id: organizationId, actor_id: userId }] = await sql.unsafe(`
    WITH organization AS (
      INSERT INTO local801.organizations (slug, name)
      VALUES ('sql-integration-test', 'SQL Integration Test') RETURNING id
    ), actor AS (
      INSERT INTO local801.users (organization_id, email, display_name)
      SELECT id, 'sql-test-admin@example.test', 'SQL Test Admin' FROM organization RETURNING id, organization_id
    ) SELECT actor.organization_id, actor.id AS actor_id FROM actor
  `);
  const [{ id: secondOrganizationId }] = await sql.unsafe(`
    INSERT INTO local801.organizations (slug, name)
    VALUES ('sql-integration-test-other', 'SQL Integration Test Other') RETURNING id
  `);

  async function createProcessingBatch(ownerOrganizationId, processingStage = "queued") {
    const [{ id }] = await sql.unsafe(`
      INSERT INTO local801.import_batches (organization_id, import_kind, state, processing_stage)
      VALUES ($1, 'current_roster', 'uploaded', $2)
      RETURNING id
    `, [ownerOrganizationId, processingStage]);
    return id;
  }

  async function createQueuedProcessingJob(ownerOrganizationId, batchId) {
    const [job] = await sql.unsafe(`
      INSERT INTO local801.import_processing_jobs
        (organization_id, import_batch_id, processing_version)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [ownerOrganizationId, batchId, IMPORT_PROCESSING_VERSION]);
    return job;
  }

  beginStep("migration 0006 tenant and uniqueness constraints");
  const tenantBatch = await createProcessingBatch(secondOrganizationId);
  await expectSqlState(sql.unsafe(`
    INSERT INTO local801.import_processing_jobs
      (organization_id, import_batch_id, processing_version)
    VALUES ($1, $2, $3)
  `, [organizationId, tenantBatch, IMPORT_PROCESSING_VERSION]), "23503", "Cross-tenant job/batch links must fail.");

  const firstJobBatch = await createProcessingBatch(organizationId);
  const firstJob = await createQueuedProcessingJob(organizationId, firstJobBatch);
  await expectSqlState(sql.unsafe(`
    INSERT INTO local801.import_processing_jobs
      (organization_id, import_batch_id, processing_version)
    VALUES ($1, $2, $3)
  `, [organizationId, firstJobBatch, IMPORT_PROCESSING_VERSION]), "23505", "A batch must have at most one processing job.");

  const secondJobBatch = await createProcessingBatch(organizationId);
  const secondJob = await createQueuedProcessingJob(organizationId, secondJobBatch);
  assert.equal(firstJob.workflow_run_id, null);
  assert.equal(secondJob.workflow_run_id, null, "Different queued jobs may both have null run IDs.");

  await sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = 'wrun-shared', attempt_count = 1,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [firstJob.id]);
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = 'wrun-shared', attempt_count = 1,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23505", "A workflow run must not own two jobs.");

  beginStep("migration 0006 run, lifecycle, and timestamp checks");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = ' ', attempt_count = 1,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Whitespace workflow run IDs must fail.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = ' wrun-padded ', attempt_count = 1,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Whitespace-padded workflow run IDs must fail.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = NULL, attempt_count = 1,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Running jobs require a run ID.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = 'wrun-zero-attempt', attempt_count = 0,
        started_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Running jobs require a claimed attempt.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = 'wrun-no-start', attempt_count = 1,
        started_at = NULL, last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Running jobs require started_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = NULL, attempt_count = 0,
        started_at = NULL, completed_at = NULL, last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Succeeded jobs require complete claimed-run metadata.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = NULL, attempt_count = 1,
        started_at = now(), completed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Succeeded jobs require a run ID.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = 'wrun-succeeded-zero-attempt', attempt_count = 0,
        started_at = now(), completed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Succeeded jobs require a claimed attempt.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = 'wrun-succeeded-no-start', attempt_count = 1,
        started_at = NULL, completed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Succeeded jobs require started_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = 'wrun-no-completion', attempt_count = 1,
        started_at = now(), completed_at = NULL, last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Succeeded jobs require completed_at.");

  const preclaimFailureBatch = await createProcessingBatch(organizationId, "failed");
  const [preclaimFailure] = await sql.unsafe(`
    INSERT INTO local801.import_processing_jobs
      (organization_id, import_batch_id, processing_version, state, safe_error_code, failed_at)
    VALUES ($1, $2, $3, 'failed', 'TENANT_INVARIANT_FAILED', now())
    RETURNING *
  `, [organizationId, preclaimFailureBatch, IMPORT_PROCESSING_VERSION]);
  assert.equal(preclaimFailure.attempt_count, 0);
  assert.equal(preclaimFailure.workflow_run_id, null);

  const claimedFailureBatch = await createProcessingBatch(organizationId, "failed");
  const [claimedFailure] = await sql.unsafe(`
    INSERT INTO local801.import_processing_jobs
      (organization_id, import_batch_id, processing_version, workflow_run_id, state,
       attempt_count, safe_error_code, started_at, failed_at)
    VALUES ($1, $2, $3, 'wrun-claimed-failure', 'failed', 1,
      'R2_TEMPORARY_FAILURE', now(), now())
    RETURNING *
  `, [organizationId, claimedFailureBatch, IMPORT_PROCESSING_VERSION]);
  assert.equal(claimedFailure.attempt_count, 1);
  assert.equal(claimedFailure.workflow_run_id, "wrun-claimed-failure");

  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'failed', workflow_run_id = NULL, attempt_count = 1,
        started_at = now(), safe_error_code = 'INTERNAL_PROCESSING_FAILURE',
        failed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Preclaim failure metadata must not contain a claimed attempt.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'failed', workflow_run_id = 'wrun-ambiguous-failure', attempt_count = 0,
        started_at = NULL, safe_error_code = 'INTERNAL_PROCESSING_FAILURE',
        failed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Claimed failure metadata must contain an attempt and start time.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'failed', workflow_run_id = 'wrun-double-terminal', attempt_count = 1,
        started_at = now(), completed_at = now(), safe_error_code = 'INTERNAL_PROCESSING_FAILURE',
        failed_at = now(), last_progress_at = now(), updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "Failed jobs must not also be completed.");

  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs SET updated_at = created_at - interval '1 second' WHERE id = $1
  `, [secondJob.id]), "23514", "updated_at must not precede created_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs SET last_progress_at = queued_at - interval '1 second' WHERE id = $1
  `, [secondJob.id]), "23514", "last_progress_at must not precede queued_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'running', workflow_run_id = 'wrun-start-order', attempt_count = 1,
        started_at = queued_at - interval '1 second', updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "started_at must not precede queued_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'succeeded', workflow_run_id = 'wrun-complete-order', attempt_count = 1,
        started_at = queued_at, completed_at = queued_at - interval '1 second', updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "completed_at must not precede started_at.");
  await expectSqlState(sql.unsafe(`
    UPDATE local801.import_processing_jobs
    SET state = 'failed', workflow_run_id = 'wrun-failure-order', attempt_count = 1,
        started_at = queued_at, failed_at = queued_at - interval '1 second',
        safe_error_code = 'INTERNAL_PROCESSING_FAILURE', updated_at = now()
    WHERE id = $1
  `, [secondJob.id]), "23514", "failed_at must not precede a claimed start.");

  beginStep("migration 0006 requeue and ensure-job CAS fixtures");
  const casBatch = await createProcessingBatch(organizationId);
  const casJob = await createQueuedProcessingJob(organizationId, casBatch);
  const firstClaim = await sql.unsafe(ensureImportProcessingJobSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION, "wrun-CAS-A",
  ]);
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0].attempt_count, 1);
  const sameRunClaim = await sql.unsafe(ensureImportProcessingJobSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION, "wrun-CAS-A",
  ]);
  assert.equal(sameRunClaim.length, 0, "CAS replays must not increment the attempt.");
  const [sameRunOwnership] = await sql.unsafe(readImportProcessingJobOwnershipSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION,
  ]);
  assert.equal(decideImportProcessingOwnership({
    state: sameRunOwnership.state,
    workflowRunId: sameRunOwnership.workflow_run_id,
  }, "wrun-CAS-A"), "already_owned");
  const differentRunClaim = await sql.unsafe(ensureImportProcessingJobSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION, "wrun-CAS-B",
  ]);
  assert.equal(differentRunClaim.length, 0, "A different run must not take ownership.");
  assert.equal(decideImportProcessingOwnership({
    state: sameRunOwnership.state,
    workflowRunId: sameRunOwnership.workflow_run_id,
  }, "wrun-CAS-B"), "not_owner");

  await sql.begin(async (tx) => {
    await tx.unsafe(`
      UPDATE local801.import_processing_jobs
      SET state = 'failed', safe_error_code = 'WORKFLOW_TEMPORARY_FAILURE',
          failed_at = now(), last_progress_at = now(), updated_at = now()
      WHERE id = $1
    `, [casJob.id]);
    await tx.unsafe(`
      UPDATE local801.import_batches
      SET processing_stage = 'failed', processing_error_code = 'WORKFLOW_TEMPORARY_FAILURE'
      WHERE organization_id = $1 AND id = $2
    `, [organizationId, casBatch]);
  });
  const [resetJob] = await sql.unsafe(requeueImportProcessingJobSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION,
  ]);
  assert.equal(resetJob.state, "queued");
  assert.equal(resetJob.workflow_run_id, null);
  assert.equal(resetJob.started_at, null);
  assert.equal(resetJob.completed_at, null);
  assert.equal(resetJob.failed_at, null);
  assert.equal(resetJob.safe_error_code, null);
  assert.equal(resetJob.attempt_count, 1);
  assert.equal(resetJob.processing_version, IMPORT_PROCESSING_VERSION);
  assert.equal(Number(resetJob.last_progress_at), Number(resetJob.updated_at));
  const [resetBatch] = await sql.unsafe(`
    SELECT processing_stage, processing_error_code
    FROM local801.import_batches
    WHERE organization_id = $1 AND id = $2
  `, [organizationId, casBatch]);
  assert.deepEqual(resetBatch, { processing_stage: "queued", processing_error_code: null });
  const secondClaim = await sql.unsafe(ensureImportProcessingJobSql, [
    organizationId, casBatch, IMPORT_PROCESSING_VERSION, "wrun-CAS-C",
  ]);
  assert.equal(secondClaim.length, 1);
  assert.equal(secondClaim[0].attempt_count, 2, "Only a successful new claim increments the attempt.");

  const scanningBatch = await createProcessingBatch(organizationId, "scanning");
  assert.equal(typeof scanningBatch, "string", "Migration 0006 must allow the scanning stage.");

  beginStep("durable failure transition and audit deduplication");
  const [{ id: failureBatchId }] = await sql.unsafe(`INSERT INTO local801.import_batches
    (organization_id, import_kind, state, uploaded_by, processing_stage, processed_row_count)
    VALUES ($1, 'current_roster', 'uploaded', $2, 'queued', 0) RETURNING id`, [organizationId, userId]);
  await sql.unsafe(`INSERT INTO local801.import_processing_jobs
    (organization_id, import_batch_id, processing_version) VALUES ($1, $2, $3)`,
  [organizationId, failureBatchId, IMPORT_PROCESSING_VERSION]);
  const failureInput = { organizationId, batchId: failureBatchId };
  assert.equal(await ensureImportProcessingJob(failureInput, "wrun-sql-failure", query), "claim");
  await failImportProcessing(failureInput, "wrun-sql-failure", "SCANNER_UNAVAILABLE", query);
  await failImportProcessing(failureInput, "wrun-sql-failure", "SCANNER_UNAVAILABLE", query);
  const [failedState] = await sql.unsafe(`SELECT job.state, job.safe_error_code,
      batch.processing_stage, batch.processing_error_code,
      (SELECT count(*)::int FROM local801.audit_events audit WHERE audit.organization_id = $1
        AND audit.subject_id = $2 AND audit.event_type = 'import.processing_failed') AS failure_audits
    FROM local801.import_processing_jobs job JOIN local801.import_batches batch
      ON batch.organization_id = job.organization_id AND batch.id = job.import_batch_id
    WHERE job.organization_id = $1 AND job.import_batch_id = $2`, [organizationId, failureBatchId]);
  assert.deepEqual(failedState, { state: "failed", safe_error_code: "SCANNER_UNAVAILABLE",
    processing_stage: "failed", processing_error_code: "SCANNER_UNAVAILABLE", failure_audits: 1 });

  await sql.unsafe(`
    INSERT INTO local801.people
      (id, organization_id, first_name, last_name, membership_status, department, classification, work_location)
    SELECT gen_random_uuid(), $1, 'Synthetic', 'Member' || lpad(value::text, 5, '0'), 'member',
      'Operations', 'Synthetic Classification', 'Synthetic Location'
    FROM generate_series(1, 20000) value
  `, [organizationId]);

  beginStep("durable 25K CSV worker with replayed chunk response");
  const [{ batch_id: durableBatchId, file_id: durableFileId }] = await sql.unsafe(`
    WITH batch AS (
      INSERT INTO local801.import_batches
        (organization_id, import_kind, state, uploaded_by, processing_stage, processed_row_count)
      VALUES ($1, 'current_roster', 'uploaded', $2, 'queued', 0) RETURNING id
    ), file AS (
      INSERT INTO local801.import_files
        (organization_id, import_batch_id, original_filename, media_type, byte_size,
         storage_key, sha256, malware_scan_status)
      SELECT $1, id, 'synthetic-durable-25000.csv', 'text/csv', 1,
        'local801/imports/2026/08/00000000-0000-4000-8000-000000000025', repeat('b', 64), 'pending'
      FROM batch RETURNING id, import_batch_id
    ), job AS (
      INSERT INTO local801.import_processing_jobs
        (organization_id, import_batch_id, processing_version)
      SELECT $1, id, $3 FROM batch
    ) SELECT file.import_batch_id AS batch_id, file.id AS file_id FROM file
  `, [organizationId, userId, IMPORT_PROCESSING_VERSION]);
  const durableInput = { organizationId, batchId: durableBatchId };
  const durableRunId = "wrun-sql-durable-25000";
  const header = "Local #,Employee ID,Work Email,First Name,Last Name,Department,Classification,Membership Status";
  const csvLines = [header];
  for (let value = 1; value <= 25000; value += 1) {
    csvLines.push(`801,SYNTH-WORKER-${String(value).padStart(5, "0")},worker-${value}@example.test,Synthetic,Worker${String(value).padStart(5, "0")},Operations,Synthetic Classification,member`);
  }
  const durableSource = {
    id: durableFileId,
    plaintext: Buffer.from(csvLines.join("\n")),
    mediaType: "text/csv",
    originalFilename: "synthetic-durable-25000.csv",
    sha256: "b".repeat(64),
  };
  const loadSource = async () => durableSource;
  const authoritativeTables = ["people", "person_identifiers", "person_contact_methods", "membership_events",
    "employment_events", "membership_snapshots", "membership_snapshot_rows", "import_approvals"];
  const authoritativeCount = async () => Object.fromEntries(await Promise.all(authoritativeTables.map(async (table) => {
    const [{ count }] = await sql.unsafe(`SELECT count(*)::int AS count FROM local801.${table}`);
    return [table, count];
  })));
  const beforeDurable = await authoritativeCount();
  assert.equal(await ensureImportProcessingJob(durableInput, durableRunId, query), "claim");
  assert.equal(await ensureImportProcessingJob(durableInput, durableRunId, query), "already_owned");
  await scanImportSource(durableInput, durableRunId, { query, loadSource, scanner: { scan: async () => ({ outcome: "clean" }) } });
  let transactionCalls = 0;
  const responseLossAfterChunk17 = async (statements) => {
    await transaction(statements);
    transactionCalls += 1;
    if (transactionCalls === 18) throw new Error("synthetic committed-response loss");
  };
  await assert.rejects(parseAndStageImport(durableInput, durableRunId, {
    query, transaction: responseLossAfterChunk17, loadSource,
  }), /committed-response loss/);
  const [{ processed_row_count: partialProgress }] = await sql.unsafe(`SELECT processed_row_count
    FROM local801.import_batches WHERE organization_id = $1 AND id = $2`, [organizationId, durableBatchId]);
  assert.equal(partialProgress, 8500);
  await parseAndStageImport(durableInput, durableRunId, { query, transaction, loadSource });
  const [{ staged_count: stagedCount, distinct_rows: distinctRows }] = await sql.unsafe(`
    SELECT count(*)::int AS staged_count, count(DISTINCT row.source_row_number)::int AS distinct_rows
    FROM local801.import_rows row JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id
    JOIN local801.import_files file ON file.id = sheet.import_file_id
    WHERE row.organization_id = $1 AND file.import_batch_id = $2
  `, [organizationId, durableBatchId]);
  assert.equal(stagedCount, 25000);
  assert.equal(distinctRows, 25000);
  await validateStagedImport(durableInput, durableRunId, { query, transaction });
  await matchImportIdentities(durableInput, durableRunId, { query, transaction });
  await prepareImportReview(durableInput, durableRunId, query);
  await completeImportProcessing(durableInput, durableRunId, query);
  const [durableFinal] = await sql.unsafe(`SELECT batch.processing_stage, batch.processed_row_count,
      batch.total_row_count, job.state, job.attempt_count
    FROM local801.import_batches batch JOIN local801.import_processing_jobs job
      ON job.organization_id = batch.organization_id AND job.import_batch_id = batch.id
    WHERE batch.organization_id = $1 AND batch.id = $2`, [organizationId, durableBatchId]);
  assert.deepEqual(durableFinal, { processing_stage: "ready_for_review", processed_row_count: 25000,
    total_row_count: 25000, state: "succeeded", attempt_count: 1 });
  const [{ ready_audits: readyAudits }] = await sql.unsafe(`SELECT count(*)::int AS ready_audits
    FROM local801.audit_events WHERE organization_id = $1 AND subject_id = $2
      AND event_type = 'import.processing_ready'`, [organizationId, durableBatchId]);
  assert.equal(readyAudits, 1);
  assert.deepEqual(await authoritativeCount(), beforeDurable, "Durable review processing must not mutate authoritative tables.");
  await sql.unsafe(`
    INSERT INTO local801.person_identifiers
      (organization_id, person_id, identifier_type, identifier_value)
    SELECT $1, person.id, 'employee_identifier', 'SYNTH-E-' || row_number() over (order by person.last_name)
    FROM local801.people person WHERE person.organization_id = $1
    ORDER BY person.last_name LIMIT 17000
  `, [organizationId]);

  async function createBatch() {
    const [{ batch_id: batchId, file_id: fileId, sheet_id: sheetId }] = await sql.unsafe(`
      WITH batch AS (
        INSERT INTO local801.import_batches
          (organization_id, import_kind, state, uploaded_by, total_row_count, included_row_count,
           excluded_row_count, rejected_row_count, processed_row_count, processing_stage)
        VALUES ($1, 'current_roster', 'under_review', $2, 20000, 20000, 0, 100, 20000, 'ready_for_review')
        RETURNING id
      ), file AS (
        INSERT INTO local801.import_files
          (organization_id, import_batch_id, original_filename, media_type, byte_size, storage_key, sha256, malware_scan_status)
        SELECT $1, id, 'synthetic-20000.csv', 'text/csv', 1, 'local801/imports/sql-test', repeat('a', 64), 'clean'
        FROM batch RETURNING id, import_batch_id
      ), sheet AS (
        INSERT INTO local801.import_sheets (organization_id, import_file_id, sheet_name, sheet_state, row_count)
        SELECT $1, id, 'Roster', 'included', 20000 FROM file RETURNING id, import_file_id
      ) SELECT file.import_batch_id AS batch_id, file.id AS file_id, sheet.id AS sheet_id FROM file JOIN sheet ON sheet.import_file_id = file.id
    `, [organizationId, userId]);
    await sql.unsafe(`
      INSERT INTO local801.import_rows
        (organization_id, import_sheet_id, source_row_number, row_hash, normalized_json, state)
      SELECT $1, $2, value + 1,
        encode(public.digest(jsonb_build_object(
          'first_name', 'Synthetic',
          'last_name', 'Member' || lpad(value::text, 5, '0'),
          'department', CASE WHEN value between 12001 and 17000 THEN 'Changed Department' ELSE 'Operations' END,
          'classification', 'Synthetic Classification', 'work_location', 'Synthetic Location',
          'membership_status', 'member',
          'employee_identifier', CASE WHEN value <= 17000 THEN 'SYNTH-E-' || value::text
            WHEN value <= 19500 THEN 'SYNTH-NEW-' || value::text ELSE '' END
        )::text, 'sha256'), 'hex'),
        jsonb_strip_nulls(jsonb_build_object(
          'first_name', 'Synthetic',
          'last_name', 'Member' || lpad(value::text, 5, '0'),
          'department', CASE WHEN value between 12001 and 17000 THEN 'Changed Department' ELSE 'Operations' END,
          'classification', 'Synthetic Classification', 'work_location', 'Synthetic Location',
          'membership_status', 'member',
          'employee_identifier', CASE WHEN value <= 17000 THEN 'SYNTH-E-' || value::text
            WHEN value <= 19500 THEN 'SYNTH-NEW-' || value::text ELSE NULL END
        )), CASE WHEN value > 19900 THEN 'rejected' ELSE 'pending' END
      FROM generate_series(1, 20000) value
    `, [organizationId, sheetId]);
    return { batchId, fileId, sheetId };
  }

  const firstBatch = await createBatch();
  const secondBatch = await createBatch();

  // The synthetic fixture changes these tables by tens of thousands of rows in one
  // connection. Refresh planner statistics before exercising the production reads,
  // instead of racing Neon autovacuum and making the acceptance gate nondeterministic.
  await sql.unsafe(`ANALYZE local801.import_batches, local801.import_files,
    local801.import_sheets, local801.import_rows, local801.import_errors,
    local801.import_match_candidates, local801.people, local801.person_identifiers`);

  const { getImportReviewDetail, getImportReviewSummary, setImportReviewDecision } = await import("../src/lib/import-review.ts");
  const { getDirectoryPage } = await import("../src/lib/directory.ts");
  const { getCampaignPopulationPage, getCampaignsPage } = await import("../src/lib/campaigns.ts");
  const context = { organizationId, organizationSlug: "sql-integration-test", userId, email: "sql-test-admin@example.test", role: "local_admin" };

  beginStep("getImportReviewSummary first logical import");
  const firstSummary = await getImportReviewSummary(context, firstBatch.batchId, query);
  beginStep("getImportReviewSummary UUID-independent logical duplicate");
  const secondSummary = await getImportReviewSummary(context, secondBatch.batchId, query);
  assert.deepEqual({
    unchanged: firstSummary.counts.unchangedExisting,
    changed: firstSummary.counts.existingWithChanges,
    proposed: firstSummary.counts.proposedNew,
    attention: firstSummary.counts.needsAttention,
    rejected: firstSummary.counts.rejected,
  }, { unchanged: 12000, changed: 5000, proposed: 2500, attention: 400, rejected: 100 });
  assert.deepEqual(firstSummary.hashes, secondSummary.hashes, "Generated row UUIDs must not change review hashes.");
  beginStep("getImportReviewDetail bounded exception page");
  const detail = await getImportReviewDetail(context, firstBatch.batchId, { category: "needs_attention", pageSize: 100 }, query);
  assert.equal(detail.rows.length, 100);
  assert.equal(typeof detail.nextCursor, "string");

  beginStep("setImportReviewDecision proposed-new set");
  await setImportReviewDecision(context, firstBatch.batchId, "allow_proposed_new", firstSummary.hashes.proposedNew, { query, transaction });
  beginStep("setImportReviewDecision existing-change set");
  await setImportReviewDecision(context, firstBatch.batchId, "acknowledge_existing_changes", firstSummary.hashes.existingChanges, { query, transaction });
  beginStep("getImportReviewSummary after aggregate decisions");
  const decidedSummary = await getImportReviewSummary(context, firstBatch.batchId, query);
  assert.equal(decidedSummary.decisions.proposedNew, true);
  assert.equal(decidedSummary.decisions.existingChanges, true);
  const [{ resolution_count: resolutionCount }] = await sql.unsafe(`select count(*)::int as resolution_count from local801.import_row_resolutions`);
  assert.equal(resolutionCount, 0, "Aggregate decisions must not create per-row resolutions.");

  const [{ current_row: currentRowId }] = await sql.unsafe(`
    select row.id as current_row from local801.import_rows row
    join local801.import_sheets sheet on sheet.id = row.import_sheet_id
    join local801.import_files file on file.id = sheet.import_file_id
    where file.import_batch_id = $1 order by row.source_row_number limit 1
  `, [firstBatch.batchId]);
  const [{ other_row: otherRowId }] = await sql.unsafe(`
    select row.id as other_row from local801.import_rows row
    join local801.import_sheets sheet on sheet.id = row.import_sheet_id
    join local801.import_files file on file.id = sheet.import_file_id
    where file.import_batch_id = $1 order by row.source_row_number limit 1
  `, [secondBatch.batchId]);
  await sql.unsafe(`
    INSERT INTO local801.import_errors (organization_id, import_batch_id, import_row_id, severity, field_name, message)
    VALUES ($1, $2, $3, 'error', 'row', 'Synthetic row error'),
      ($1, $2, NULL, 'error', 'file', 'Synthetic file error'),
      ($1, $2, $4, 'error', 'row', 'Synthetic cross-batch link'),
      ($5, $2, NULL, 'error', 'file', 'Synthetic cross-organization error')
  `, [organizationId, firstBatch.batchId, currentRowId, otherRowId, secondOrganizationId]);
  beginStep("getImportReviewSummary with batch and malformed blockers");
  const blockedSummary = await getImportReviewSummary(context, firstBatch.batchId, query);
  assert.equal(blockedSummary.counts.blockingErrors, 3);
  assert.equal(blockedSummary.counts.needsAttention, 401);
  assert.equal(blockedSummary.blockers, 503);
  await assert.rejects(
    getImportReviewSummary({ ...context, organizationId: secondOrganizationId }, firstBatch.batchId, query),
    /Import not found/,
  );

  beginStep("getDirectoryPage organization-wide keyset page");
  const directory = await getDirectoryPage(context, { pageSize: "100" }, query);
  assert.equal(directory.total, 20000);
  assert.equal(directory.people.length, 100);
  assert.equal(typeof directory.nextCursor, "string");

  const [{ campaign_id: campaignId, campaign_handle: campaignHandle }] = await sql.unsafe(`
    INSERT INTO local801.outreach_campaigns (organization_id, name, status, created_by)
    VALUES ($1, 'Synthetic 20K Campaign', 'active', $2)
    RETURNING id AS campaign_id,
      encode(public.digest('campaign:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') AS campaign_handle
  `, [organizationId, userId]);
  await sql.unsafe(`
    INSERT INTO local801.outreach_campaign_population (organization_id, campaign_id, person_id)
    SELECT $1, $2, id FROM local801.people WHERE organization_id = $1
  `, [organizationId, campaignId]);
  await sql.unsafe(`
    INSERT INTO local801.engagement_assignments
      (organization_id, campaign_id, person_id, primary_user_id, status, created_by)
    SELECT $1, $2, id, $3, CASE WHEN ordinal <= 10000 THEN 'completed' ELSE 'open' END, $3
    FROM (SELECT id, row_number() over (order by last_name) AS ordinal FROM local801.people WHERE organization_id = $1 LIMIT 18000) people
  `, [organizationId, campaignId, userId]);
  await sql.unsafe(`
    INSERT INTO local801.engagement_events
      (organization_id, campaign_id, person_id, recorded_by, contact_method, outcome)
    SELECT $1, $2, id, $3, 'synthetic', 'contacted'
    FROM local801.people WHERE organization_id = $1 ORDER BY last_name LIMIT 12000
  `, [organizationId, campaignId, userId]);
  beginStep("getCampaignsPage aggregate keyset page");
  const campaigns = await getCampaignsPage(context, { pageSize: 25 }, query);
  assert.deepEqual(campaigns.campaigns[0], {
    handle: campaignHandle, name: "Synthetic 20K Campaign", status: "active",
    startsOn: null, endsOn: null, launchedAt: null, population: 20000,
    assigned: 18000, contacted: 12000, completed: 10000, unassigned: 2000,
    overdue: 0, remaining: 10000, completionPercentage: 50,
  });
  beginStep("getCampaignPopulationPage bounded keyset page");
  const population = await getCampaignPopulationPage(context, campaignHandle, { pageSize: 100 }, query);
  assert.equal(population.total, 20000);
  assert.equal(population.people.length, 100);
  assert.equal(population.hasNext, true);
  assert.equal(typeof population.nextCursor, "string");

  beginStep("Stage 17 correction integrity and PostgreSQL race guards");
  const [{ id: integrityOrganizationId }] = await sql.unsafe(`
    INSERT INTO local801.organizations (slug, name)
    VALUES ('sql-stage17-integrity', 'SQL Stage 17 Integrity') RETURNING id
  `);
  const [{ id: integrityReviewerId }] = await sql.unsafe(`
    INSERT INTO local801.users (organization_id, email, display_name)
    VALUES ($1, 'stage17-reviewer@example.test', 'Stage 17 Reviewer') RETURNING id
  `, [integrityOrganizationId]);
  const integrityPeople = await sql.unsafe(`
    INSERT INTO local801.people (organization_id, first_name, last_name, membership_status)
    SELECT $1, 'Synthetic', label, 'unknown'
    FROM unnest($2::text[]) AS labels(label)
    RETURNING id, last_name
  `, [integrityOrganizationId, ["DepartmentRace", "NoPrimaryRace", "ExistingPrimaryRace", "ArchivedTarget", "WorkEmailA", "WorkEmailB", "WorkEmailC"]]);
  const integrityPerson = Object.fromEntries(integrityPeople.map((person) => [person.last_name, person.id]));
  await sql.unsafe(`
    INSERT INTO local801.person_pii
      (organization_id, person_id,
       first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
       last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
       name_sort_encrypted_payload, name_sort_encryption_key_version, name_sort_encryption_format_version)
    SELECT $1, person.id, 'synthetic-first', 'v1', 1, 'synthetic-last', 'v1', 1,
      'synthetic-sort', 'v1', 1
    FROM local801.people person
    WHERE person.organization_id = $1
  `, [integrityOrganizationId]);
  await sql.unsafe(`
    INSERT INTO local801.pii_protection_state
      (organization_id, write_mode, backfill_state, backfill_completed_at,
       protected_read_enabled_at, protected_write_enabled_at, verified_at)
    VALUES ($1, 'protected', 'complete', now(), now(), now(), now())
  `, [integrityOrganizationId]);

  const capture = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
  let staleDepartmentRace;
  await raceSqlA.begin(async (txA) => {
    await txA.unsafe("SET LOCAL application_name TO 'local801-stage17-dq-a'");
    await txA.unsafe(`SELECT local801.lock_data_quality_correction_target($1,$2,false,false,true,false,false,false)`,
      [integrityOrganizationId, integrityPerson.DepartmentRace]);
    await txA.unsafe(`UPDATE local801.people SET department = 'Operations' WHERE organization_id = $1 AND id = $2`,
      [integrityOrganizationId, integrityPerson.DepartmentRace]);
    staleDepartmentRace = capture(raceSqlB.begin(async (txB) => {
      await txB.unsafe("SET LOCAL application_name TO 'local801-stage17-dq-b'");
      await txB.unsafe(`SELECT local801.lock_data_quality_correction_target($1,$2,false,false,true,false,false,false)`,
        [integrityOrganizationId, integrityPerson.DepartmentRace]);
      await txB.unsafe(`UPDATE local801.people SET department = 'Finance' WHERE organization_id = $1 AND id = $2`,
        [integrityOrganizationId, integrityPerson.DepartmentRace]);
      await txB.unsafe(`INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id, event_hash)
        VALUES ($1,$2,'record.update','data_quality_correction',$3,$4)`,
        [integrityOrganizationId, integrityReviewerId, integrityPerson.DepartmentRace, "d".repeat(64)]);
    }));
    await waitForBlockedRace("local801-stage17-dq-b");
  });
  const departmentRaceResult = await staleDepartmentRace;
  assert.equal(departmentRaceResult.error?.code, "P1702", "The losing Data Quality writer must fail stale after waiting.");
  const [departmentRaceState] = await sql.unsafe(`
    SELECT department,
      (SELECT count(*)::int FROM local801.audit_events audit
       WHERE audit.organization_id = $1 AND audit.event_hash = $3) AS losing_audits
    FROM local801.people WHERE organization_id = $1 AND id = $2
  `, [integrityOrganizationId, integrityPerson.DepartmentRace, "d".repeat(64)]);
  assert.deepEqual(departmentRaceState, { department: "Operations", losing_audits: 0 });

  await expectSqlState(sql.begin(async (tx) => {
    await tx.unsafe(`SELECT local801.lock_data_quality_correction_target($1,$2,false,false,true,true,false,false)`,
      [integrityOrganizationId, integrityPerson.DepartmentRace]);
    await tx.unsafe(`UPDATE local801.people SET classification = 'Synthetic Classification' WHERE organization_id = $1 AND id = $2`,
      [integrityOrganizationId, integrityPerson.DepartmentRace]);
  }), "P1702", "A mixed correction must roll back if any requested field became stale.");
  const [mixedState] = await sql.unsafe(`SELECT classification FROM local801.people WHERE organization_id = $1 AND id = $2`,
    [integrityOrganizationId, integrityPerson.DepartmentRace]);
  assert.equal(mixedState.classification, null);

  await sql.unsafe(`UPDATE local801.people SET archived_at = now() WHERE organization_id = $1 AND id = $2`,
    [integrityOrganizationId, integrityPerson.ArchivedTarget]);
  await expectSqlState(sql.begin(async (tx) => {
    await tx.unsafe(`SELECT local801.lock_data_quality_correction_target($1,$2,true,true,false,false,false,false)`,
      [integrityOrganizationId, integrityPerson.ArchivedTarget]);
    await tx.unsafe(`INSERT INTO local801.audit_events
      (organization_id, actor_user_id, event_type, subject_type, subject_id, event_hash)
      VALUES ($1,$2,'record.update','data_quality_correction',$3,$4)`,
      [integrityOrganizationId, integrityReviewerId, integrityPerson.ArchivedTarget, "e".repeat(64)]);
  }), "P1702", "An archived correction target must fail before protected writes or audit.");
  const [archivedDataQualityState] = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM local801.person_identifiers WHERE organization_id = $1 AND person_id = $2) AS identifiers,
      (SELECT count(*)::int FROM local801.person_contact_methods WHERE organization_id = $1 AND person_id = $2) AS contacts,
      (SELECT count(*)::int FROM local801.audit_events WHERE organization_id = $1 AND event_hash = $3) AS audits
  `, [integrityOrganizationId, integrityPerson.ArchivedTarget, "e".repeat(64)]);
  assert.deepEqual(archivedDataQualityState, { identifiers: 0, contacts: 0, audits: 0 });

  const ids = (await sql.unsafe(`SELECT gen_random_uuid() AS id FROM generate_series(1, 24)`)).map((row) => row.id);
  let idOffset = 0;
  const nextId = () => ids[idOffset++];
  const submitCorrection = async (requestId, personId, field) => {
    await sql.unsafe(`SELECT local801.submit_protected_contact_correction($1,$2,$3,$4,$5,$6,$7,1)`,
      [integrityOrganizationId, requestId, personId, integrityReviewerId, field, "synthetic-encrypted-proposal", "v1"]);
  };
  const approveCorrection = (tx, requestId, contactId, field, hash) => tx.unsafe(`
    SELECT local801.approve_protected_contact_correction(
      $1,$2,$3,$4,$5,'assigned_only',$6,$7,1,$8,$9,
      local801.contact_correction_revision(
        $1,$2,
        (SELECT contact.id
         FROM local801.person_contact_methods contact
         WHERE contact.organization_id = $1
           AND contact.person_id = (SELECT person_id FROM local801.contact_correction_requests WHERE id = $2)
           AND contact.contact_type = $5 AND contact.is_primary = true AND contact.archived_at IS NULL
         ORDER BY contact.created_at, contact.id LIMIT 1),
        (SELECT protected.xmin::text
         FROM local801.person_contact_methods contact
         JOIN local801.person_contact_method_pii protected
           ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
         WHERE contact.organization_id = $1
           AND contact.person_id = (SELECT person_id FROM local801.contact_correction_requests WHERE id = $2)
           AND contact.contact_type = $5 AND contact.is_primary = true AND contact.archived_at IS NULL
         ORDER BY contact.created_at, contact.id LIMIT 1)
      )
    )
  `, [integrityOrganizationId, requestId, integrityReviewerId, contactId, field,
    "synthetic-encrypted-contact", "v1", "v1", hash]);

  const initialPhoneRequest = nextId();
  const existingPhoneContact = nextId();
  await submitCorrection(initialPhoneRequest, integrityPerson.ExistingPrimaryRace, "phone");
  await sql.begin((tx) => approveCorrection(tx, initialPhoneRequest, existingPhoneContact, "phone", "1".repeat(64)));
  const existingRaceRequestA = nextId();
  const existingRaceRequestB = nextId();
  await submitCorrection(existingRaceRequestA, integrityPerson.ExistingPrimaryRace, "phone");
  await submitCorrection(existingRaceRequestB, integrityPerson.ExistingPrimaryRace, "phone");
  const [{ revision: queueRevision }] = await sql.unsafe(`
    SELECT local801.contact_correction_revision(
      request.organization_id, request.id, current_contact.contact_method_id::uuid, current_contact.current_contact_version
    ) AS revision
    FROM local801.contact_correction_requests request
    LEFT JOIN LATERAL (
      SELECT contact.id::text AS contact_method_id, protected.xmin::text AS current_contact_version
      FROM local801.person_contact_methods contact
      JOIN local801.person_contact_method_pii protected
        ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
      WHERE contact.organization_id = request.organization_id AND contact.person_id = request.person_id
        AND contact.contact_type = request.field_name AND contact.is_primary = true AND contact.archived_at IS NULL
      ORDER BY contact.created_at, contact.id LIMIT 1
    ) current_contact ON true
    WHERE request.organization_id = $1 AND request.id = $2
  `, [integrityOrganizationId, existingRaceRequestA]);
  assert.match(queueRevision, /^[0-9a-f]{64}$/, "The review queue must emit a valid opaque contact revision.");
  let existingContactRace;
  await raceSqlA.begin(async (txA) => {
    await txA.unsafe("SET LOCAL application_name TO 'local801-stage17-contact-existing-a'");
    await approveCorrection(txA, existingRaceRequestA, existingPhoneContact, "phone", "2".repeat(64));
    await txA.unsafe(`INSERT INTO local801.audit_events
      (organization_id, actor_user_id, event_type, subject_type, subject_id, event_hash)
      VALUES ($1,$2,'record.update','contact_correction_request',$3,$4)`,
      [integrityOrganizationId, integrityReviewerId, existingRaceRequestA, "2".repeat(64)]);
    existingContactRace = capture(raceSqlB.begin(async (txB) => {
      await txB.unsafe("SET LOCAL application_name TO 'local801-stage17-contact-existing-b'");
      await approveCorrection(txB, existingRaceRequestB, existingPhoneContact, "phone", "3".repeat(64));
      await txB.unsafe(`INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id, event_hash)
        VALUES ($1,$2,'record.update','contact_correction_request',$3,$4)`,
        [integrityOrganizationId, integrityReviewerId, existingRaceRequestB, "3".repeat(64)]);
    }));
    await waitForBlockedRace("local801-stage17-contact-existing-b");
  });
  const existingRaceResult = await existingContactRace;
  assert.equal(existingRaceResult.error?.code, "P1701", "A second approval must not overwrite the same contact row.");
  const [existingRaceState] = await sql.unsafe(`
    SELECT request_a.state AS state_a, request_b.state AS state_b,
      protected.contact_value_encrypted_payload AS stored_payload,
      (SELECT count(*)::int FROM local801.audit_events WHERE organization_id = $1 AND event_hash = $5) AS losing_audits
    FROM local801.contact_correction_requests request_a
    JOIN local801.contact_correction_requests request_b ON request_b.id = $3
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = request_a.organization_id AND protected.contact_method_id = $4
    WHERE request_a.organization_id = $1 AND request_a.id = $2
  `, [integrityOrganizationId, existingRaceRequestA, existingRaceRequestB, existingPhoneContact, "3".repeat(64)]);
  assert.deepEqual(existingRaceState, {
    state_a: "approved", state_b: "submitted", stored_payload: "synthetic-encrypted-contact", losing_audits: 0,
  });
  await expectSqlState(sql.begin((tx) => approveCorrection(
    tx, existingRaceRequestA, existingPhoneContact, "phone", "4".repeat(64),
  )), "P1701", "A decided contact request must not be replayed.");

  const noPrimaryRequestA = nextId();
  const noPrimaryRequestB = nextId();
  const noPrimaryContactA = nextId();
  const noPrimaryContactB = nextId();
  await submitCorrection(noPrimaryRequestA, integrityPerson.NoPrimaryRace, "phone");
  await submitCorrection(noPrimaryRequestB, integrityPerson.NoPrimaryRace, "phone");
  let noPrimaryRace;
  await raceSqlA.begin(async (txA) => {
    await txA.unsafe("SET LOCAL application_name TO 'local801-stage17-contact-new-a'");
    await approveCorrection(txA, noPrimaryRequestA, noPrimaryContactA, "phone", "5".repeat(64));
    noPrimaryRace = capture(raceSqlB.begin(async (txB) => {
      await txB.unsafe("SET LOCAL application_name TO 'local801-stage17-contact-new-b'");
      await approveCorrection(txB, noPrimaryRequestB, noPrimaryContactB, "phone", "6".repeat(64));
    }));
    await waitForBlockedRace("local801-stage17-contact-new-b");
  });
  const noPrimaryRaceResult = await noPrimaryRace;
  assert.equal(noPrimaryRaceResult.error?.code, "P1701");
  const [noPrimaryState] = await sql.unsafe(`SELECT count(*)::int AS primary_count
    FROM local801.person_contact_methods
    WHERE organization_id = $1 AND person_id = $2 AND contact_type = 'phone'
      AND is_primary = true AND archived_at IS NULL`, [integrityOrganizationId, integrityPerson.NoPrimaryRace]);
  assert.equal(noPrimaryState.primary_count, 1);

  const archivedRequest = nextId();
  const archivedContact = nextId();
  const archivedApprovalPerson = await sql.begin(async (tx) => {
    const [{ id }] = await tx.unsafe(`
      INSERT INTO local801.people (organization_id, first_name, last_name, membership_status)
      VALUES ($1,'Synthetic','ArchivedApproval','unknown') RETURNING id
    `, [integrityOrganizationId]);
    await tx.unsafe(`INSERT INTO local801.person_pii
      (organization_id, person_id,
       first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
       last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
       name_sort_encrypted_payload, name_sort_encryption_key_version, name_sort_encryption_format_version)
      VALUES ($1,$2,'synthetic-first','v1',1,'synthetic-last','v1',1,'synthetic-sort','v1',1)`,
      [integrityOrganizationId, id]);
    return id;
  });
  await submitCorrection(archivedRequest, archivedApprovalPerson, "phone");
  await sql.unsafe(`UPDATE local801.people SET archived_at = now() WHERE organization_id = $1 AND id = $2`,
    [integrityOrganizationId, archivedApprovalPerson]);
  await expectSqlState(sql.begin((tx) => approveCorrection(
    tx, archivedRequest, archivedContact, "phone", "7".repeat(64),
  )), "P1701", "An approval must fail if the person was archived after service resolution.");
  const [archivedApprovalState] = await sql.unsafe(`
    SELECT request.state,
      (SELECT count(*)::int FROM local801.person_contact_methods contact
       WHERE contact.organization_id = $1 AND contact.person_id = $3) AS contacts
    FROM local801.contact_correction_requests request
    WHERE request.organization_id = $1 AND request.id = $2
  `, [integrityOrganizationId, archivedRequest, archivedApprovalPerson]);
  assert.deepEqual(archivedApprovalState, { state: "submitted", contacts: 0 });

  const workRequestA = nextId();
  const workRequestB = nextId();
  const workContactA = nextId();
  const workContactB = nextId();
  await submitCorrection(workRequestA, integrityPerson.WorkEmailA, "work_email");
  await submitCorrection(workRequestB, integrityPerson.WorkEmailB, "work_email");
  let workEmailRace;
  await raceSqlA.begin(async (txA) => {
    await txA.unsafe("SET LOCAL application_name TO 'local801-stage17-work-email-a'");
    await approveCorrection(txA, workRequestA, workContactA, "work_email", "8".repeat(64));
    workEmailRace = capture(raceSqlB.begin(async (txB) => {
      await txB.unsafe("SET LOCAL application_name TO 'local801-stage17-work-email-b'");
      await approveCorrection(txB, workRequestB, workContactB, "work_email", "8".repeat(64));
    }));
    await waitForBlockedRace("local801-stage17-work-email-b");
  });
  const workEmailRaceResult = await workEmailRace;
  assert.equal(workEmailRaceResult.error?.code, "23505", "Concurrent protected work-email duplicates must fail.");
  const workRequestC = nextId();
  const workContactC = nextId();
  await submitCorrection(workRequestC, integrityPerson.WorkEmailC, "work_email");
  await expectSqlState(sql.begin((tx) => approveCorrection(
    tx, workRequestC, workContactC, "work_email", "8".repeat(64),
  )), "23505", "Sequential protected work-email duplicates must fail.");
  const [workEmailState] = await sql.unsafe(`
    SELECT
      (SELECT count(*)::int FROM local801.person_contact_methods contact
       WHERE contact.organization_id = $1 AND contact.contact_type = 'work_email'
         AND contact.archived_at IS NULL) AS active_contacts,
      (SELECT count(*)::int FROM local801.pii_exact_indexes exact_index
       WHERE exact_index.organization_id = $1 AND exact_index.entity_type = 'person_contact_method'
         AND exact_index.index_domain = 'contact:work-email' AND exact_index.index_key_version = 'v1'
         AND exact_index.index_hash = $4) AS exact_indexes,
      (SELECT state FROM local801.contact_correction_requests WHERE organization_id = $1 AND id = $2) AS concurrent_loser_state,
      (SELECT state FROM local801.contact_correction_requests WHERE organization_id = $1 AND id = $3) AS sequential_loser_state
  `, [integrityOrganizationId, workRequestB, workRequestC, "8".repeat(64)]);
  assert.deepEqual(workEmailState, {
    active_contacts: 1, exact_indexes: 1, concurrent_loser_state: "submitted", sequential_loser_state: "submitted",
  });

  console.log(`PASS sql integration: migrations ${expectedMigrationPrefixes[0]}-${expectedMigrationPrefixes.at(-1)}, Stage 17 correction races, durable-job CAS, replay-safe 25K CSV worker, and real 20K service queries completed in a disposable test database.`);
} finally {
  await Promise.all([raceSqlA.end({ timeout: 5 }), raceSqlB.end({ timeout: 5 })]);
  await sql.end({ timeout: 5 });
}
