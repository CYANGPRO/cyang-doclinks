import "server-only";

import { randomUUID } from "node:crypto";
import { getAppConfig } from "./config.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { storeEncryptedImportFile, type StorageActor } from "./document-storage.ts";
import {
  uploadImportKindSchema,
  normalizeImportRow,
  parseImportSheets,
  recognizedMappings,
  stableRowHash,
  shouldIncludeLocal801,
  type ImportKind,
  type ParsedImportSheet,
} from "./imports.ts";
import { writeAuditEvent, type AuditEventType } from "./audit.ts";
import { can } from "./access.ts";
import { ControlledImportError, type ImportRejectedReason } from "./import-errors.ts";

const allowedExtensions = new Set([".csv", ".xlsx"]);
const mediaTypes = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const MAX_IMPORT_ERROR_EXPORT_ROWS = 50_000;
export const DEFAULT_IMPORT_BATCH_PAGE_SIZE = 20;

export type ImportActor = StorageActor & { userId: string };
export type ImportPersistenceDependencies = {
  query?: DatabaseQuery;
  transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  storeFile?: typeof storeEncryptedImportFile;
  audit?: (event: Parameters<typeof writeAuditEvent>[0]) => Promise<unknown>;
  id?: () => string;
};

export type ImportReviewSummary = {
  batchId: string;
  sourceFilename: string;
  importKind: ImportKind;
  state: "validated" | "under_review" | "rejected";
  totalRows: number;
  includedRows: number;
  excludedRows: number;
  rejectedRows: number;
  errorCount: number;
  sheets: Array<{ name: string; state: ParsedImportSheet["state"]; rowCount: number }>;
  previewRows: Array<{ rowNumber: number; sheetName: string; state: string; values: Record<string, string | null> }>;
};

type ImportMatchCandidateDatabaseRow = {
  candidate_id: string;
  import_row_id: string;
  sheet_name: string;
  source_row_number: number;
  row_state: string;
  imported_first_name: string | null;
  imported_last_name: string | null;
  imported_work_email: string | null;
  imported_department: string | null;
  imported_classification: string | null;
  has_authoritative_identifier: boolean;
  person_id: string | null;
  match_rule: string;
  requires_review: boolean;
  existing_preferred_name: string | null;
  existing_first_name: string | null;
  existing_last_name: string | null;
  existing_department: string | null;
  existing_classification: string | null;
  existing_work_email: string | null;
  matched_person_count: number | string;
};

export type ImportMatchReview = {
  importRowId: string;
  sheetName: string;
  sourceRowNumber: number;
  rowState: string;
  importedFirstName: string | null;
  importedLastName: string | null;
  importedWorkEmail: string | null;
  importedDepartment: string | null;
  importedClassification: string | null;
  hasAuthoritativeIdentifier: boolean;
  status: "exact_match" | "no_exact_match" | "conflicting_match" | "rejected";
  requiresReview: boolean;
  candidates: Array<{
    id: string;
    personId: string | null;
    matchRule: string;
    existingPreferredName: string | null;
    existingFirstName: string | null;
    existingLastName: string | null;
    existingDepartment: string | null;
    existingClassification: string | null;
    existingWorkEmail: string | null;
  }>;
};

function fail(code: ConstructorParameters<typeof ControlledImportError>[0], reason: ImportRejectedReason): never {
  throw new ControlledImportError(code, reason);
}

