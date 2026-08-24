import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { IMPORT_PROCESSING_VERSION } from "./import-processing.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const IMPORT_CANCEL_REASONS = ["operator_cancelled", "superseded_source", "incorrect_source", "maintenance"] as const;
type CancelReason = (typeof IMPORT_CANCEL_REASONS)[number];
type Dependencies = { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; prepareAudit?: typeof prepareAtomicAuditStatement };

export class ImportOperatorError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = "ImportOperatorError"; this.code = code; this.status = status; }
}

function authorize(context: WorkspaceContext) {
  if (!can(context.role, "manageImports")) throw new ImportOperatorError("FORBIDDEN", "Import operations are not authorized.", 403);
}
function batchId(value: unknown) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new ImportOperatorError("INVALID_BATCH", "The import batch is invalid.", 400);
  return value.toLowerCase();
}
function reason(value: unknown): CancelReason {
  if (!IMPORT_CANCEL_REASONS.includes(value as CancelReason)) throw new ImportOperatorError("INVALID_REASON", "Choose a valid cancellation reason.", 400);
  return value as CancelReason;
}

export async function getImportOperatorState(context: WorkspaceContext, batchIdInput: unknown, query: DatabaseQuery = queryLocal801) {
  authorize(context); const id = batchId(batchIdInput);
  const [row] = await query<{ state: string; cancellation_requested_at: string | Date | null; cancelled_at: string | Date | null; operator_reason_code: string | null; attempt_count: number }>(`
    SELECT job.state, job.cancellation_requested_at, job.cancelled_at, job.operator_reason_code, job.attempt_count
    FROM local801.import_processing_jobs job JOIN local801.import_batches batch ON batch.organization_id = job.organization_id AND batch.id = job.import_batch_id
    WHERE job.organization_id = $1::uuid AND job.import_batch_id = $2::uuid AND job.processing_version = $3
  `, [context.organizationId, id, IMPORT_PROCESSING_VERSION]);
  return row ? { state: row.state, cancellationRequestedAt: row.cancellation_requested_at ? new Date(row.cancellation_requested_at).toISOString() : null, cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null, reason: row.operator_reason_code, attemptCount: Number(row.attempt_count) } : null;
}

export async function cancelImportProcessing(context: WorkspaceContext, input: { batchId: unknown; reason: unknown }, dependencies: Dependencies = {}) {
  authorize(context); const id = batchId(input.batchId); const reasonCode = reason(input.reason); const query = dependencies.query ?? queryLocal801;
  const [state] = await query<{ state: string }>(`SELECT state FROM local801.import_processing_jobs WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid AND processing_version = $3`, [context.organizationId, id, IMPORT_PROCESSING_VERSION]);
  if (!state) throw new ImportOperatorError("JOB_NOT_FOUND", "The import processing job is unavailable.", 404);
  if (state.state !== "queued" && state.state !== "running") throw new ImportOperatorError("JOB_NOT_ACTIVE", "Only a queued or running import can be cancelled.", 409);
  const mutation: DatabaseStatement = { sql: `
    /* import-operator:cancel */
    WITH actor AS (SELECT app_user.id FROM local801.users app_user WHERE app_user.organization_id = $1::uuid AND app_user.id = $4::uuid AND app_user.deactivated_at IS NULL AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = app_user.id AND role.code IN ('system_owner','local_admin','membership_data_manager'))),
    changed_job AS (
      UPDATE local801.import_processing_jobs job SET
        cancellation_requested_at = now(), cancelled_by = $4::uuid, operator_reason_code = $5,
        state = CASE WHEN job.state = 'queued' THEN 'cancelled' ELSE job.state END,
        cancelled_at = CASE WHEN job.state = 'queued' THEN now() ELSE NULL END,
        last_progress_at = now(), updated_at = now()
      FROM actor WHERE job.organization_id = $1::uuid AND job.import_batch_id = $2::uuid AND job.processing_version = $3
        AND job.state IN ('queued','running') AND job.cancellation_requested_at IS NULL
      RETURNING job.import_batch_id, job.organization_id, job.state
    ), changed_batch AS (
      UPDATE local801.import_batches batch SET processing_stage = 'cancelled', processing_error_code = NULL
      FROM changed_job WHERE batch.organization_id = changed_job.organization_id AND batch.id = changed_job.import_batch_id AND changed_job.state = 'cancelled'
      RETURNING batch.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM changed_job
  `, parameters: [context.organizationId, id, IMPORT_PROCESSING_VERSION, context.userId, reasonCode] };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({ eventType: "record.update", organizationId: context.organizationId, actorId: context.userId, subjectType: "import_processing_job", subjectId: id, payload: { operation: "cancel", reasonCode } }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { cancellationRequested: true, immediate: state.state === "queued" } as const;
}

export async function requeueImportProcessing(context: WorkspaceContext, batchIdInput: unknown, dependencies: Dependencies = {}) {
  authorize(context); const id = batchId(batchIdInput); const query = dependencies.query ?? queryLocal801;
  const mutation: DatabaseStatement = { sql: `
    /* import-operator:requeue */
    WITH actor AS (SELECT app_user.id FROM local801.users app_user WHERE app_user.organization_id = $1::uuid AND app_user.id = $4::uuid AND app_user.deactivated_at IS NULL AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = app_user.id AND role.code IN ('system_owner','local_admin','membership_data_manager'))),
    reset_job AS (
      UPDATE local801.import_processing_jobs job SET state = 'queued', workflow_run_id = NULL,
        started_at = NULL, completed_at = NULL, failed_at = NULL, safe_error_code = NULL,
        cancellation_requested_at = NULL, cancelled_at = NULL, cancelled_by = NULL, operator_reason_code = NULL,
        queued_at = now(), last_progress_at = now(), updated_at = now()
      FROM actor WHERE job.organization_id = $1::uuid AND job.import_batch_id = $2::uuid AND job.processing_version = $3
        AND job.state IN ('failed','cancelled') RETURNING job.import_batch_id, job.organization_id
    ), reset_batch AS (
      UPDATE local801.import_batches batch SET processing_stage = 'queued', processing_error_code = NULL
      FROM reset_job WHERE batch.organization_id = reset_job.organization_id AND batch.id = reset_job.import_batch_id RETURNING batch.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM reset_job CROSS JOIN reset_batch
  `, parameters: [context.organizationId, id, IMPORT_PROCESSING_VERSION, context.userId] };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({ eventType: "record.update", organizationId: context.organizationId, actorId: context.userId, subjectType: "import_processing_job", subjectId: id, payload: { operation: "requeue" } }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { requeued: true } as const;
}
