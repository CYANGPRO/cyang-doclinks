import "server-only";

import { createHash } from "node:crypto";
import { getAppConfig } from "./config.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { loadCanonicalImportSourceForProcessing } from "./document-storage.ts";
import {
  IMPORT_PROCESSING_VERSION,
  createImportWorkflowInput,
  decideImportProcessingOwnership,
  isImportProcessingSafeErrorCode,
  type ImportProcessingOwnershipDecision,
  type ImportProcessingSafeErrorCode,
  type ImportWorkflowInput,
} from "./import-processing.ts";
import {
  areStrictSyntheticImportSheets,
  getImportMalwareScanner,
  isCsvImportSource,
  isXlsxImportSource,
  type ImportMalwareScanner,
} from "./import-scanner.ts";
import {
  XlsxImportError,
  normalizeImportRow,
  parseCsv,
  parseXlsxImportSheets,
  recognizedMappings,
  shouldIncludeLocal801,
  stableRowHash,
  type ParsedImportSheet,
} from "./imports.ts";

export const IMPORT_STAGE_CHUNK_SIZE = 500;

type WorkerDependencies = {
  query?: DatabaseQuery;
  transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  loadSource?: typeof loadCanonicalImportSourceForProcessing;
  scanner?: ImportMalwareScanner;
  env?: NodeJS.ProcessEnv;
};

export class ImportWorkerError extends Error {
  readonly code: ImportProcessingSafeErrorCode;
  readonly retryable: boolean;

