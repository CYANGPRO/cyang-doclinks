import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  IMPORT_PROCESSING_VERSION,
  canAdvanceImportProcessing,
  canAdvanceImportProcessingJob,
  createImportProcessingRequeuePatch,
  createImportWorkflowInput,
  decideImportProcessingOwnership,
  importProcessingFailureDisposition,
  importProcessingJobStates,
  importProcessingSafeErrorCodes,
  importProcessingStages,
  importProcessingStatus,
  isTerminalImportProcessingStage,
  requireCanonicalImportSource,
  scannerAllowsImportParsing,
} from "../src/lib/import-processing.ts";
import {
  ensureImportProcessingJobSql,
  readImportProcessingJobOwnershipSql,
  requeueImportProcessingJobSql,
} from "../src/lib/import-processing-sql.ts";

test("durable import stage and job vocabularies are small and explicit", () => {
  assert.deepEqual(importProcessingStages, [
    "uploaded", "queued", "scanning", "parsing", "validating", "matching",
    "preparing_review", "ready_for_review", "failed",
  ]);
  assert.deepEqual(importProcessingJobStates, ["queued", "running", "succeeded", "failed"]);
  assert.equal(IMPORT_PROCESSING_VERSION, "local801-import-v1");
});

test("durable import transitions advance in order and fail closed", () => {
  assert.equal(canAdvanceImportProcessing("uploaded", "queued"), true);
  assert.equal(canAdvanceImportProcessing("queued", "scanning"), true);
  assert.equal(canAdvanceImportProcessing("matching", "preparing_review"), true);
  assert.equal(canAdvanceImportProcessing("preparing_review", "ready_for_review"), true);
  assert.equal(canAdvanceImportProcessing("ready_for_review", "queued"), false);
  assert.equal(canAdvanceImportProcessing("parsing", "ready_for_review"), false);
  assert.equal(canAdvanceImportProcessing("failed", "queued"), true);
  for (const stage of importProcessingStages.filter((item) => item !== "ready_for_review" && item !== "failed")) {
    assert.equal(canAdvanceImportProcessing(stage, "failed"), true);
  }
});

test("processing job transitions are centralized and reject arbitrary jumps", () => {
  assert.equal(canAdvanceImportProcessingJob("queued", "running"), true);
  assert.equal(canAdvanceImportProcessingJob("queued", "failed"), true);
  assert.equal(canAdvanceImportProcessingJob("running", "succeeded"), true);
  assert.equal(canAdvanceImportProcessingJob("running", "failed"), true);
  assert.equal(canAdvanceImportProcessingJob("failed", "queued"), true);
  assert.equal(canAdvanceImportProcessingJob("queued", "succeeded"), false);
  assert.equal(canAdvanceImportProcessingJob("succeeded", "running"), false);
  assert.equal(canAdvanceImportProcessingJob("running", "queued"), false);
});

test("safe processing failures use a typed allowlist and dispositions", () => {
  assert.equal(importProcessingFailureDisposition("DATABASE_TEMPORARY_FAILURE"), "retryable");
  assert.equal(importProcessingFailureDisposition("MALWARE_REJECTED"), "terminal_source");
  assert.equal(importProcessingFailureDisposition("TENANT_INVARIANT_FAILED"), "operator_review");
  assert.equal(Object.hasOwn(importProcessingSafeErrorCodes, "raw postgres error"), false);
});

test("workflow input contains identifiers only and no source or member data", () => {
  const input = createImportWorkflowInput("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002");
  assert.deepEqual(Object.keys(input), ["organizationId", "batchId"]);
  assert.equal(Object.isFrozen(input), true);
  assert.doesNotMatch(JSON.stringify(input), /file|row|person|email|name|storage|encrypt/i);
  assert.throws(() => createImportWorkflowInput("not-an-organization", input.batchId), /must be UUIDs/);
});

test("same-run replay owns the job while a different run exits harmlessly", () => {
  assert.equal(decideImportProcessingOwnership({ state: "queued", workflowRunId: null }, "wrun-A"), "claim");
  assert.equal(decideImportProcessingOwnership({ state: "running", workflowRunId: "wrun-A" }, "wrun-A"), "already_owned");
  assert.equal(decideImportProcessingOwnership({ state: "running", workflowRunId: "wrun-A" }, "wrun-B"), "not_owner");
  assert.throws(
    () => decideImportProcessingOwnership({ state: "queued", workflowRunId: null }, " "),
    /run ID is invalid/,
  );
});

