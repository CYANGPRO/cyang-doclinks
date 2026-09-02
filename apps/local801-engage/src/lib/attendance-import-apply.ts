import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import type { ImportReviewActor } from "./import-review.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export class AttendanceImportApplyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AttendanceImportApplyError";
    this.code = code;
    this.status = status;
  }
}

type AttendanceMeta = {
  import_kind: string;
  batch_state: string;
  processing_stage: string;
  execution_state: string;
  mutation_fingerprint: string;
  approval_fingerprint: string | null;
  mutation_count: number | string;
  description: string;
  meeting_date: string | Date;
  response_key: string;
  action_id: string | null;
  source_file_count: number | string;
  clean_source_count: number | string;
  prepared_mutation_count: number | string;
  distinct_person_count: number | string;
  invalid_target_count: number | string;
};

type ApplyResult = {
  action_id: string | null;
  action_count: number | string;
  response_count: number | string;
  approval_count: number | string;
  approved_batch_count: number | string;
  executed_set_count: number | string;
  plan_count: number | string;
};

function requireUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) throw new AttendanceImportApplyError("IMPORT_NOT_FOUND", `${label} is invalid.`, 404);
}

function requireHash(value: string, label: string) {
  if (!HASH_RE.test(value)) throw new AttendanceImportApplyError("STALE_FINGERPRINT", `${label} is invalid.`, 409);
}