  constructor(code: ImportProcessingSafeErrorCode, retryable = false) {
    super(code);
    this.name = "ImportWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function validate(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  createImportWorkflowInput(input.organizationId, input.batchId);
  if (trustedWorkflowRunId !== trustedWorkflowRunId.trim()
    || trustedWorkflowRunId.length === 0
    || trustedWorkflowRunId.length > 255) {
    throw new ImportWorkerError("TENANT_INVARIANT_FAILED");
  }
}

function deterministicUuid(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function numeric(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function assertOwned(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  query: DatabaseQuery,
) {
  const [row] = await query<{ state: string; workflow_run_id: string | null; processing_version: string }>(`
    SELECT state, workflow_run_id, processing_version
    FROM local801.import_processing_jobs
    WHERE organization_id = $1 AND import_batch_id = $2
  `, [input.organizationId, input.batchId]);
  if (!row || row.processing_version !== IMPORT_PROCESSING_VERSION
    || row.state !== "running" || row.workflow_run_id !== trustedWorkflowRunId) {
    throw new ImportWorkerError(row && row.processing_version !== IMPORT_PROCESSING_VERSION
      ? "PROCESSING_VERSION_UNSUPPORTED" : "TENANT_INVARIANT_FAILED");
  }
}

async function advanceOwnedStage(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  expectedStages: readonly string[],
  nextStage: string,
  query: DatabaseQuery,
) {
  await assertOwned(input, trustedWorkflowRunId, query);
  const rows = await query<{ processing_stage: string }>(`
    UPDATE local801.import_batches batch
    SET processing_stage = $4, processing_error_code = NULL
    WHERE batch.organization_id = $1 AND batch.id = $2
      AND batch.processing_stage = ANY($5::text[])
      AND EXISTS (
        SELECT 1 FROM local801.import_processing_jobs job
        WHERE job.organization_id = batch.organization_id
          AND job.import_batch_id = batch.id
          AND job.processing_version = $3
          AND job.state = 'running'
          AND job.workflow_run_id = $6
      )
    RETURNING batch.processing_stage
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, nextStage, expectedStages, trustedWorkflowRunId]);
  if (rows.length === 1) return;
  const [batch] = await query<{ processing_stage: string }>(`
    SELECT processing_stage FROM local801.import_batches
    WHERE organization_id = $1 AND id = $2
  `, [input.organizationId, input.batchId]);
  if (batch?.processing_stage !== nextStage) throw new ImportWorkerError("STAGING_INVARIANT_FAILED");
}

export async function ensureImportProcessingJob(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  query: DatabaseQuery = queryLocal801,
): Promise<ImportProcessingOwnershipDecision> {
  validate(input, trustedWorkflowRunId);
  const claimed = await query<{ id: string; state: "running"; workflow_run_id: string; attempt_count: number }>(`
    WITH claimed AS (
      UPDATE local801.import_processing_jobs job
      SET state = 'running', workflow_run_id = $4,
          attempt_count = job.attempt_count + 1, started_at = now(),
          last_progress_at = now(), updated_at = now()
      WHERE job.organization_id = $1 AND job.import_batch_id = $2
        AND job.processing_version = $3 AND job.state = 'queued'
        AND job.workflow_run_id IS NULL
        AND EXISTS (
          SELECT 1 FROM local801.import_batches batch
          WHERE batch.organization_id = job.organization_id
            AND batch.id = job.import_batch_id
            AND batch.processing_stage = 'queued'
        )
      RETURNING job.id, job.organization_id, job.import_batch_id,
        job.state, job.workflow_run_id, job.attempt_count
    ), prior AS (
      SELECT event_hash FROM local801.audit_events
      WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
    ), audited AS (
      INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id,
         payload, previous_hash, event_hash)
      SELECT claimed.organization_id, batch.uploaded_by, 'import.processing_started',
        'import_batch', claimed.import_batch_id,
        jsonb_build_object('processingVersion', $3), prior.event_hash,
        encode(public.digest(concat_ws('|', claimed.organization_id::text,
          claimed.import_batch_id::text, 'import.processing_started', $3), 'sha256'), 'hex')
      FROM claimed
      JOIN local801.import_batches batch
        ON batch.organization_id = claimed.organization_id AND batch.id = claimed.import_batch_id
      LEFT JOIN prior ON true
      RETURNING id
    )
    SELECT claimed.id, claimed.state, claimed.workflow_run_id, claimed.attempt_count
    FROM claimed JOIN audited ON true
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
  if (claimed.length === 1) return "claim";
  const [job] = await query<{ state: "queued" | "running" | "succeeded" | "failed"; workflow_run_id: string | null; processing_version: string }>(`
    SELECT state, workflow_run_id, processing_version
    FROM local801.import_processing_jobs
    WHERE organization_id = $1 AND import_batch_id = $2
  `, [input.organizationId, input.batchId]);
  if (!job) throw new ImportWorkerError("TENANT_INVARIANT_FAILED");
  if (job.processing_version !== IMPORT_PROCESSING_VERSION) throw new ImportWorkerError("PROCESSING_VERSION_UNSUPPORTED");
  return decideImportProcessingOwnership({ state: job.state, workflowRunId: job.workflow_run_id }, trustedWorkflowRunId);
}

export async function acknowledgeImportCancellation(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  query: DatabaseQuery = queryLocal801,
) {
  validate(input, trustedWorkflowRunId);
  const rows = await query<{ id: string }>(`
    /* import-worker:acknowledge-cancellation */
    WITH cancelled_job AS (
      UPDATE local801.import_processing_jobs job SET state = 'cancelled', cancelled_at = now(),
        last_progress_at = now(), updated_at = now()
      WHERE job.organization_id = $1 AND job.import_batch_id = $2
        AND job.processing_version = $3 AND job.workflow_run_id = $4
        AND job.state = 'running' AND job.cancellation_requested_at IS NOT NULL
        AND job.cancelled_by IS NOT NULL AND job.operator_reason_code IS NOT NULL
      RETURNING job.id, job.organization_id, job.import_batch_id
    ), cancelled_batch AS (
      UPDATE local801.import_batches batch SET processing_stage = 'cancelled', processing_error_code = NULL
      FROM cancelled_job WHERE batch.organization_id = cancelled_job.organization_id
        AND batch.id = cancelled_job.import_batch_id RETURNING batch.id
    ) SELECT cancelled_job.id FROM cancelled_job JOIN cancelled_batch ON cancelled_batch.id = cancelled_job.import_batch_id
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
  if (rows.length === 1) return true;
  const [state] = await query<{ state: string; workflow_run_id: string | null }>(`
    SELECT state, workflow_run_id FROM local801.import_processing_jobs
    WHERE organization_id = $1 AND import_batch_id = $2 AND processing_version = $3
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION]);
  return state?.state === "cancelled" && state.workflow_run_id === trustedWorkflowRunId;
}

export async function scanImportSource(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  dependencies: WorkerDependencies = {},
) {
  validate(input, trustedWorkflowRunId);
  const query = dependencies.query ?? queryLocal801;
  await advanceOwnedStage(input, trustedWorkflowRunId, ["queued", "scanning"], "scanning", query);
  const source = await (dependencies.loadSource ?? loadCanonicalImportSourceForProcessing)(input.organizationId, input.batchId);
  const scanner = dependencies.scanner ?? getImportMalwareScanner();
  const result = await scanner.scan({ content: source.plaintext, mediaType: source.mediaType, originalFilename: source.originalFilename });
  if (result.outcome === "clean") {
    const updated = await query<{ id: string }>(`
      UPDATE local801.import_files file SET malware_scan_status = 'clean'
      WHERE file.id = $1 AND file.organization_id = $2 AND file.import_batch_id = $3
      RETURNING file.id
    `, [source.id, input.organizationId, input.batchId]);
    if (updated.length !== 1) throw new ImportWorkerError("TENANT_INVARIANT_FAILED");
    return { result: "clean" as const };
  }
  if (result.outcome === "malicious") throw new ImportWorkerError("MALWARE_REJECTED");
  if (result.outcome === "temporary_failure") throw new ImportWorkerError("SCANNER_TEMPORARY_FAILURE", true);
  throw new ImportWorkerError("SCANNER_UNAVAILABLE");
}

export async function parseAndStageImport(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  dependencies: WorkerDependencies = {},
) {
  validate(input, trustedWorkflowRunId);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  await advanceOwnedStage(input, trustedWorkflowRunId, ["scanning", "parsing"], "parsing", query);
  const source = await (dependencies.loadSource ?? loadCanonicalImportSourceForProcessing)(input.organizationId, input.batchId);
  if (source.plaintext.byteLength > getAppConfig(dependencies.env).LOCAL801_IMPORT_MAX_BYTES) {
    throw new ImportWorkerError("FILE_TOO_LARGE");
  }
  let sheets: ParsedImportSheet[];
  const csvSource = isCsvImportSource(source.mediaType, source.originalFilename);
  if (csvSource) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(source.plaintext); }
    catch { throw new ImportWorkerError("MALFORMED_FILE"); }
    sheets = [{ name: "CSV", state: "included", rows: parseCsv(text) }];
  } else if (isXlsxImportSource(source.mediaType, source.originalFilename)) {
    try {
      sheets = await parseXlsxImportSheets(source.plaintext, {
        includedDataRows: getAppConfig(dependencies.env).LOCAL801_IMPORT_MAX_ROWS,
      });
    } catch (error) {
      if (error instanceof XlsxImportError && error.code === "row_count_exceeded") {
        throw new ImportWorkerError("ROW_LIMIT_EXCEEDED");
      }
      if (error instanceof XlsxImportError && [
        "entry_size_exceeded",
        "total_size_exceeded",
        "compression_ratio_exceeded",
      ].includes(error.code)) {
        throw new ImportWorkerError("WORKBOOK_STRUCTURE_TOO_LARGE");
      }
      throw new ImportWorkerError("MALFORMED_FILE");
    }
  } else {
    throw new ImportWorkerError("UNSUPPORTED_FILE");
  }
  const includedSheets = sheets.map((sheet, index) => ({
    ...sheet,
    index,
    headers: sheet.rows[0] ?? [],
    body: sheet.rows.slice(1),
    sheetId: deterministicUuid(csvSource
      ? `${input.organizationId}:${input.batchId}:${source.id}:csv-sheet`
      : `${input.organizationId}:${input.batchId}:${source.id}:sheet:${index}:${sheet.name}`),
  })).filter((sheet) => sheet.state === "included");
  const totalRows = includedSheets.reduce((count, sheet) => count + sheet.body.length, 0);
  if (totalRows === 0 || !includedSheets.some((sheet) => recognizedMappings(sheet.headers).length > 0)) {
    throw new ImportWorkerError("MALFORMED_FILE");
  }
  if (totalRows > getAppConfig(dependencies.env).LOCAL801_IMPORT_MAX_ROWS) {
    throw new ImportWorkerError("ROW_LIMIT_EXCEEDED");
  }
  if ((dependencies.env ?? process.env).VERCEL_ENV === "preview" && !areStrictSyntheticImportSheets(sheets)) {
    throw new ImportWorkerError("MALFORMED_FILE");
  }