test("failed job requeue clears ownership but preserves attempts and processing version", () => {
  const now = "2026-08-12T15:30:00.000Z";
  assert.deepEqual(createImportProcessingRequeuePatch({
    state: "failed",
    attemptCount: 2,
    processingVersion: IMPORT_PROCESSING_VERSION,
  }, now), {
    state: "queued",
    workflowRunId: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    safeErrorCode: null,
    lastProgressAt: now,
    updatedAt: now,
    attemptCount: 2,
    processingVersion: IMPORT_PROCESSING_VERSION,
  });
});

test("durable processing requires exactly one canonical source", () => {
  const source = { id: "source-a" };
  assert.equal(requireCanonicalImportSource([source]), source);
  assert.throws(() => requireCanonicalImportSource([]), (error) => error.code === "SOURCE_FILE_MISSING");
  assert.throws(() => requireCanonicalImportSource([source, { id: "source-b" }]), (error) => error.code === "SOURCE_FILE_AMBIGUOUS");
});

test("scanner boundary permits parsing only after a clean verdict", () => {
  assert.equal(scannerAllowsImportParsing("clean"), true);
  assert.equal(scannerAllowsImportParsing("malicious"), false);
  assert.equal(scannerAllowsImportParsing("temporary_failure"), false);
  assert.equal(scannerAllowsImportParsing("terminal_scanner_failure"), false);
});

test("claim and requeue SQL contracts are tenant scoped CAS mutations with explicit timestamps", () => {
  for (const sql of [ensureImportProcessingJobSql, requeueImportProcessingJobSql]) {
    assert.match(sql, /job\.organization_id = \$1/);
    assert.match(sql, /job\.import_batch_id = \$2/);
    assert.match(sql, /job\.processing_version = \$3/);
    assert.match(sql, /updated_at = now\(\)/);
  }
  assert.match(ensureImportProcessingJobSql, /job\.state = 'queued'/);
  assert.match(ensureImportProcessingJobSql, /job\.workflow_run_id IS NULL/);
  assert.match(ensureImportProcessingJobSql, /attempt_count = job\.attempt_count \+ 1/);
  assert.match(ensureImportProcessingJobSql, /batch\.processing_stage = 'queued'/);
  assert.match(requeueImportProcessingJobSql, /job\.state = 'failed'/);
  assert.match(requeueImportProcessingJobSql, /processing_error_code = NULL/);
  assert.doesNotMatch(requeueImportProcessingJobSql, /attempt_count\s*=/);
  assert.match(readImportProcessingJobOwnershipSql, /organization_id = \$1/);
});

test("processing status uses human labels and useful integer row progress", () => {
  assert.deepEqual(importProcessingStatus({ stage: "validating", processedRowCount: 12_500, totalRowCount: 20_140 }), {
    label: "Validating",
    detail: "12,500 of 20,140 rows",
  });
  assert.deepEqual(importProcessingStatus({ stage: "queued", processedRowCount: null, totalRowCount: null }), {
    label: "Queued",
    detail: null,
  });
});

test("only ready-for-review and failed are terminal processing stages", () => {
  assert.equal(isTerminalImportProcessingStage("ready_for_review"), true);
  assert.equal(isTerminalImportProcessingStage("failed"), true);
  assert.equal(isTerminalImportProcessingStage("validating"), false);
});

test("migration 0006 is tenant scoped, idempotency constrained, and contains no authoritative writes", async () => {
  const migration = await readFile(new URL("../db/migrations/0006__import_processing_jobs.sql", import.meta.url), "utf8");
  assert.match(migration, /^begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /create table local801\.import_processing_jobs/i);
  assert.match(migration, /constraint import_processing_jobs_pkey primary key \(id\)/);
  assert.match(migration, /organization_id uuid not null/);
  assert.match(migration, /unique \(import_batch_id\)/);
  assert.match(migration, /constraint import_batches_organization_id_id_uq\s+unique \(organization_id, id\)/);
  assert.match(migration, /constraint import_processing_jobs_batch_org_fk/);
  assert.match(migration, /foreign key \(organization_id, import_batch_id\)/);
  assert.match(migration, /unique index import_processing_jobs_workflow_run_uq/);
  assert.match(migration, /processing_version/);
  assert.match(migration, /import_processing_jobs_lifecycle_ck/);
  assert.match(migration, /import_processing_jobs_timestamp_order_ck/);
  assert.match(migration, /workflow_run_id = btrim\(workflow_run_id\)/);
  assert.match(migration, /'scanning'/);
  for (const table of ["people", "person_identifiers", "person_contact_methods", "membership_events", "employment_events", "membership_snapshots", "membership_snapshot_rows", "import_approvals"]) {
    assert.doesNotMatch(migration, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+local801\\.${table}\\b`, "i"));
  }
});
