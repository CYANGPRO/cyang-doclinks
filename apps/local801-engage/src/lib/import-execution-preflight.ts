import "server-only";

import { createHash } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import { getImportReviewSummary, type ImportReviewActor } from "./import-review.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const LARGE_SHRINK_THRESHOLD_PERCENT = -20;

export type ImportExecutionReasonCode =
  | "EXECUTION_MIGRATION_REQUIRED"
  | "BATCH_NOT_REVIEWABLE"
  | "ALREADY_APPROVED"
  | "UNSUPPORTED_IMPORT_KIND"
  | "SOURCE_FILE_REQUIRED"
  | "MALWARE_NOT_CLEAN"
  | "REVIEW_BLOCKERS"
  | "PROPOSED_NEW_DECISION_REQUIRED"
  | "EXISTING_CHANGES_ACK_REQUIRED"
  | "SNAPSHOT_DATE_REQUIRED"
  | "EFFECTIVE_DATE_REQUIRED"
  | "DUPLICATE_SOURCE_ACK_REQUIRED"
  | "LARGE_ROSTER_SHRINK_ACK_REQUIRED";

export type ImportExecutionReason = { code: ImportExecutionReasonCode; message: string };

export type ImportExecutionPreflight = {
  ready: boolean;
  fingerprint: string | null;
  fingerprintShort: string | null;
  importKind: string | null;
  batchState: string | null;
  processingStage: string | null;
  source: {
    fileCount: number;
    sha256: string | null;
    malwareStatus: string | null;
    duplicateApprovedSource: boolean;
  };
  plan: {
    snapshotDate: string | null;
    effectiveDate: string | null;
    duplicateSourceAcknowledged: boolean;
    largeRosterShrinkAcknowledged: boolean;
    migrationPending: boolean;
  };
  review: {
    total: number;
    unchangedExisting: number;
    existingWithChanges: number;
    proposedNew: number;
    needsAttention: number;
    rejected: number;
    blockingErrors: number;
  };
  shrink: {
    required: boolean;
    percentChange: number | null;
  };
  reasons: ImportExecutionReason[];
};

type MetaRow = {
  id: string;
  import_kind: string;
  state: string;
  processing_stage: string | null;
  file_count: number | string;
  source_sha256: string | null;
  malware_scan_status: string | null;
  snapshot_date: string | Date | null;
  effective_date: string | Date | null;
  duplicate_source_acknowledged: boolean | null;
  large_roster_shrink_acknowledged?: boolean | null;
  large_roster_shrink_set_hash?: string | null;
  duplicate_source_exists: boolean;
  row_set_hash: string;
};

export class ImportExecutionPreflightError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ImportExecutionPreflightError";
    this.code = code;
    this.status = status;
  }
}

function requireApprover(actor: ImportReviewActor) {
  if (!can(actor.role, "approveImports")) {
    throw new ImportExecutionPreflightError("FORBIDDEN", "Import execution preflight is not authorized.", 403);
  }
}

function requireBatchId(value: string) {
  if (!UUID_RE.test(value)) throw new ImportExecutionPreflightError("IMPORT_NOT_FOUND", "Import batch not found.", 404);
}

function count(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function dateOnly(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function isMissingPreflightMigration(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "42703");
}

function supportedImportKind(value: string) {
  return value === "current_roster" || value === "new_hires"
    || value === "membership_additions" || value === "membership_drops";
}

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(value, Object.keys(value).sort());
}