function filenameExtension(filename: string) {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function ensureCandidateFile(file: File, maxBytes: number) {
  const extension = filenameExtension(file.name);
  if (!allowedExtensions.has(extension) || extension === ".xls") fail("UNSUPPORTED_FILE", "unsupported_file");
  if (!mediaTypes.has(file.type.toLowerCase()) && file.type !== "") {
    fail("UNSUPPORTED_FILE", "unsupported_file");
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) fail("EMPTY_FILE", "empty_file");
  if (file.size > maxBytes) fail("FILE_TOO_LARGE", "file_too_large");
}

function identifierValues(values: Record<string, string | null>) {
  return [
    ["employee_identifier", values.employee_identifier],
    ["member_identifier", values.member_identifier],
    ["work_email", values.work_email],
    ["personal_email", values.personal_email],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "");
}

function validWorkEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function chunks<T>(values: T[], size = 500) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

async function insertError(
  query: DatabaseQuery,
  organizationId: string,
  importBatchId: string,
  importRowId: string | null,
  severity: "warning" | "error",
  fieldName: string | null,
  message: string,
) {
  await query(
    `INSERT INTO local801.import_errors (organization_id, import_batch_id, import_row_id, severity, field_name, message) VALUES ($1, $2, $3, $4, $5, $6)`,
    [organizationId, importBatchId, importRowId, severity, fieldName, message],
  );
}

async function setBatchState(
  query: DatabaseQuery,
  organizationId: string,
  batchId: string,
  state: string,
  reason: ImportRejectedReason | null = null,
) {
  await query(
    `UPDATE local801.import_batches SET state = $3, rejected_reason = $4,
      processing_stage = CASE WHEN $3 = 'rejected' THEN 'failed' ELSE processing_stage END,
      processing_error_code = CASE WHEN $3 = 'rejected' THEN $4 ELSE processing_error_code END
      WHERE id = $1 AND organization_id = $2`,
    [batchId, organizationId, state, reason],
  );
}

export async function persistImportReview(input: {
  actor: ImportActor;
  file: File;
  importKind: unknown;
  dependencies?: ImportPersistenceDependencies;
}): Promise<ImportReviewSummary> {
  if (!can(input.actor.role, "manageImports")) throw new Error("Forbidden.");
  const query = input.dependencies?.query ?? queryLocal801;
  const pendingWrites: DatabaseStatement[] = [];
  const write: DatabaseQuery = async <T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
    pendingWrites.push({ sql, parameters });
    return [] as T[];
  };
  const transaction = input.dependencies?.transaction ?? (async (statements: readonly DatabaseStatement[]) => {
    if (input.dependencies?.query) {
      for (const statement of statements) await input.dependencies.query(statement.sql, statement.parameters);
      return;
    }
    await runLocal801Transaction(statements);
  });
  const storeFile = input.dependencies?.storeFile ?? storeEncryptedImportFile;
  const audit = input.dependencies?.audit ?? ((event) => writeAuditEvent(event, query));
  const makeId = input.dependencies?.id ?? randomUUID;
  const maxBytes = getAppConfig().LOCAL801_IMPORT_MAX_BYTES;
  const maxRows = getAppConfig().LOCAL801_IMPORT_MAX_ROWS;
  ensureCandidateFile(input.file, maxBytes);
  const parsedKind = uploadImportKindSchema.safeParse(input.importKind || "current_roster");
  if (!parsedKind.success) fail("IMPORT_VALIDATION_FAILED", "validation_failed");
  const importKind = parsedKind.data;
  let sheets;
  try {
    sheets = await parseImportSheets(input.file);
  } catch {
    throw new ControlledImportError("MALFORMED_FILE", "malformed_file");
  }
  if (!sheets.length || !sheets.some((sheet) => sheet.state === "included")) fail("EMPTY_FILE", "empty_file");
  if (!sheets.some((sheet) => sheet.state === "included" && sheet.rows.length > 0)) fail("EMPTY_FILE", "empty_file");
  if (!sheets.some((sheet) => sheet.state === "included" && recognizedMappings(sheet.rows[0] ?? []).length > 0)) {
    fail("IMPORT_VALIDATION_FAILED", "validation_failed");
  }
  const batchId = makeId();

  try {
    const [createdBatch] = await query<{ id: string }>(
      `INSERT INTO local801.import_batches (id, organization_id, import_kind, state, uploaded_by, processing_stage, processed_row_count)
       SELECT $1, $2, $3, 'uploaded', id, 'uploaded', 0 FROM local801.users
       WHERE id = $4 AND organization_id = $2 AND deactivated_at IS NULL RETURNING id`,
      [batchId, input.actor.organizationId, importKind, input.actor.userId],
    );
    if (!createdBatch?.id) throw new ControlledImportError("SERVICE_UNAVAILABLE", "service_unavailable");
  } catch (error) {
    if (error instanceof ControlledImportError) throw error;
    throw new ControlledImportError("SERVICE_UNAVAILABLE", "service_unavailable");
  }
  let failureReason: ImportRejectedReason = "storage_failed";
  try {
    const stored = await storeFile({
      actor: input.actor,
      organizationId: input.actor.organizationId,
      importBatchId: batchId,
      originalFilename: input.file.name,
      mediaType: input.file.type || (filenameExtension(input.file.name) === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      content: Buffer.from(await input.file.arrayBuffer()),
    });
    failureReason = "audit_failed";
    await audit({
      eventType: "import.upload",
      actorId: input.actor.userId,
      organizationId: input.actor.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: { sourceFilename: input.file.name, byteSize: stored.byteSize, importKind },
    });
    failureReason = "persistence_failed";
    const sourceRowCount = sheets
      .filter((sheet) => sheet.state === "included")
      .reduce((count, sheet) => count + Math.max(0, sheet.rows.length - 1), 0);
    if (sourceRowCount > maxRows) {
      await insertError(query, input.actor.organizationId, batchId, null, "error", "file", "The import exceeds the configured row limit.");
      await setBatchState(query, input.actor.organizationId, batchId, "rejected", "row_limit_exceeded");
      throw new ControlledImportError("ROW_LIMIT_EXCEEDED", "row_limit_exceeded");
    }

    let totalRows = 0;
    let includedRows = 0;
    let excludedRows = 0;
    let rejectedRows = 0;
    let errorCount = 0;
    const previewRows: ImportReviewSummary["previewRows"] = [];
    const sheetSummaries: ImportReviewSummary["sheets"] = [];
    const seenIdentifiers = new Map<string, Record<string, string | null>>();

    for (const sheet of sheets) {
      const headers = sheet.rows[0] ?? [];
      const body = sheet.rows.slice(1);
      const sheetId = makeId();
      const persistedRows: Array<{ id: string; sourceRowNumber: number; rowHash: string; values: Record<string, string | null>; state: string }> = [];
      const persistedErrors: Array<{ id: string; rowId: string; field: string | null; message: string }> = [];
      await write(
        `INSERT INTO local801.import_sheets (id, organization_id, import_file_id, sheet_name, sheet_state, row_count) VALUES ($1, $2, $3, $4, $5, $6)`,
        [sheetId, input.actor.organizationId, stored.id, sheet.name, sheet.state, body.length],
      );
      sheetSummaries.push({ name: sheet.name, state: sheet.state, rowCount: body.length });
      if (sheet.state !== "included") continue;
      for (const mapping of recognizedMappings(headers)) {
        await write(
          `INSERT INTO local801.import_mappings (id, organization_id, import_sheet_id, source_column, target_column, transform) VALUES ($1, $2, $3, $4, $5, $6)`,
          [makeId(), input.actor.organizationId, sheetId, mapping.sourceColumn, mapping.targetColumn, mapping.transform],
        );
      }
      for (let index = 0; index < body.length; index += 1) {
        totalRows += 1;
        const values = normalizeImportRow(headers, body[index]);
        if (values.local && !shouldIncludeLocal801(values.local)) {
          excludedRows += 1;
          continue;
        }
        includedRows += 1;
        const rowId = makeId();
        let rowState = "pending";
        const rowErrors: Array<[string | null, string]> = [];
        const identifiers = identifierValues(values);
        if (!identifiers.length) rowErrors.push(["identifier", "Rows require an authoritative identifier; names are not used for merging."]);
        if (values.work_email?.trim() && !validWorkEmail(values.work_email.trim())) {
          rowErrors.push(["work_email", "The work email format is invalid."]);
        }
        if (values.home_email?.trim() && !validWorkEmail(values.home_email.trim())) {
          rowErrors.push(["home_email", "The home email format is invalid."]);
        }
        for (const [type, value] of identifiers) {
          const key = `${type}:${value.toLowerCase()}`;
          const previous = seenIdentifiers.get(key);
          if (previous) {
            rowErrors.push(["identifier", `Duplicate authoritative identifier '${value}' detected.`]);
            const conflictingFields = ["first_name", "last_name", "membership_status", "department", "work_location", "classification", "hire_date", "job_status", "work_email", "home_email", "work_phone", "cell_phone", "home_phone"]
              .filter((field) => previous[field] && values[field] && previous[field] !== values[field]);
            if (conflictingFields.length) rowErrors.push([conflictingFields.join(","), `Duplicate identifier has conflicting values for ${conflictingFields.join(", ")}.`]);
          } else {
            seenIdentifiers.set(key, values);
          }
        }
        if (rowErrors.length) {
          rowState = "rejected";
          rejectedRows += 1;
        }
        persistedRows.push({ id: rowId, sourceRowNumber: index + 2, rowHash: stableRowHash(values), values, state: rowState });
        for (const [field, message] of rowErrors) {
          persistedErrors.push({ id: makeId(), rowId, field, message });
          errorCount += 1;
        }
        if (previewRows.length < 50) previewRows.push({ rowNumber: index + 2, sheetName: sheet.name, state: rowState, values });
      }
      for (const group of chunks(persistedRows)) {
        await write(`
          INSERT INTO local801.import_rows
            (id, organization_id, import_sheet_id, source_row_number, row_hash, normalized_json, state)
          SELECT source.id, $1, $2, source.source_row_number, source.row_hash, source.normalized_json, source.state
          FROM jsonb_to_recordset($3::jsonb) AS source(
            id uuid, source_row_number integer, row_hash text, normalized_json jsonb, state text
          )
        `, [input.actor.organizationId, sheetId, JSON.stringify(group.map((row) => ({
          id: row.id, source_row_number: row.sourceRowNumber, row_hash: row.rowHash,
          normalized_json: row.values, state: row.state,
        })))]);
      }
      for (const group of chunks(persistedErrors)) {
        await write(`
          INSERT INTO local801.import_errors
            (id, organization_id, import_batch_id, import_row_id, severity, field_name, message)
          SELECT source.id, $1, $2, source.row_id, 'error', source.field_name, source.message
          FROM jsonb_to_recordset($3::jsonb) AS source(id uuid, row_id uuid, field_name text, message text)
        `, [input.actor.organizationId, batchId, JSON.stringify(group.map((item) => ({
          id: item.id, row_id: item.rowId, field_name: item.field, message: item.message,
        })))]);
      }
    }
    await write(`
      /* import:set-based-authoritative-matching */
      WITH batch_rows AS (
        SELECT row.id, row.normalized_json
        FROM local801.import_files file
        JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
        JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
        WHERE file.organization_id = $1 AND file.import_batch_id = $2
      ), evidence AS (
        SELECT row.id AS import_row_id, identifier.person_id, identifier.identifier_type::text AS rule
        FROM batch_rows row JOIN local801.person_identifiers identifier ON identifier.organization_id = $1
        JOIN local801.people person ON person.id = identifier.person_id AND person.organization_id = identifier.organization_id AND person.archived_at IS NULL
          AND ((identifier.identifier_type = 'employee_identifier' AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
            AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
            OR (identifier.identifier_type = 'member_identifier' AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
            AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
        UNION ALL
        SELECT row.id, contact.person_id, 'work_email'
        FROM batch_rows row JOIN local801.person_contact_methods contact ON contact.organization_id = $1
        JOIN local801.people person ON person.id = contact.person_id AND person.organization_id = contact.organization_id AND person.archived_at IS NULL
          AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
          AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
          AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
      ), grouped AS (
        SELECT import_row_id, person_id, string_agg(DISTINCT rule, '+' ORDER BY rule) AS match_rule
        FROM evidence GROUP BY import_row_id, person_id
      )
      INSERT INTO local801.import_match_candidates
        (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
      SELECT gen_random_uuid(), $1, import_row_id, person_id, match_rule, 1, false FROM grouped
    `, [input.actor.organizationId, batchId]);
    await write(`
      INSERT INTO local801.import_match_candidates
        (id, organization_id, import_row_id, person_id, match_rule, confidence, requires_review)
      SELECT gen_random_uuid(), $1, row.id, NULL, 'no_exact_match', 0, true
      FROM local801.import_files file
      JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
      JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
      WHERE file.organization_id = $1 AND file.import_batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id AND candidate.person_id IS NOT NULL)
    `, [input.actor.organizationId, batchId]);
    await write(`
      WITH conflicts AS (
        SELECT candidate.import_row_id
        FROM local801.import_match_candidates candidate
        JOIN local801.import_rows row ON row.id = candidate.import_row_id AND row.organization_id = candidate.organization_id
        JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
        JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
        WHERE candidate.organization_id = $1 AND file.import_batch_id = $2 AND candidate.person_id IS NOT NULL
        GROUP BY candidate.import_row_id HAVING count(DISTINCT candidate.person_id) > 1
      ), inserted AS (
        INSERT INTO local801.import_errors
          (organization_id, import_batch_id, import_row_id, severity, field_name, message)
        SELECT $1, $2, import_row_id, 'error', 'identifier',
          'Authoritative identifiers resolve to conflicting people; correct and re-upload the source.'
        FROM conflicts RETURNING import_row_id
      )
      UPDATE local801.import_rows row SET state = 'rejected'
      FROM inserted WHERE row.id = inserted.import_row_id AND row.organization_id = $1
    `, [input.actor.organizationId, batchId]);
    await write(`
      UPDATE local801.import_batches batch SET
        state = CASE WHEN EXISTS (SELECT 1 FROM local801.import_errors error
          WHERE error.organization_id = $1 AND error.import_batch_id = $2 AND error.severity = 'error')
          THEN 'under_review' ELSE 'validated' END,
        total_row_count = $3, included_row_count = $4, excluded_row_count = $5,
        rejected_row_count = (SELECT count(*)::int FROM local801.import_rows row
          JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
          JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
          WHERE row.organization_id = $1 AND file.import_batch_id = $2 AND row.state = 'rejected'),
        processed_row_count = $3, processing_stage = 'ready_for_review', processing_error_code = NULL
      WHERE batch.id = $2 AND batch.organization_id = $1
    `, [input.actor.organizationId, batchId, totalRows, includedRows, excludedRows]);
    await transaction(pendingWrites);
    const [persistedCounts] = await query<{ state: string; error_count: number | string; rejected_count: number | string }>(`
      SELECT batch.state,
        (SELECT count(*)::int FROM local801.import_errors error WHERE error.organization_id = $1 AND error.import_batch_id = $2) AS error_count,
        (SELECT count(*)::int FROM local801.import_rows row
          JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
          JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
          WHERE row.organization_id = $1 AND file.import_batch_id = $2 AND row.state = 'rejected') AS rejected_count
      FROM local801.import_batches batch WHERE batch.organization_id = $1 AND batch.id = $2
    `, [input.actor.organizationId, batchId]);
    const state: ImportReviewSummary["state"] = persistedCounts?.state === "rejected"
      ? "rejected"
      : persistedCounts?.state === "under_review" || errorCount > 0 ? "under_review" : "validated";
    errorCount = Number(persistedCounts?.error_count ?? errorCount);
    rejectedRows = Number(persistedCounts?.rejected_count ?? rejectedRows);
    failureReason = "audit_failed";
    await audit({
      eventType: "import.validation",
      actorId: input.actor.userId,
      organizationId: input.actor.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: { totalRows, includedRows, excludedRows, rejectedRows, errorCount, sheetCount: sheets.length },
    });
    return { batchId, sourceFilename: input.file.name, importKind, state, totalRows, includedRows, excludedRows, rejectedRows, errorCount, sheets: sheetSummaries, previewRows };
  } catch (error) {
    const controlled = error instanceof ControlledImportError
      ? error
      : new ControlledImportError(
          failureReason === "storage_failed" ? "SERVICE_UNAVAILABLE" : "IMPORT_PERSISTENCE_FAILED",
          failureReason,
        );
    try { await setBatchState(query, input.actor.organizationId, batchId, "rejected", controlled.reason); } catch { /* retain encrypted source and surface safe failure */ }
    throw controlled;
  }
}

export type ImportBatchQueueItem = {
  id: string;
  import_kind: string;
  state: string;
  original_filename: string | null;
  byte_size: number | null;
  created_at: string;
  total_rows: number;
  error_count: number;
  processing_stage: string | null;
  processed_row_count: number | null;
  total_row_count: number | null;
  processing_error_code: string | null;
};

type ImportBatchQueueRow = ImportBatchQueueItem & { cursor_token: string };
type ImportBatchCursor = { direction: "before" | "after"; createdAt: string; token: string };

function importBatchCursor(value: unknown): ImportBatchCursor | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const date = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
    const token = typeof parsed.token === "string" && /^[0-9a-f]{64}$/i.test(parsed.token) ? parsed.token.toLowerCase() : null;
    const direction = parsed.direction === "before" || parsed.direction === "after" ? parsed.direction : null;
    return date && !Number.isNaN(date.getTime()) && date.toISOString() === parsed.createdAt && token && direction
      ? { direction, createdAt: parsed.createdAt, token }
      : null;
  } catch {
    return null;
  }
}