function asCount(value: number | string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

async function loadAndLock(
  query: DatabaseQuery,
  actor: ImportReviewActor,
  batchId: string,
  executionSetId: string,
): Promise<AttendanceMeta> {
  const [row] = await query<AttendanceMeta>(`
    /* attendance-import:lock-and-verify */
    SELECT batch.import_kind, batch.state AS batch_state, batch.processing_stage,
      execution.state AS execution_state, execution.mutation_fingerprint,
      execution.approval_fingerprint, execution.mutation_count,
      plan.description, plan.meeting_date, plan.response_key, plan.action_id,
      (SELECT count(*)::int FROM local801.import_files source
        WHERE source.organization_id = batch.organization_id AND source.import_batch_id = batch.id) AS source_file_count,
      (SELECT count(*)::int FROM local801.import_files source
        WHERE source.organization_id = batch.organization_id AND source.import_batch_id = batch.id
          AND source.malware_scan_status = 'clean') AS clean_source_count,
      (SELECT count(*)::int FROM local801.protected_import_execution_mutations mutation
        WHERE mutation.organization_id = execution.organization_id AND mutation.execution_set_id = execution.id) AS prepared_mutation_count,
      (SELECT count(DISTINCT mutation.target_person_id)::int
        FROM local801.protected_import_execution_mutations mutation
        WHERE mutation.organization_id = execution.organization_id AND mutation.execution_set_id = execution.id) AS distinct_person_count,
      (SELECT count(*)::int
        FROM local801.protected_import_execution_mutations mutation
        LEFT JOIN local801.people person
          ON person.organization_id = mutation.organization_id AND person.id = mutation.target_person_id
        WHERE mutation.organization_id = execution.organization_id AND mutation.execution_set_id = execution.id
          AND (mutation.mutation_kind <> 'existing' OR person.id IS NULL OR person.archived_at IS NOT NULL)) AS invalid_target_count
    FROM local801.import_batches batch
    JOIN local801.protected_import_execution_sets execution
      ON execution.organization_id = batch.organization_id AND execution.import_batch_id = batch.id
    JOIN local801.import_attendance_plans plan
      ON plan.organization_id = batch.organization_id AND plan.import_batch_id = batch.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid AND execution.id = $3::uuid
    FOR UPDATE OF batch, execution, plan
  `, [actor.organizationId, batchId, executionSetId]);
  if (!row) throw new AttendanceImportApplyError("IMPORT_NOT_FOUND", "Attendance import not found.", 404);
  return row;
}

function assertReady(meta: AttendanceMeta, mutationFingerprint: string, approvalFingerprint: string) {
  const expected = asCount(meta.mutation_count);
  if (meta.import_kind !== "attendance_roster" || meta.batch_state !== "under_review"
    || meta.processing_stage !== "ready_for_review" || meta.execution_state !== "prepared") {
    throw new AttendanceImportApplyError("IMPORT_NOT_READY", "The attendance import is no longer ready to apply.", 409);
  }
  if (meta.mutation_fingerprint !== mutationFingerprint || meta.approval_fingerprint !== approvalFingerprint) {
    throw new AttendanceImportApplyError("STALE_FINGERPRINT", "The attendance import changed after confirmation. Refresh and confirm it again.", 409);
  }
  if (meta.action_id || expected < 1 || asCount(meta.source_file_count) !== 1 || asCount(meta.clean_source_count) !== 1
    || asCount(meta.prepared_mutation_count) !== expected || asCount(meta.distinct_person_count) !== expected
    || asCount(meta.invalid_target_count) !== 0) {
    throw new AttendanceImportApplyError(
      "ATTENDANCE_MATCHES_REQUIRED",
      "Attendance can be recorded only when every row matches one active employee already in the directory.",
      409,
    );
  }
}

export async function applyPreparedAttendanceImport(
  actor: ImportReviewActor,
  batchId: string,
  executionSetId: string,
  mutationFingerprint: string,
  approvalFingerprint: string,
  dependencies: { transaction?: typeof withLocal801Transaction } = {},
) {
  if (!can(actor.role, "approveImports")) {
    throw new AttendanceImportApplyError("FORBIDDEN", "Attendance import execution is not authorized.", 403);
  }
  requireUuid(batchId, "Import batch id");
  requireUuid(executionSetId, "Execution set id");
  requireHash(mutationFingerprint, "Mutation fingerprint");
  requireHash(approvalFingerprint, "Approval fingerprint");
  const transaction = dependencies.transaction ?? withLocal801Transaction;

  return transaction(async (query) => {
    const meta = await loadAndLock(query, actor, batchId, executionSetId);
    assertReady(meta, mutationFingerprint, approvalFingerprint);
    const expected = asCount(meta.mutation_count);
    const [result] = await query<ApplyResult>(`
      /* attendance-import:atomic-apply */
      WITH actor_gate AS (
        SELECT app_user.id
        FROM local801.users app_user
        WHERE app_user.organization_id = $1::uuid AND app_user.id = $4::uuid
          AND app_user.deactivated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM local801.workspace_user_roles user_role
            JOIN local801.workspace_roles role
              ON role.organization_id = $1::uuid AND role.id = user_role.role_id
            WHERE user_role.user_id = app_user.id AND role.code = $5::text
              AND role.code IN ('system_owner','local_admin','membership_data_manager')
          )
      ), selected AS (
        SELECT batch.id AS batch_id, plan.id AS plan_id, plan.description, plan.meeting_date, plan.response_key,
          plan.description || ' — ' || to_char(plan.meeting_date, 'Mon DD, YYYY') AS action_name
        FROM local801.import_batches batch
        JOIN local801.import_attendance_plans plan
          ON plan.organization_id = batch.organization_id AND plan.import_batch_id = batch.id
        JOIN local801.protected_import_execution_sets execution
          ON execution.organization_id = batch.organization_id AND execution.import_batch_id = batch.id
        WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
          AND batch.import_kind = 'attendance_roster' AND batch.state = 'under_review'
          AND batch.processing_stage = 'ready_for_review' AND plan.action_id IS NULL
          AND execution.id = $3::uuid AND execution.state = 'prepared'
          AND execution.mutation_fingerprint = $6::text
          AND execution.approval_fingerprint = $7::text
      ), inserted_action AS (
        INSERT INTO local801.employee_actions
          (organization_id, name, engagement_level, scope_type, created_by,
           enabled_response_statuses, custom_response_options)
        SELECT $1::uuid, selected.action_name, 1, 'organization', actor_gate.id,
          ARRAY[selected.response_key]::text[],
          jsonb_build_array(jsonb_build_object(
            'value', selected.response_key, 'label', 'Attended', 'enabled', true
          ))
        FROM selected CROSS JOIN actor_gate
        WHERE NOT EXISTS (
          SELECT 1 FROM local801.employee_actions existing
          WHERE existing.organization_id = $1::uuid AND existing.scope_type = 'organization'
            AND existing.archived_at IS NULL AND lower(existing.name) = lower(selected.action_name)
        )
        RETURNING id
      ), inserted_responses AS (
        INSERT INTO local801.employee_action_responses
          (organization_id, person_id, action_id, response_status, recorded_by, recorded_at)
        SELECT $1::uuid, mutation.target_person_id, action.id, selected.response_key, actor_gate.id,
          (selected.meeting_date::timestamp + interval '12 hours') AT TIME ZONE 'America/Chicago'
        FROM local801.protected_import_execution_mutations mutation
        CROSS JOIN inserted_action action CROSS JOIN selected CROSS JOIN actor_gate
        JOIN local801.people person
          ON person.organization_id = mutation.organization_id AND person.id = mutation.target_person_id
          AND person.archived_at IS NULL
        WHERE mutation.organization_id = $1::uuid AND mutation.execution_set_id = $3::uuid
          AND mutation.mutation_kind = 'existing'
        RETURNING id
      ), inserted_approval AS (
        INSERT INTO local801.import_approvals
          (organization_id, import_batch_id, approved_by, approval_hash, approved_at)
        SELECT $1::uuid, selected.batch_id, actor_gate.id, $7::text, now()
        FROM selected CROSS JOIN actor_gate CROSS JOIN inserted_action
        WHERE (SELECT count(*) FROM inserted_responses) = $8::integer
        RETURNING id
      ), approved_batch AS (
        UPDATE local801.import_batches batch
        SET state = 'approved', approved_by = actor_gate.id, approved_at = now()
        FROM selected CROSS JOIN actor_gate CROSS JOIN inserted_approval
        WHERE batch.organization_id = $1::uuid AND batch.id = selected.batch_id AND batch.state = 'under_review'
        RETURNING batch.id
      ), executed_set AS (
        UPDATE local801.protected_import_execution_sets execution
        SET state = 'executed', executed_at = now(), updated_at = now()
        FROM approved_batch
        WHERE execution.organization_id = $1::uuid AND execution.id = $3::uuid AND execution.state = 'prepared'
        RETURNING execution.id
      ), updated_plan AS (
        UPDATE local801.import_attendance_plans plan
        SET action_id = action.id, updated_at = now()
        FROM inserted_action action CROSS JOIN approved_batch CROSS JOIN executed_set
        WHERE plan.organization_id = $1::uuid AND plan.import_batch_id = $2::uuid AND plan.action_id IS NULL
        RETURNING plan.id
      )
      SELECT
        (SELECT id::text FROM inserted_action LIMIT 1) AS action_id,
        (SELECT count(*)::int FROM inserted_action) AS action_count,
        (SELECT count(*)::int FROM inserted_responses) AS response_count,
        (SELECT count(*)::int FROM inserted_approval) AS approval_count,
        (SELECT count(*)::int FROM approved_batch) AS approved_batch_count,
        (SELECT count(*)::int FROM executed_set) AS executed_set_count,
        (SELECT count(*)::int FROM updated_plan) AS plan_count
    `, [actor.organizationId, batchId, executionSetId, actor.userId, actor.role,
      mutationFingerprint, approvalFingerprint, expected]);

    if (!result?.action_id || asCount(result.action_count) !== 1 || asCount(result.response_count) !== expected
      || asCount(result.approval_count) !== 1 || asCount(result.approved_batch_count) !== 1
      || asCount(result.executed_set_count) !== 1 || asCount(result.plan_count) !== 1) {
      throw new AttendanceImportApplyError(
        "ATTENDANCE_ACTION_CONFLICT",
        "CAT could not create this dated attendance action. Confirm that the same description and meeting date were not already used.",
        409,
      );
    }

    const audit = await prepareAtomicAuditStatement({
      eventType: "import.execute",
      actorId: actor.userId,
      organizationId: actor.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: {
        protectedExecution: true,
        importKind: "attendance_roster",
        actionId: result.action_id,
        attendanceCount: expected,
        meetingDate: meta.meeting_date instanceof Date ? meta.meeting_date.toISOString().slice(0, 10) : String(meta.meeting_date).slice(0, 10),
      },
    }, query);
    const [auditResult] = await query<{ audit_written: boolean }>(audit.sql, audit.parameters);
    if (!auditResult?.audit_written) {
      throw new AttendanceImportApplyError("AUDIT_FAILED", "The attendance import audit record could not be saved.", 503);
    }

    return {
      executed: true as const,
      importKind: "attendance_roster" as const,
      actionId: result.action_id,
      counts: { attended: expected },
    };
  });
}

export const __testing = { assertReady };