const metaQueryBase = `
  WITH selected_batch AS (
    SELECT batch.id, batch.import_kind, batch.state, batch.processing_stage
    FROM local801.import_batches batch
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
    LIMIT 1
  ), source AS (
    SELECT count(file.id)::int AS file_count,
      CASE WHEN count(file.id) = 1 THEN min(file.sha256) END AS source_sha256,
      CASE WHEN count(file.id) = 1 THEN min(file.malware_scan_status) END AS malware_scan_status
    FROM selected_batch batch
    LEFT JOIN local801.import_files file
      ON file.organization_id = $1::uuid AND file.import_batch_id = batch.id
  ), row_fingerprint AS (
    SELECT encode(digest(COALESCE(string_agg(
      encode(digest(concat_ws(chr(31), file.sha256, sheet.sheet_name, row.source_row_number::text, row.row_hash), 'sha256'), 'hex'),
      ':' ORDER BY file.sha256, sheet.sheet_name, row.source_row_number, row.id
    ), ''), 'sha256'), 'hex') AS row_set_hash
    FROM selected_batch batch
    JOIN local801.import_files file
      ON file.organization_id = $1::uuid AND file.import_batch_id = batch.id
    JOIN local801.import_sheets sheet
      ON sheet.organization_id = $1::uuid AND sheet.import_file_id = file.id
    JOIN local801.import_rows row
      ON row.organization_id = $1::uuid AND row.import_sheet_id = sheet.id
  ), duplicate_source AS (
    SELECT source.source_sha256 IS NOT NULL AND EXISTS (
      SELECT 1
      FROM local801.import_files prior_file
      JOIN local801.import_batches prior_batch
        ON prior_batch.id = prior_file.import_batch_id
       AND prior_batch.organization_id = prior_file.organization_id
      JOIN selected_batch current_batch ON true
      WHERE prior_file.organization_id = $1::uuid
        AND prior_file.sha256 = source.source_sha256
        AND prior_batch.state = 'approved'
        AND prior_batch.id <> current_batch.id
    ) AS duplicate_source_exists
    FROM source
  )
`;

async function loadMeta(actor: ImportReviewActor, batchId: string, query: DatabaseQuery) {
  try {
    const [row] = await query<MetaRow>(`${metaQueryBase}
      SELECT batch.id, batch.import_kind, batch.state, batch.processing_stage,
        source.file_count, source.source_sha256, source.malware_scan_status,
        plan.snapshot_date, plan.effective_date, plan.duplicate_source_acknowledged,
        plan.large_roster_shrink_acknowledged, plan.large_roster_shrink_set_hash,
        duplicate_source.duplicate_source_exists, row_fingerprint.row_set_hash
      FROM selected_batch batch
      CROSS JOIN source
      CROSS JOIN duplicate_source
      CROSS JOIN row_fingerprint
      LEFT JOIN local801.import_approval_plans plan
        ON plan.organization_id = $1::uuid AND plan.import_batch_id = batch.id
    `, [actor.organizationId, batchId]);
    return { row: row ?? null, migrationPending: false };
  } catch (error) {
    if (!isMissingPreflightMigration(error)) throw error;
    const [row] = await query<MetaRow>(`${metaQueryBase}
      SELECT batch.id, batch.import_kind, batch.state, batch.processing_stage,
        source.file_count, source.source_sha256, source.malware_scan_status,
        plan.snapshot_date, plan.effective_date, plan.duplicate_source_acknowledged,
        duplicate_source.duplicate_source_exists, row_fingerprint.row_set_hash
      FROM selected_batch batch
      CROSS JOIN source
      CROSS JOIN duplicate_source
      CROSS JOIN row_fingerprint
      LEFT JOIN local801.import_approval_plans plan
        ON plan.organization_id = $1::uuid AND plan.import_batch_id = batch.id
    `, [actor.organizationId, batchId]);
    return { row: row ?? null, migrationPending: true };
  }
}

function reason(code: ImportExecutionReasonCode, message: string): ImportExecutionReason {
  return { code, message };
}