function encodeImportBatchCursor(direction: ImportBatchCursor["direction"], row: ImportBatchQueueRow) {
  return Buffer.from(JSON.stringify({ direction, createdAt: new Date(row.created_at).toISOString(), token: row.cursor_token })).toString("base64url");
}

export async function getImportBatchesPage(
  actor: ImportActor,
  input: { cursor?: unknown; pageSize?: unknown } = {},
  query: DatabaseQuery = queryLocal801,
) {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  const requestedPageSize = Number(input.pageSize);
  const pageSize = [10, 20, 50, 100].includes(requestedPageSize) ? requestedPageSize : DEFAULT_IMPORT_BATCH_PAGE_SIZE;
  const cursor = importBatchCursor(input.cursor);
  const comparison = cursor?.direction === "before" ? ">" : "<";
  const ordering = cursor?.direction === "before" ? "ASC" : "DESC";
  const rows = await query<ImportBatchQueueRow>(
    `
      /* imports:batch-keyset-page */
      WITH visible_batches AS (
        SELECT batch.id, batch.import_kind, batch.state, file.original_filename, file.byte_size, batch.created_at,
          batch.processing_stage, batch.processed_row_count, batch.total_row_count, batch.processing_error_code,
          encode(public.digest(batch.organization_id::text || ':' || batch.id::text, 'sha256'), 'hex') AS cursor_token,
          (SELECT count(*)::int FROM local801.import_rows row WHERE row.organization_id = batch.organization_id AND row.import_sheet_id IN (SELECT id FROM local801.import_sheets WHERE import_file_id = file.id AND organization_id = batch.organization_id)) AS total_rows,
          (SELECT count(*)::int FROM local801.import_errors error WHERE error.organization_id = batch.organization_id AND error.import_batch_id = batch.id) AS error_count
        FROM local801.import_batches batch
        LEFT JOIN LATERAL (SELECT original_filename, byte_size, id FROM local801.import_files WHERE import_batch_id = batch.id AND organization_id = batch.organization_id ORDER BY created_at ASC LIMIT 1) file ON true
        WHERE batch.organization_id = $1::uuid
      )
      SELECT * FROM visible_batches
      WHERE ($2::timestamptz IS NULL OR (created_at, cursor_token) ${comparison} ($2::timestamptz, $3::text))
      ORDER BY created_at ${ordering}, cursor_token ${ordering}
      LIMIT $4::integer
    `,
    [actor.organizationId, cursor?.createdAt ?? null, cursor?.token ?? null, pageSize + 1],
  );
  const hasExtra = rows.length > pageSize;
  const bounded = rows.slice(0, pageSize);
  if (cursor?.direction === "before") bounded.reverse();
  const first = bounded[0];
  const last = bounded.at(-1);
  return {
    items: bounded.map(({ cursor_token: _cursorToken, ...item }) => item),
    previousCursor: first && (cursor?.direction === "after" || (cursor?.direction === "before" && hasExtra))
      ? encodeImportBatchCursor("before", first)
      : null,
    nextCursor: last && (hasExtra || cursor?.direction === "before")
      ? encodeImportBatchCursor("after", last)
      : null,
    pageSize,
  };
}