  const sheetRecords = sheets.map((sheet, index) => ({
    ...sheet,
    index,
    headers: sheet.rows[0] ?? [],
    body: sheet.rows.slice(1),
    sheetId: deterministicUuid(csvSource
      ? `${input.organizationId}:${input.batchId}:${source.id}:csv-sheet`
      : `${input.organizationId}:${input.batchId}:${source.id}:sheet:${index}:${sheet.name}`),
  }));
  const initialization: DatabaseStatement[] = [{
    sql: `UPDATE local801.import_batches batch
      SET total_row_count = $3, processed_row_count = LEAST($3,
        GREATEST(COALESCE(batch.processed_row_count, 0), 0))
      WHERE batch.organization_id = $1 AND batch.id = $2
        AND batch.processing_stage = 'parsing'
        AND EXISTS (SELECT 1 FROM local801.import_processing_jobs job
          WHERE job.organization_id = batch.organization_id AND job.import_batch_id = batch.id
            AND job.processing_version = $4 AND job.state = 'running' AND job.workflow_run_id = $5)`,
    parameters: [input.organizationId, input.batchId, totalRows, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId],
  }];
  for (const sheet of sheetRecords) {
    initialization.push({
      sql: `INSERT INTO local801.import_sheets
        (id, organization_id, import_file_id, sheet_name, sheet_state, row_count)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET row_count = EXCLUDED.row_count, sheet_state = EXCLUDED.sheet_state
        WHERE import_sheets.organization_id = EXCLUDED.organization_id
          AND import_sheets.import_file_id = EXCLUDED.import_file_id`,
      parameters: [sheet.sheetId, input.organizationId, source.id, sheet.name, sheet.state, sheet.body.length],
    });
    if (sheet.state !== "included") continue;
    for (const mapping of recognizedMappings(sheet.headers)) initialization.push({
      sql: `INSERT INTO local801.import_mappings
        (id, organization_id, import_sheet_id, source_column, target_column, transform)
        VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (id) DO NOTHING`,
      parameters: [deterministicUuid(`${sheet.sheetId}:mapping:${mapping.sourceColumn}:${mapping.targetColumn}`), input.organizationId,
        sheet.sheetId, mapping.sourceColumn, mapping.targetColumn],
    });
  }
  await transaction(initialization);

