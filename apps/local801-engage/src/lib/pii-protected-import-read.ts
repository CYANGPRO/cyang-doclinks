import "server-only";

import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { ImportReviewDetail } from "./import-review.ts";
import {
  createPiiIntegrityHash,
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import {
  assertPiiProtectedReadState,
  getPiiProtectedReadMode,
  isPiiProtectedReadEnabled,
  PiiProtectedReadError,
} from "./pii-protected-read.ts";

const PROTECTED_BATCH_LIMIT = 20;
const PROTECTED_REVIEW_ROW_LIMIT = 100;
const DIRECT_IMPORT_PII_FIELDS = new Set([
  "first_name",
  "last_name",
  "preferred_name",
  "work_email",
  "employee_identifier",
  "member_identifier",
]);

type BatchWithFilename = {
  id: string;
  original_filename: string | null;
};

type ProtectedImportFileRow = {
  batch_id: string;
  import_file_id: string;
  original_filename_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

type ProtectedImportReviewRow = {
  sheet_name: string;
  source_row_number: number;
  import_row_id: string;
  direct_pii_encrypted_payload: string | null;
  encryption_key_version: string | null;
  encryption_format_version: number | null;
  direct_pii_field_set_version: number | null;
  direct_pii_presence_mask: number | null;
  direct_pii_validity_mask: number | null;
  row_integrity_hash: string | null;
  row_integrity_key_version: string | null;
};

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

function encrypted(row: ProtectedImportFileRow): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  if (
    typeof row.original_filename_encrypted_payload !== "string"
    || typeof row.encryption_key_version !== "string"
    || Number(row.encryption_format_version) !== 1
  ) {
    blocked("ENVELOPE_INVALID", "An import-file protected PII companion has an invalid envelope.");
  }
  return {
    encryptedPayload: row.original_filename_encrypted_payload,
    encryptionKeyVersion: row.encryption_key_version,
    encryptionFormatVersion: 1,
  };
}

function decryptFilename(row: ProtectedImportFileRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row),
    { organizationId, entity: "import-file", recordId: row.import_file_id, field: "original-filename" },
    keyConfig,
  );
}

function uniqueMap(rows: readonly ProtectedImportFileRow[]) {
  const result = new Map<string, ProtectedImportFileRow>();
  for (const row of rows) {
    if (result.has(row.batch_id)) blocked("DUPLICATE_COMPANION", "Duplicate protected import-file companion detected for a batch.");
    result.set(row.batch_id, row);
  }
  return result;
}

function coordinateKey(sheetName: string, sourceRowNumber: number) {
  return JSON.stringify([sheetName, sourceRowNumber]);
}

function reviewEnvelope(row: ProtectedImportReviewRow): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const fieldSetVersion = Number(row.direct_pii_field_set_version);
  if (
    typeof row.direct_pii_encrypted_payload !== "string"
    || typeof row.encryption_key_version !== "string"
    || Number(row.encryption_format_version) !== 1
    || (fieldSetVersion !== 1 && fieldSetVersion !== 2)
  ) {
    blocked("ENVELOPE_INVALID", "An import-row protected PII companion has an invalid or unsupported envelope.");
  }
  if (fieldSetVersion === 2) {
    const presence = Number(row.direct_pii_presence_mask);
    const validity = Number(row.direct_pii_validity_mask);
    if (!Number.isInteger(presence) || presence < 0 || presence > 63
      || !Number.isInteger(validity) || validity < 0 || validity > 63
      || (validity & presence) !== validity) {
      blocked("ENVELOPE_INVALID", "An import-row protected PII companion has invalid field metadata.");
    }
  }
  return {
    encryptedPayload: row.direct_pii_encrypted_payload,
    encryptionKeyVersion: row.encryption_key_version,
    encryptionFormatVersion: 1,
  };
}