export async function listImportBatches(actor: ImportActor, query: DatabaseQuery = queryLocal801) {
  return (await getImportBatchesPage(actor, {}, query)).items;
}

export const __importBatchTesting = { importBatchCursor };

export async function getImportBatch(actor: ImportActor, batchId: string, query: DatabaseQuery = queryLocal801) {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  const [batch] = await query<{
    id: string; import_kind: string; state: string; rejected_reason: string | null; created_at: string;
    original_filename: string | null; byte_size: number | null; malware_scan_status: string | null;
    total_rows: number; error_count: number; processing_stage: string | null;
    processed_row_count: number | null; total_row_count: number | null; processing_error_code: string | null;
  }>(
    `
      SELECT batch.id, batch.import_kind, batch.state, batch.rejected_reason, batch.created_at,
        file.original_filename, file.byte_size, file.malware_scan_status,
        batch.processing_stage, batch.processed_row_count, batch.total_row_count, batch.processing_error_code,
        (SELECT count(*)::int FROM local801.import_rows row WHERE row.organization_id = batch.organization_id AND row.import_sheet_id IN (SELECT id FROM local801.import_sheets WHERE import_file_id = file.id AND organization_id = batch.organization_id)) AS total_rows,
        (SELECT count(*)::int FROM local801.import_errors error WHERE error.organization_id = batch.organization_id AND error.import_batch_id = batch.id) AS error_count
      FROM local801.import_batches batch
      LEFT JOIN LATERAL (SELECT original_filename, byte_size, malware_scan_status, id FROM local801.import_files WHERE import_batch_id = batch.id AND organization_id = batch.organization_id ORDER BY created_at ASC LIMIT 1) file ON true
      WHERE batch.id = $1 AND batch.organization_id = $2
    `,
    [batchId, actor.organizationId],
  );
  return batch ?? null;
}