  let included = 0;
  let excluded = 0;
  let processed = 0;
  for (const sheet of sheetRecords.filter((record) => record.state === "included")) {
    for (let offset = 0; offset < sheet.body.length; offset += IMPORT_STAGE_CHUNK_SIZE) {
      const block = sheet.body.slice(offset, offset + IMPORT_STAGE_CHUNK_SIZE);
      const staged = block.flatMap((cells, blockIndex) => {
        const sourceRowNumber = offset + blockIndex + 2;
        const values = normalizeImportRow(sheet.headers, cells);
        if (values.local && !shouldIncludeLocal801(values.local)) { excluded += 1; return []; }
        included += 1;
        return [{
          id: deterministicUuid(csvSource
            ? `${input.organizationId}:${input.batchId}:${source.id}:row:${sourceRowNumber}`
            : `${input.organizationId}:${input.batchId}:${source.id}:${sheet.sheetId}:row:${sourceRowNumber}`),
          source_row_number: sourceRowNumber,
          row_hash: stableRowHash(values),
          normalized_json: values,
        }];
      });
      processed += block.length;
      const statements: DatabaseStatement[] = [];
      if (staged.length) statements.push({
        sql: `INSERT INTO local801.import_rows
          (id, organization_id, import_sheet_id, source_row_number, row_hash, normalized_json, state)
          SELECT item.id, $1, $2, item.source_row_number, item.row_hash, item.normalized_json, 'pending'
          FROM jsonb_to_recordset($3::text::jsonb) AS item(
            id uuid, source_row_number integer, row_hash text, normalized_json jsonb)
          ON CONFLICT (id) DO UPDATE SET row_hash = EXCLUDED.row_hash,
            normalized_json = EXCLUDED.normalized_json
          WHERE import_rows.organization_id = EXCLUDED.organization_id
            AND import_rows.import_sheet_id = EXCLUDED.import_sheet_id
            AND import_rows.source_row_number = EXCLUDED.source_row_number`,
        parameters: [input.organizationId, sheet.sheetId, JSON.stringify(staged)],
      });
      statements.push({
        sql: `UPDATE local801.import_batches batch
          SET processed_row_count = LEAST(batch.total_row_count,
            GREATEST(COALESCE(batch.processed_row_count, 0), $3)),
            processing_stage = 'parsing'
          WHERE batch.organization_id = $1 AND batch.id = $2
            AND batch.processing_stage = 'parsing'
            AND EXISTS (SELECT 1 FROM local801.import_processing_jobs job
              WHERE job.organization_id = batch.organization_id AND job.import_batch_id = batch.id
                AND job.processing_version = $4 AND job.state = 'running' AND job.workflow_run_id = $5)`,
        parameters: [input.organizationId, input.batchId, processed, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId],
      }, {
        sql: `UPDATE local801.import_processing_jobs SET last_progress_at = now(), updated_at = now()
          WHERE organization_id = $1 AND import_batch_id = $2 AND processing_version = $3
            AND state = 'running' AND workflow_run_id = $4`,
        parameters: [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId],
      });
      await transaction(statements);
    }
  }
  await query(`UPDATE local801.import_batches batch
    SET included_row_count = $3, excluded_row_count = $4
    WHERE batch.organization_id = $1 AND batch.id = $2 AND batch.processing_stage = 'parsing'
      AND batch.total_row_count = $5 AND batch.processed_row_count = $5`,
  [input.organizationId, input.batchId, included, excluded, totalRows]);
  const [persisted] = await query<{ row_count: number | string }>(`
    SELECT count(*)::int AS row_count FROM local801.import_rows row
    JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id
      AND sheet.organization_id = row.organization_id
    WHERE row.organization_id = $1 AND sheet.import_file_id = $2
  `, [input.organizationId, source.id]);
  if (numeric(persisted?.row_count) !== included || included + excluded !== totalRows) {
    throw new ImportWorkerError("STAGING_INVARIANT_FAILED");
  }
  return { totalRows, includedRows: included, excludedRows: excluded };
}