function directPiiBundle(row: ProtectedImportReviewRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  const plaintext = decryptPiiField(
    reviewEnvelope(row),
    { organizationId, entity: "import-row", recordId: row.import_row_id, field: "direct-pii" },
    keyConfig,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    blocked("PAYLOAD_INVALID", "An import-row protected PII bundle is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    blocked("PAYLOAD_INVALID", "An import-row protected PII bundle is invalid.");
  }
  const bundle: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!DIRECT_IMPORT_PII_FIELDS.has(key) || typeof value !== "string" || value.trim() === "") {
      blocked("PAYLOAD_INVALID", "An import-row protected PII bundle has an unsupported field set.");
    }
    bundle[key] = value;
  }
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))));
  if (
    typeof row.row_integrity_hash !== "string"
    || !/^[0-9a-f]{64}$/.test(row.row_integrity_hash)
    || typeof row.row_integrity_key_version !== "string"
  ) {
    blocked("INTEGRITY_INVALID", "An import-row protected PII integrity record is invalid.");
  }
  const integrity = createPiiIntegrityHash(
    canonical,
    { organizationId, domain: "import-row", keyVersion: row.row_integrity_key_version },
    keyConfig,
  );
  if (integrity.blindIndex !== row.row_integrity_hash) {
    blocked("INTEGRITY_MISMATCH", "An import-row protected PII bundle failed integrity verification.");
  }
  return bundle;
}

async function requireProtectedState(organizationId: string, query: DatabaseQuery, env: NodeJS.ProcessEnv) {
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return false;
  await assertPiiProtectedReadState(organizationId, query, mode);
  return true;
}