export async function getImportExecutionPreflight(
  actor: ImportReviewActor,
  batchId: string,
  query: DatabaseQuery = queryLocal801,
): Promise<ImportExecutionPreflight> {
  requireApprover(actor);
  requireBatchId(batchId);
  const [summary, meta] = await Promise.all([
    getImportReviewSummary(actor, batchId, query),
    loadMeta(actor, batchId, query),
  ]);
  if (!meta.row) throw new ImportExecutionPreflightError("IMPORT_NOT_FOUND", "Import batch not found.", 404);

  const row = meta.row;
  const snapshotDate = dateOnly(row.snapshot_date);
  const effectiveDate = dateOnly(row.effective_date);
  const fileCount = count(row.file_count);
  const fingerprintInput = row.source_sha256 && HASH_RE.test(row.row_set_hash) ? {
    batchId,
    importKind: row.import_kind,
    sourceSha256: row.source_sha256,
    rowSetHash: row.row_set_hash,
    proposedNewSetHash: summary.hashes.proposedNew,
    existingChangesSetHash: summary.hashes.existingChanges,
    counts: [
      summary.counts.total,
      summary.counts.unchangedExisting,
      summary.counts.existingWithChanges,
      summary.counts.proposedNew,
      summary.counts.needsAttention,
      summary.counts.rejected,
    ],
    snapshotDate,
    effectiveDate,
  } : null;
  const fingerprint = fingerprintInput
    ? createHash("sha256").update(canonical(fingerprintInput)).digest("hex")
    : null;
  const shrinkRequired = row.import_kind === "current_roster"
    && summary.snapshot?.percentChange != null
    && summary.snapshot.percentChange <= LARGE_SHRINK_THRESHOLD_PERCENT;
  const shrinkAck = !shrinkRequired || (
    row.large_roster_shrink_acknowledged === true
    && fingerprint !== null
    && row.large_roster_shrink_set_hash === fingerprint
  );

  const reasons: ImportExecutionReason[] = [];
  if (meta.migrationPending) reasons.push(reason("EXECUTION_MIGRATION_REQUIRED", "Migration 0010 must be applied before authoritative execution can be enabled."));
  if (row.state === "approved") reasons.push(reason("ALREADY_APPROVED", "This import batch is already approved and cannot execute again."));
  else if (row.state === "rejected" || row.processing_stage !== "ready_for_review") reasons.push(reason("BATCH_NOT_REVIEWABLE", "The import batch must be fully processed and ready for review."));
  if (!supportedImportKind(row.import_kind)) reasons.push(reason("UNSUPPORTED_IMPORT_KIND", "This import kind is review-only and cannot execute authoritative roster changes."));
  if (fileCount !== 1 || !row.source_sha256) reasons.push(reason("SOURCE_FILE_REQUIRED", "Exactly one immutable source file is required for execution."));
  if (row.malware_scan_status !== "clean") reasons.push(reason("MALWARE_NOT_CLEAN", "The source file must have a clean malware scan before execution."));
  if (summary.blockers > 0 || summary.counts.blockingErrors > 0 || summary.decisions.migrationPending) {
    reasons.push(reason("REVIEW_BLOCKERS", "All validation and identity-review blockers must be resolved before execution."));
  }
  if (!summary.decisions.proposedNew) reasons.push(reason("PROPOSED_NEW_DECISION_REQUIRED", "The current proposed-new set must be explicitly allowed."));
  if (!summary.decisions.existingChanges) reasons.push(reason("EXISTING_CHANGES_ACK_REQUIRED", "The current existing-change set must be acknowledged."));
  if (row.import_kind === "current_roster" && !snapshotDate) reasons.push(reason("SNAPSHOT_DATE_REQUIRED", "Set the authoritative roster snapshot date before execution."));
  if (["new_hires", "membership_additions", "membership_drops"].includes(row.import_kind) && !effectiveDate) {
    reasons.push(reason("EFFECTIVE_DATE_REQUIRED", "Set the batch effective date before execution."));
  }
  if (row.duplicate_source_exists && row.duplicate_source_acknowledged !== true) {
    reasons.push(reason("DUPLICATE_SOURCE_ACK_REQUIRED", "This source matches a previously approved import and requires explicit acknowledgement."));
  }
  if (shrinkRequired && !shrinkAck) {
    reasons.push(reason("LARGE_ROSTER_SHRINK_ACK_REQUIRED", "A roster decrease of 20% or more requires an acknowledgement bound to this exact execution fingerprint."));
  }

  return {
    ready: reasons.length === 0 && fingerprint !== null,
    fingerprint,
    fingerprintShort: fingerprint?.slice(0, 12).toUpperCase() ?? null,
    importKind: row.import_kind,
    batchState: row.state,
    processingStage: row.processing_stage,
    source: {
      fileCount,
      sha256: row.source_sha256,
      malwareStatus: row.malware_scan_status,
      duplicateApprovedSource: row.duplicate_source_exists,
    },
    plan: {
      snapshotDate,
      effectiveDate,
      duplicateSourceAcknowledged: row.duplicate_source_acknowledged === true,
      largeRosterShrinkAcknowledged: shrinkAck && shrinkRequired,
      migrationPending: meta.migrationPending,
    },
    review: {
      total: summary.counts.total,
      unchangedExisting: summary.counts.unchangedExisting,
      existingWithChanges: summary.counts.existingWithChanges,
      proposedNew: summary.counts.proposedNew,
      needsAttention: summary.counts.needsAttention,
      rejected: summary.counts.rejected,
      blockingErrors: summary.counts.blockingErrors,
    },
    shrink: {
      required: shrinkRequired,
      percentChange: summary.snapshot?.percentChange ?? null,
    },
    reasons,
  };
}