export async function validateStagedImport(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  dependencies: WorkerDependencies = {},
) {
  validate(input, trustedWorkflowRunId);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  await advanceOwnedStage(input, trustedWorkflowRunId, ["parsing", "validating"], "validating", query);
  const scope = `row.organization_id = $1 AND file.import_batch_id = $2`;
  await transaction([
    { sql: `DELETE FROM local801.import_errors WHERE organization_id = $1 AND import_batch_id = $2`, parameters: [input.organizationId, input.batchId] },
    { sql: `UPDATE local801.import_rows row SET state = 'pending'
      FROM local801.import_sheets sheet, local801.import_files file
      WHERE row.import_sheet_id = sheet.id AND sheet.organization_id = row.organization_id
        AND file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id AND ${scope}`, parameters: [input.organizationId, input.batchId] },
    { sql: `INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'identifier',
        'Rows require an authoritative identifier; names are not used for merging.'
      FROM local801.import_rows row
      JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      WHERE ${scope} AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NULL
        AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NULL
        AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NULL`, parameters: [input.organizationId, input.batchId] },
    { sql: `INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, row.id, 'error', 'work_email', 'The work email format is invalid.'
      FROM local801.import_rows row
      JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      WHERE ${scope} AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
        AND NOT (btrim(row.normalized_json ->> 'work_email') ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')`, parameters: [input.organizationId, input.batchId] },
    { sql: `WITH batch_rows AS (
        SELECT row.id, row.normalized_json FROM local801.import_rows row
        JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
        JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
        WHERE ${scope}
      ), evidence AS (
        SELECT row.id, item.kind, lower(btrim(item.value)) AS value
        FROM batch_rows row CROSS JOIN LATERAL (VALUES
          ('employee_identifier', row.normalized_json ->> 'employee_identifier'),
          ('member_identifier', row.normalized_json ->> 'member_identifier'),
          ('work_email', row.normalized_json ->> 'work_email')) item(kind, value)
        WHERE NULLIF(btrim(item.value), '') IS NOT NULL
      ), duplicated AS (SELECT kind, value FROM evidence GROUP BY kind, value HAVING count(*) > 1)
      INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT DISTINCT $1, $2, evidence.id, 'error', 'identifier',
        'A duplicate authoritative identifier was detected in this source.'
      FROM evidence JOIN duplicated USING (kind, value)`, parameters: [input.organizationId, input.batchId] },
    { sql: `UPDATE local801.import_rows row SET state = 'rejected'
      FROM local801.import_sheets sheet, local801.import_files file
      WHERE row.import_sheet_id = sheet.id AND sheet.organization_id = row.organization_id
        AND file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id AND ${scope}
        AND EXISTS (SELECT 1 FROM local801.import_errors error
          WHERE error.organization_id = $1 AND error.import_batch_id = $2 AND error.import_row_id = row.id
            AND error.severity = 'error')`, parameters: [input.organizationId, input.batchId] },
  ]);
  const [counts] = await query<{ rejected_count: number | string; error_count: number | string }>(`
    SELECT count(DISTINCT row.id) FILTER (WHERE row.state = 'rejected')::int AS rejected_count,
      count(DISTINCT error.id)::int AS error_count
    FROM local801.import_files file
    JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    LEFT JOIN local801.import_errors error ON error.import_row_id = row.id AND error.organization_id = row.organization_id
      AND error.import_batch_id = file.import_batch_id
    WHERE file.organization_id = $1 AND file.import_batch_id = $2
  `, [input.organizationId, input.batchId]);
  return { rejectedRows: numeric(counts?.rejected_count), errorCount: numeric(counts?.error_count) };
}