export async function getImportProcessingStatus(actor: ImportActor, batchId: string, query: DatabaseQuery = queryLocal801) {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  const [batch] = await query<{
    processing_stage: string | null;
    processed_row_count: number | null;
    total_row_count: number | null;
    processing_error_code: string | null;
  }>(`
    SELECT processing_stage, processed_row_count, total_row_count, processing_error_code
    FROM local801.import_batches
    WHERE id = $1::uuid AND organization_id = $2::uuid
    LIMIT 1
  `, [batchId, actor.organizationId]);
  return batch ?? null;
}

export async function getImportErrors(actor: ImportActor, batchId: string, query: DatabaseQuery = queryLocal801) {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  const rows = await query<{ row_number: number | null; severity: string; field_name: string | null; message: string }>(
    `
      SELECT CASE WHEN file.import_batch_id = $2 THEN row.source_row_number ELSE NULL END AS row_number,
        error.severity, error.field_name, error.message
      FROM local801.import_errors error
      LEFT JOIN local801.import_rows row ON row.id = error.import_row_id AND row.organization_id = error.organization_id
      LEFT JOIN local801.import_sheets sheet ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      LEFT JOIN local801.import_files file ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      WHERE error.organization_id = $1
        AND error.import_batch_id = $2
      ORDER BY error.created_at, error.id
      LIMIT ${MAX_IMPORT_ERROR_EXPORT_ROWS + 1}
    `,
    [actor.organizationId, batchId],
  );
  if (rows.length > MAX_IMPORT_ERROR_EXPORT_ROWS) {
    throw new Error("Import error export exceeds the safe synchronous limit.");
  }
  return rows;
}