export async function acknowledgeLargeRosterShrink(
  actor: ImportReviewActor,
  batchId: string,
  expectedFingerprint: string,
  dependencies: {
    query?: DatabaseQuery;
    transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  } = {},
) {
  requireApprover(actor);
  requireBatchId(batchId);
  if (!HASH_RE.test(expectedFingerprint)) {
    throw new ImportExecutionPreflightError("INVALID_FINGERPRINT", "The execution fingerprint is invalid.", 400);
  }
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const preflight = await getImportExecutionPreflight(actor, batchId, query);
  if (preflight.plan.migrationPending) {
    throw new ImportExecutionPreflightError("MIGRATION_REQUIRED", "Migration 0010 must be applied before this acknowledgement can be saved.", 409);
  }
  if (!preflight.shrink.required || !preflight.fingerprint || preflight.fingerprint !== expectedFingerprint) {
    throw new ImportExecutionPreflightError("STALE_FINGERPRINT", "The roster shrink set changed; refresh the execution preflight before acknowledging it.", 409);
  }
  if (!preflight.plan.snapshotDate) {
    throw new ImportExecutionPreflightError("SNAPSHOT_DATE_REQUIRED", "Save the snapshot date before acknowledging a large roster shrink.", 409);
  }

  const mutation: DatabaseStatement = {
    sql: `
      WITH actor AS (
        SELECT app_user.id
        FROM local801.users app_user
        WHERE app_user.id = $3::uuid
          AND app_user.organization_id = $1::uuid
          AND app_user.deactivated_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM local801.workspace_user_roles user_role
            JOIN local801.workspace_roles role
              ON role.id = user_role.role_id
             AND role.organization_id = $1::uuid
            WHERE user_role.user_id = app_user.id
              AND role.code = $4::text
              AND role.code IN ('system_owner','local_admin','membership_data_manager')
          )
      ), updated AS (
        UPDATE local801.import_approval_plans plan
        SET large_roster_shrink_acknowledged = true,
          large_roster_shrink_set_hash = $5::text,
          large_roster_shrink_acknowledged_by = actor.id,
          large_roster_shrink_acknowledged_at = now(),
          updated_by = actor.id,
          updated_at = now()
        FROM actor, local801.import_batches batch
        WHERE plan.organization_id = $1::uuid
          AND plan.import_batch_id = $2::uuid
          AND plan.snapshot_date IS NOT NULL
          AND batch.id = plan.import_batch_id
          AND batch.organization_id = $1::uuid
          AND batch.import_kind = 'current_roster'
          AND batch.state NOT IN ('approved','rejected')
        RETURNING plan.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS shrink_ack_saved
      FROM updated
    `,
    parameters: [actor.organizationId, batchId, actor.userId, actor.role, expectedFingerprint],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: "import.approval_plan_update",
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_batch",
    subjectId: batchId,
    payload: { largeRosterShrinkAcknowledged: true, fingerprint: expectedFingerprint },
  }, query);
  await transaction([mutation, audit]);
  return { acknowledged: true };
}

export const __testing = {
  LARGE_SHRINK_THRESHOLD_PERCENT,
  canonical,
  isMissingPreflightMigration,
  supportedImportKind,
};