export async function matchImportIdentities(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  dependencies: WorkerDependencies = {},
) {
  validate(input, trustedWorkflowRunId);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  await advanceOwnedStage(input, trustedWorkflowRunId, ["validating", "matching"], "matching", query);
  const batchRows = `SELECT row.id, row.normalized_json FROM local801.import_files file
    JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    WHERE file.organization_id = $1 AND file.import_batch_id = $2`;
  const conflictMessage = "Authoritative identifiers resolve to conflicting people; correct and re-upload the source.";
  await transaction([
    { sql: `DELETE FROM local801.import_match_candidates candidate USING local801.import_rows row,
        local801.import_sheets sheet, local801.import_files file
      WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id
        AND row.organization_id = candidate.organization_id AND sheet.id = row.import_sheet_id
        AND sheet.organization_id = row.organization_id AND file.id = sheet.import_file_id
        AND file.organization_id = sheet.organization_id AND file.import_batch_id = $2`, parameters: [input.organizationId, input.batchId] },
    { sql: `DELETE FROM local801.import_errors WHERE organization_id = $1 AND import_batch_id = $2
      AND message = $3`, parameters: [input.organizationId, input.batchId, conflictMessage] },
    { sql: `WITH batch_rows AS (${batchRows}), evidence AS (
        SELECT row.id AS import_row_id, identifier.person_id, identifier.identifier_type::text AS rule
        FROM batch_rows row JOIN local801.person_identifiers identifier ON identifier.organization_id = $1
        JOIN local801.people person ON person.id = identifier.person_id AND person.organization_id = identifier.organization_id
          AND person.archived_at IS NULL AND ((identifier.identifier_type = 'employee_identifier'
            AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
            AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
          OR (identifier.identifier_type = 'member_identifier'
            AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
            AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
        UNION ALL
        SELECT row.id, contact.person_id, 'work_email' FROM batch_rows row
        JOIN local801.person_contact_methods contact ON contact.organization_id = $1
        JOIN local801.people person ON person.id = contact.person_id AND person.organization_id = contact.organization_id
          AND person.archived_at IS NULL AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
          AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
          AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
      ), grouped AS (SELECT import_row_id, person_id,
        string_agg(DISTINCT rule, '+' ORDER BY rule) AS match_rule FROM evidence GROUP BY import_row_id, person_id)
      INSERT INTO local801.import_match_candidates
        (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
      SELECT gen_random_uuid(), $1, import_row_id, person_id, match_rule, 1, false FROM grouped`, parameters: [input.organizationId, input.batchId] },
    { sql: `WITH batch_rows AS (${batchRows}) INSERT INTO local801.import_match_candidates
        (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
      SELECT gen_random_uuid(), $1, row.id, NULL, 'no_exact_match', 0, true FROM batch_rows row
      WHERE NOT EXISTS (SELECT 1 FROM local801.import_match_candidates candidate
        WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id AND candidate.person_id IS NOT NULL)`, parameters: [input.organizationId, input.batchId] },
    { sql: `WITH conflicts AS (
        SELECT candidate.import_row_id FROM local801.import_match_candidates candidate
        JOIN local801.import_rows row ON row.id = candidate.import_row_id AND row.organization_id = candidate.organization_id
        JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
        JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
        WHERE candidate.organization_id = $1 AND file.import_batch_id = $2 AND candidate.person_id IS NOT NULL
        GROUP BY candidate.import_row_id HAVING count(DISTINCT candidate.person_id) > 1
      ) INSERT INTO local801.import_errors
        (organization_id, import_batch_id, import_row_id, severity, field_name, message)
      SELECT $1, $2, import_row_id, 'error', 'identifier', $3 FROM conflicts`, parameters: [input.organizationId, input.batchId, conflictMessage] },
    { sql: `UPDATE local801.import_rows row SET state = 'rejected'
      WHERE row.organization_id = $1 AND EXISTS (SELECT 1 FROM local801.import_errors error
        WHERE error.organization_id = $1 AND error.import_batch_id = $2
          AND error.import_row_id = row.id AND error.message = $3)`, parameters: [input.organizationId, input.batchId, conflictMessage] },
  ]);
  const [count] = await query<{ candidate_count: number | string }>(`
    SELECT count(*)::int AS candidate_count FROM local801.import_match_candidates candidate
    JOIN local801.import_rows row ON row.id = candidate.import_row_id AND row.organization_id = candidate.organization_id
    JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
    JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
    WHERE candidate.organization_id = $1 AND file.import_batch_id = $2
  `, [input.organizationId, input.batchId]);
  return { candidateCount: numeric(count?.candidate_count) };
}