export async function getImportPreviewRows(actor: ImportActor, batchId: string, query: DatabaseQuery = queryLocal801) {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  return query<{ sheet_name: string; source_row_number: number; state: string; normalized_json: Record<string, string | null> }>(
    `
      SELECT sheet.sheet_name, row.source_row_number, row.state, row.normalized_json
      FROM local801.import_rows row
      JOIN local801.import_sheets sheet
        ON sheet.id = row.import_sheet_id AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file
        ON file.id = sheet.import_file_id AND file.organization_id = sheet.organization_id
      WHERE row.organization_id = $1 AND file.import_batch_id = $2 AND file.organization_id = $1
      ORDER BY sheet.created_at, row.source_row_number
      LIMIT 50
    `,
    [actor.organizationId, batchId],
  );
}

export async function getImportMatchCandidates(
  actor: ImportActor,
  batchId: string,
  query: DatabaseQuery = queryLocal801,
): Promise<ImportMatchReview[]> {
  if (!can(actor.role, "manageImports")) throw new Error("Forbidden.");
  const rows = await query<ImportMatchCandidateDatabaseRow>(
    `
      SELECT
        candidate.id AS candidate_id,
        row.id AS import_row_id,
        sheet.sheet_name,
        row.source_row_number,
        row.state AS row_state,
        row.normalized_json ->> 'first_name' AS imported_first_name,
        row.normalized_json ->> 'last_name' AS imported_last_name,
        row.normalized_json ->> 'work_email' AS imported_work_email,
        row.normalized_json ->> 'department' AS imported_department,
        row.normalized_json ->> 'classification' AS imported_classification,
        (
          NULLIF(row.normalized_json ->> 'employee_identifier', '') IS NOT NULL
          OR NULLIF(row.normalized_json ->> 'member_identifier', '') IS NOT NULL
          OR NULLIF(row.normalized_json ->> 'work_email', '') IS NOT NULL
        ) AS has_authoritative_identifier,
        candidate.person_id,
        candidate.match_rule,
        candidate.requires_review,
        person.preferred_name AS existing_preferred_name,
        person.first_name AS existing_first_name,
        person.last_name AS existing_last_name,
        person.department AS existing_department,
        person.classification AS existing_classification,
        CASE
          WHEN candidate.match_rule LIKE '%work_email%' THEN existing_work_email.contact_value
          ELSE NULL
        END AS existing_work_email,
        (
          SELECT count(DISTINCT related_candidate.person_id)::int
          FROM local801.import_match_candidates related_candidate
          WHERE related_candidate.organization_id = $1
            AND related_candidate.import_row_id = row.id
            AND related_candidate.person_id IS NOT NULL
        ) AS matched_person_count
      FROM local801.import_match_candidates candidate
      JOIN local801.import_rows row
        ON row.id = candidate.import_row_id
       AND row.organization_id = candidate.organization_id
      JOIN local801.import_sheets sheet
        ON sheet.id = row.import_sheet_id
       AND sheet.organization_id = row.organization_id
      JOIN local801.import_files file
        ON file.id = sheet.import_file_id
       AND file.organization_id = sheet.organization_id
      JOIN local801.import_batches batch
        ON batch.id = file.import_batch_id
       AND batch.organization_id = file.organization_id
      LEFT JOIN local801.people person
        ON person.id = candidate.person_id
       AND person.organization_id = candidate.organization_id
       AND person.archived_at IS NULL
      LEFT JOIN LATERAL (
        SELECT contact.contact_value
        FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1
          AND contact.person_id = person.id
          AND contact.contact_type = 'work_email'
          AND contact.archived_at IS NULL
        ORDER BY contact.is_primary DESC, contact.created_at, contact.id
        LIMIT 1
      ) existing_work_email ON true
      WHERE candidate.organization_id = $1
        AND row.organization_id = $1
        AND sheet.organization_id = $1
        AND file.organization_id = $1
        AND batch.organization_id = $1
        AND batch.id = $2
      ORDER BY sheet.created_at, sheet.id, row.source_row_number, candidate.id
      LIMIT 50
    `,
    [actor.organizationId, batchId],
  );

  const reviews = new Map<string, ImportMatchReview>();
  for (const row of rows) {
    const matchedPersonCount = Number(row.matched_person_count);
    const status = matchedPersonCount > 1
      ? "conflicting_match"
      : row.row_state === "rejected"
        ? "rejected"
        : row.person_id
          ? "exact_match"
          : "no_exact_match";
    const review = reviews.get(row.import_row_id) ?? {
      importRowId: row.import_row_id,
      sheetName: row.sheet_name,
      sourceRowNumber: row.source_row_number,
      rowState: row.row_state,
      importedFirstName: row.imported_first_name,
      importedLastName: row.imported_last_name,
      importedWorkEmail: row.imported_work_email,
      importedDepartment: row.imported_department,
      importedClassification: row.imported_classification,
      hasAuthoritativeIdentifier: row.has_authoritative_identifier,
      status,
      requiresReview: false,
      candidates: [],
    } satisfies ImportMatchReview;
    review.requiresReview ||= row.requires_review;
    review.candidates.push({
      id: row.candidate_id,
      personId: row.person_id,
      matchRule: row.match_rule,
      existingPreferredName: row.existing_preferred_name,
      existingFirstName: row.existing_first_name,
      existingLastName: row.existing_last_name,
      existingDepartment: row.existing_department,
      existingClassification: row.existing_classification,
      existingWorkEmail: row.existing_work_email,
    });
    reviews.set(row.import_row_id, review);
  }
  return [...reviews.values()];
}

export const IMPORT_AUDIT_EVENT_TYPES: readonly AuditEventType[] = ["import.upload", "import.validation", "import.reject_errors_download"];
