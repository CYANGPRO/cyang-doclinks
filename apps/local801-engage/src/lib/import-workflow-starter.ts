import "server-only";

import { start } from "workflow/api";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import { IMPORT_PROCESSING_VERSION, createImportWorkflowInput, type ImportWorkflowInput } from "./import-processing.ts";
import { durablePreviewImportsEnabled } from "./import-scanner.ts";
import { processImportWorkflow } from "../workflows/process-import.ts";

type StartWorkflow = (input: ImportWorkflowInput) => Promise<{ runId: string }>;

const defaultStartWorkflow: StartWorkflow = async (input) => {
  const run = await start(processImportWorkflow, [input]);
  return { runId: run.runId };
};

export async function startQueuedImportWorkflow(
  organizationId: string,
  batchId: string,
  dependencies: { query?: DatabaseQuery; startWorkflow?: StartWorkflow; env?: NodeJS.ProcessEnv } = {},
) {
  const input = createImportWorkflowInput(organizationId, batchId);
  if (!durablePreviewImportsEnabled(dependencies.env ?? process.env)) {
    throw new Error("Durable import processing is not enabled in this environment.");
  }
  const query = dependencies.query ?? queryLocal801;
  const [state] = await query<{
    organization_id: string;
    processing_stage: string;
    job_state: string;
    workflow_run_id: string | null;
    processing_version: string;
    source_count: number | string;
    csv_source_count: number | string;
  }>(`
    SELECT batch.organization_id, batch.processing_stage, job.state AS job_state,
      job.workflow_run_id, job.processing_version,
      count(file.id)::int AS source_count,
      count(file.id) FILTER (WHERE file.media_type = 'text/csv'
        OR lower(file.original_filename) LIKE '%.csv')::int AS csv_source_count
    FROM local801.import_batches batch
    JOIN local801.import_processing_jobs job ON job.organization_id = batch.organization_id
      AND job.import_batch_id = batch.id
    LEFT JOIN local801.import_files file ON file.organization_id = batch.organization_id
      AND file.import_batch_id = batch.id
    WHERE batch.organization_id = $1 AND batch.id = $2
    GROUP BY batch.organization_id, batch.processing_stage, job.state,
      job.workflow_run_id, job.processing_version
  `, [input.organizationId, input.batchId]);
  if (!state || state.organization_id !== input.organizationId) throw new Error("Import processing job not found.");
  if (Number(state.source_count) === 0) throw Object.assign(new Error("Canonical source missing."), { code: "SOURCE_FILE_MISSING" });
  if (Number(state.source_count) !== 1) throw Object.assign(new Error("Canonical source ambiguous."), { code: "SOURCE_FILE_AMBIGUOUS" });
  if (Number(state.csv_source_count) !== 1) throw Object.assign(new Error("Durable import supports CSV only."), { code: "UNSUPPORTED_FILE" });
  if (state.processing_version !== IMPORT_PROCESSING_VERSION) throw new Error("Unsupported import processing version.");
  if (state.job_state !== "queued" || state.workflow_run_id !== null || state.processing_stage !== "queued") {
    throw new Error("Import processing job is not queued and runless.");
  }
  const run = await (dependencies.startWorkflow ?? defaultStartWorkflow)(input);
  if (!run.runId || run.runId !== run.runId.trim()) throw new Error("Workflow start did not return a valid run ID.");
  return { batchId: input.batchId, workflowRunId: run.runId };
}

export async function listRecoverableRunlessImports(
  organizationId: string,
  options: { graceMinutes?: number; limit?: number; query?: DatabaseQuery } = {},
) {
  const input = createImportWorkflowInput(organizationId, "00000000-0000-4000-8000-000000000000");
  const graceMinutes = Math.min(60, Math.max(1, Math.trunc(options.graceMinutes ?? 5)));
  const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 20)));
  return (options.query ?? queryLocal801)<{ batch_id: string }>(`
    SELECT job.import_batch_id AS batch_id
    FROM local801.import_processing_jobs job
    JOIN local801.import_batches batch ON batch.organization_id = job.organization_id
      AND batch.id = job.import_batch_id
    WHERE job.organization_id = $1 AND job.state = 'queued' AND job.workflow_run_id IS NULL
      AND job.processing_version = $2 AND batch.processing_stage = 'queued'
      AND job.queued_at <= now() - ($3::integer * interval '1 minute')
    ORDER BY job.queued_at, job.id LIMIT $4
  `, [input.organizationId, IMPORT_PROCESSING_VERSION, graceMinutes, limit]);
}

/** Deliberately not scheduled. An operator-owned server task may invoke this service. */
export async function restartRecoverableRunlessImports(
  organizationId: string,
  dependencies: {
    graceMinutes?: number;
    limit?: number;
    query?: DatabaseQuery;
    startWorkflow?: StartWorkflow;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const jobs = await listRecoverableRunlessImports(organizationId, dependencies);
  const results: Array<{ batchId: string; started: boolean }> = [];
  for (const job of jobs) {
    try {
      await startQueuedImportWorkflow(organizationId, job.batch_id, dependencies);
      results.push({ batchId: job.batch_id, started: true });
    } catch {
      results.push({ batchId: job.batch_id, started: false });
    }
  }
  return results;
}