export async function prepareImportReview(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  query: DatabaseQuery = queryLocal801,
) {
  validate(input, trustedWorkflowRunId);
  await advanceOwnedStage(input, trustedWorkflowRunId, ["matching", "preparing_review"], "preparing_review", query);
  const [counts] = await query<{ row_count: number | string; rejected_count: number | string; error_count: number | string }>(`
    SELECT count(DISTINCT row.id)::int AS row_count,
      count(DISTINCT row.id) FILTER (WHERE row.state = 'rejected')::int AS rejected_count,
      count(DISTINCT error.id)::int AS error_count
    FROM local801.import_files file
    JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    LEFT JOIN local801.import_errors error ON error.organization_id = file.organization_id
      AND error.import_batch_id = file.import_batch_id AND error.import_row_id = row.id
    WHERE file.organization_id = $1 AND file.import_batch_id = $2
  `, [input.organizationId, input.batchId]);
  const updated = await query<{ id: string }>(`
    UPDATE local801.import_batches batch SET
      state = CASE WHEN $3 > 0 THEN 'under_review' ELSE 'validated' END,
      rejected_row_count = $4
    WHERE batch.organization_id = $1 AND batch.id = $2
      AND batch.processing_stage = 'preparing_review'
      AND batch.included_row_count = $5
      AND EXISTS (SELECT 1 FROM local801.import_processing_jobs job
        WHERE job.organization_id = batch.organization_id AND job.import_batch_id = batch.id
          AND job.processing_version = $6 AND job.state = 'running' AND job.workflow_run_id = $7)
    RETURNING batch.id
  `, [input.organizationId, input.batchId, numeric(counts?.error_count), numeric(counts?.rejected_count),
    numeric(counts?.row_count), IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
  if (updated.length !== 1) throw new ImportWorkerError("STAGING_INVARIANT_FAILED");
  return { reviewRows: numeric(counts?.row_count), rejectedRows: numeric(counts?.rejected_count), errorCount: numeric(counts?.error_count) };
}

export async function completeImportProcessing(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  query: DatabaseQuery = queryLocal801,
) {
  validate(input, trustedWorkflowRunId);
  const [existing] = await query<{ state: string; processing_stage: string }>(`
    SELECT job.state, batch.processing_stage FROM local801.import_processing_jobs job
    JOIN local801.import_batches batch ON batch.organization_id = job.organization_id AND batch.id = job.import_batch_id
    WHERE job.organization_id = $1 AND job.import_batch_id = $2
      AND job.processing_version = $3 AND job.workflow_run_id = $4
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
  if (existing?.state === "succeeded" && existing.processing_stage === "ready_for_review") return { status: "already_complete" as const };
  const [result] = await query<{ completed: boolean }>(`
    WITH eligible AS (
      SELECT job.id AS job_id, batch.id AS batch_id, batch.organization_id, batch.uploaded_by
      FROM local801.import_processing_jobs job
      JOIN local801.import_batches batch ON batch.organization_id = job.organization_id AND batch.id = job.import_batch_id
      WHERE job.organization_id = $1 AND job.import_batch_id = $2 AND job.processing_version = $3
        AND job.state = 'running' AND job.workflow_run_id = $4
        AND job.cancellation_requested_at IS NULL
        AND batch.processing_stage = 'preparing_review'
        AND batch.total_row_count IS NOT NULL AND batch.processed_row_count = batch.total_row_count
        AND batch.included_row_count IS NOT NULL AND batch.excluded_row_count IS NOT NULL
        AND batch.total_row_count = batch.included_row_count + batch.excluded_row_count
        AND (SELECT count(*) FROM local801.import_files file
          WHERE file.organization_id = batch.organization_id AND file.import_batch_id = batch.id) = 1
        AND (SELECT count(*) FROM local801.import_rows row
          JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
          JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
          WHERE row.organization_id = batch.organization_id AND file.import_batch_id = batch.id) = batch.included_row_count
    ), completed_job AS (
      UPDATE local801.import_processing_jobs job SET state = 'succeeded', completed_at = now(),
        last_progress_at = now(), updated_at = now()
      FROM eligible WHERE job.id = eligible.job_id RETURNING job.id
    ), completed_batch AS (
      UPDATE local801.import_batches batch SET processing_stage = 'ready_for_review', processing_error_code = NULL
      FROM eligible, completed_job WHERE batch.organization_id = eligible.organization_id AND batch.id = eligible.batch_id
      RETURNING batch.id, batch.organization_id, eligible.uploaded_by
    ), prior AS (
      SELECT event_hash FROM local801.audit_events WHERE organization_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1
    ), audited AS (
      INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id, payload, previous_hash, event_hash)
      SELECT completed_batch.organization_id, completed_batch.uploaded_by, 'import.processing_ready',
        'import_batch', completed_batch.id, jsonb_build_object('processingVersion', $3), prior.event_hash,
        encode(public.digest(concat_ws('|', completed_batch.organization_id::text,
          completed_batch.id::text, 'import.processing_ready', $3), 'sha256'), 'hex')
      FROM completed_batch LEFT JOIN prior ON true RETURNING id
    )
    SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS completed
    FROM completed_job CROSS JOIN completed_batch CROSS JOIN audited
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
  if (!result?.completed) throw new ImportWorkerError("STAGING_INVARIANT_FAILED");
  return { status: "succeeded" as const };
}

export function safeImportWorkerErrorCode(error: unknown): ImportProcessingSafeErrorCode {
  if (error instanceof ImportWorkerError) return error.code;
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && isImportProcessingSafeErrorCode(error.code)) return error.code;
  if (error instanceof Error && isImportProcessingSafeErrorCode(error.message)) return error.message;
  return "INTERNAL_PROCESSING_FAILURE";
}

export async function failImportProcessing(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  code: ImportProcessingSafeErrorCode,
  query: DatabaseQuery = queryLocal801,
) {
  validate(input, trustedWorkflowRunId);
  if (!isImportProcessingSafeErrorCode(code)) code = "INTERNAL_PROCESSING_FAILURE";
  const transitioned = await query<{ id: string }>(`
    WITH failed_job AS (
      UPDATE local801.import_processing_jobs job SET state = 'failed', safe_error_code = $5,
        failed_at = now(), last_progress_at = now(), updated_at = now()
      WHERE job.organization_id = $1 AND job.import_batch_id = $2 AND job.processing_version = $3
        AND job.state = 'running' AND job.workflow_run_id = $4 AND job.cancellation_requested_at IS NULL
      RETURNING job.id, job.organization_id, job.import_batch_id
    ), failed_batch AS (
      UPDATE local801.import_batches batch SET processing_stage = 'failed', processing_error_code = $5
      FROM failed_job WHERE batch.organization_id = failed_job.organization_id AND batch.id = failed_job.import_batch_id
      RETURNING batch.id, batch.organization_id, batch.uploaded_by
    ), prior AS (
      SELECT event_hash FROM local801.audit_events WHERE organization_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1
    ), audited AS (
      INSERT INTO local801.audit_events
        (organization_id, actor_user_id, event_type, subject_type, subject_id, payload, previous_hash, event_hash)
      SELECT failed_batch.organization_id, failed_batch.uploaded_by, 'import.processing_failed',
        'import_batch', failed_batch.id, jsonb_build_object('safeErrorCode', $5), prior.event_hash,
        encode(public.digest(concat_ws('|', failed_batch.organization_id::text,
          failed_batch.id::text, 'import.processing_failed', $5), 'sha256'), 'hex')
      FROM failed_batch LEFT JOIN prior ON true RETURNING id
    ) SELECT failed_batch.id FROM failed_batch JOIN audited ON true
  `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId, code]);
  if (transitioned.length === 0) {
    const [existing] = await query<{ state: string; safe_error_code: string | null }>(`
      SELECT state, safe_error_code FROM local801.import_processing_jobs
      WHERE organization_id = $1 AND import_batch_id = $2 AND processing_version = $3
        AND workflow_run_id = $4
    `, [input.organizationId, input.batchId, IMPORT_PROCESSING_VERSION, trustedWorkflowRunId]);
    if (existing?.state !== "failed" || existing.safe_error_code !== code) throw new ImportWorkerError("TENANT_INVARIANT_FAILED");
  }
  return { status: "failed" as const, code };
}