export async function hydrateImportBatchQueueFromProtectedPii<T extends BatchWithFilename>(
  organizationId: string,
  queue: readonly T[],
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<T[]> {
  const env = dependencies.env ?? process.env;
  if (!isPiiProtectedReadEnabled(env)) return [...queue];
  if (queue.length > PROTECTED_BATCH_LIMIT) blocked("PROTECTED_BOUND_EXCEEDED", "Protected import reads exceeded the bounded batch limit.");
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await requireProtectedState(organizationId, query, env);

  const rows = await query<ProtectedImportFileRow>(`
    /* pii-protected-import-read:queue-files */
    WITH latest_batches AS (
      SELECT batch.id, batch.created_at
      FROM local801.import_batches batch
      WHERE batch.organization_id = $1::uuid
      ORDER BY batch.created_at DESC, batch.id DESC
      LIMIT ${PROTECTED_BATCH_LIMIT}
    )
    SELECT batch.id::text AS batch_id,
      file.id::text AS import_file_id,
      protected.original_filename_encrypted_payload,
      protected.encryption_key_version,
      protected.encryption_format_version
    FROM latest_batches batch
    LEFT JOIN LATERAL (
      SELECT candidate.id
      FROM local801.import_files candidate
      WHERE candidate.organization_id = $1::uuid
        AND candidate.import_batch_id = batch.id
      ORDER BY candidate.created_at ASC, candidate.id ASC
      LIMIT 1
    ) file ON true
    LEFT JOIN local801.import_file_pii protected
      ON protected.organization_id = $1::uuid
      AND protected.import_file_id = file.id
    WHERE file.id IS NOT NULL
    ORDER BY batch.created_at DESC, batch.id DESC
  `, [organizationId]);

  const byBatch = uniqueMap(rows);
  return queue.map((item) => {
    const row = byBatch.get(item.id);
    if (!row) {
      if (item.original_filename === null) return { ...item, original_filename: null };
      blocked("COMPANION_MISSING", "An import batch is missing its protected source-filename companion.");
    }
    return { ...item, original_filename: decryptFilename(row, organizationId, keyConfig) };
  });
}

export async function hydrateImportBatchFromProtectedPii<T extends BatchWithFilename>(
  organizationId: string,
  batch: T,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<T> {
  const env = dependencies.env ?? process.env;
  if (!isPiiProtectedReadEnabled(env)) return batch;
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await requireProtectedState(organizationId, query, env);

  const rows = await query<ProtectedImportFileRow>(`
    /* pii-protected-import-read:detail-file */
    SELECT batch.id::text AS batch_id,
      file.id::text AS import_file_id,
      protected.original_filename_encrypted_payload,
      protected.encryption_key_version,
      protected.encryption_format_version
    FROM local801.import_batches batch
    LEFT JOIN LATERAL (
      SELECT candidate.id
      FROM local801.import_files candidate
      WHERE candidate.organization_id = batch.organization_id
        AND candidate.import_batch_id = batch.id
      ORDER BY candidate.created_at ASC, candidate.id ASC
      LIMIT 1
    ) file ON true
    LEFT JOIN local801.import_file_pii protected
      ON protected.organization_id = batch.organization_id
      AND protected.import_file_id = file.id
    WHERE batch.organization_id = $1::uuid
      AND batch.id = $2::uuid
      AND file.id IS NOT NULL
    LIMIT 2
  `, [organizationId, batch.id]);
  if (rows.length > 1) blocked("DUPLICATE_COMPANION", "Duplicate protected import-file companion detected for a batch.");
  const row = rows[0];
  if (!row) {
    if (batch.original_filename === null) return { ...batch, original_filename: null };
    blocked("COMPANION_MISSING", "The import batch is missing its protected source-filename companion.");
  }
  return { ...batch, original_filename: decryptFilename(row, organizationId, keyConfig) };
}

export async function hydrateImportReviewDetailFromProtectedPii(
  organizationId: string,
  batchId: string,
  detail: ImportReviewDetail,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<ImportReviewDetail> {
  const env = dependencies.env ?? process.env;
  if (!isPiiProtectedReadEnabled(env) || detail.rows.length === 0) return detail;
  if (detail.rows.length > PROTECTED_REVIEW_ROW_LIMIT) {
    blocked("PROTECTED_BOUND_EXCEEDED", "Protected import review exceeded its bounded row limit.");
  }
  const requested = detail.rows.map((row) => ({ sheet_name: row.sheet_name, source_row_number: row.source_row_number }));
  const requestedKeys = new Set(requested.map((row) => coordinateKey(row.sheet_name, row.source_row_number)));
  if (requestedKeys.size !== requested.length) {
    blocked("DUPLICATE_SOURCE_COORDINATE", "Import review detail contains duplicate source coordinates.");
  }
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await requireProtectedState(organizationId, query, env);

  const rows = await query<ProtectedImportReviewRow>(`
    /* pii-protected-import-read:review-rows */
    WITH requested AS (
      SELECT source.sheet_name, source.source_row_number
      FROM jsonb_to_recordset($3::text::jsonb) AS source(sheet_name text, source_row_number integer)
    )
    SELECT sheet.sheet_name,
      row.source_row_number,
      row.id::text AS import_row_id,
      protected.direct_pii_encrypted_payload,
      protected.encryption_key_version,
      protected.encryption_format_version,
      protected.direct_pii_field_set_version,
      protected.direct_pii_presence_mask,
      protected.direct_pii_validity_mask,
      protected.row_integrity_hash,
      protected.row_integrity_key_version
    FROM local801.import_batches batch
    JOIN local801.import_files file
      ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
    JOIN local801.import_sheets sheet
      ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row
      ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    JOIN requested source
      ON source.sheet_name = sheet.sheet_name AND source.source_row_number = row.source_row_number
    LEFT JOIN local801.import_row_pii protected
      ON protected.organization_id = row.organization_id AND protected.import_row_id = row.id
    WHERE batch.organization_id = $1::uuid
      AND batch.id = $2::uuid
    ORDER BY sheet.sheet_name, row.source_row_number, row.id
  `, [organizationId, batchId, JSON.stringify(requested)]);

  const byCoordinate = new Map<string, ProtectedImportReviewRow>();
  for (const row of rows) {
    const key = coordinateKey(row.sheet_name, Number(row.source_row_number));
    if (byCoordinate.has(key)) {
      blocked("DUPLICATE_COMPANION", "Duplicate protected import-row companion detected for a source coordinate.");
    }
    byCoordinate.set(key, row);
  }
  if (byCoordinate.size !== detail.rows.length) {
    blocked("COMPANION_MISSING", "An import review row is missing its protected direct-PII companion.");
  }

  return {
    ...detail,
    rows: detail.rows.map((row) => {
      const protectedRow = byCoordinate.get(coordinateKey(row.sheet_name, row.source_row_number));
      if (!protectedRow) blocked("COMPANION_MISSING", "An import review row is missing its protected direct-PII companion.");
      const bundle = directPiiBundle(protectedRow, organizationId, keyConfig);
      return {
        ...row,
        first_name: bundle.first_name ?? null,
        last_name: bundle.last_name ?? null,
        work_email: bundle.work_email ?? null,
      };
    }),
  };
}
