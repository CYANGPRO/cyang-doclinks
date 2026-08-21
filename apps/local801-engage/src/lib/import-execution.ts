import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import {
  ImportExecutionPreflightError,
  getImportExecutionPreflight,
} from "./import-execution-preflight.ts";
import {
  IMPORT_REVIEW_CLASSIFICATION_CTE,
  IMPORT_REVIEW_TOKEN_CTE,
  type ImportReviewActor,
} from "./import-review.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export type ImportExecutionDependencies = {
  query?: DatabaseQuery;
  transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
};

export class ImportExecutionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ImportExecutionError";
    this.code = code;
    this.status = status;
  }
}

function requireApprover(actor: ImportReviewActor) {
  if (!can(actor.role, "approveImports")) {
    throw new ImportExecutionError("FORBIDDEN", "Authoritative import execution is not authorized.", 403);
  }
}

function requireBatchId(value: string) {
  if (!UUID_RE.test(value)) throw new ImportExecutionError("IMPORT_NOT_FOUND", "Import batch not found.", 404);
}

function requireFingerprint(value: string) {
  if (!HASH_RE.test(value)) throw new ImportExecutionError("INVALID_FINGERPRINT", "The execution fingerprint is invalid.", 400);
}

export function authoritativeExecutionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.VERCEL_ENV !== "production"
    && env.LOCAL801_PREVIEW_AUTH_ENABLED === "1"
    && env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1";
}

export const IMPORT_EXECUTION_SQL = `
  WITH
  ${IMPORT_REVIEW_CLASSIFICATION_CTE},
  ${IMPORT_REVIEW_TOKEN_CTE},
  set_hashes AS (
    SELECT category, count(*)::int AS set_count,
      encode(digest(COALESCE(string_agg(canonical_token, ':' ORDER BY canonical_token), ''), 'sha256'), 'hex') AS set_hash
    FROM review_tokens
    WHERE category IN ('proposed_new', 'existing_with_changes')
    GROUP BY category
  ),
  aggregate AS (
    SELECT
      count(*)::int AS classified_total,
      count(*) FILTER (WHERE category = 'unchanged_existing')::int AS unchanged_existing,
      count(*) FILTER (WHERE category = 'existing_with_changes')::int AS existing_with_changes,
      count(*) FILTER (WHERE category = 'proposed_new')::int AS proposed_new,
      count(*) FILTER (WHERE category = 'needs_attention')::int AS needs_attention,
      count(*) FILTER (WHERE category = 'rejected')::int AS rejected,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'proposed_new'), encode(digest('', 'sha256'), 'hex')) AS proposed_new_set_hash,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'existing_with_changes'), encode(digest('', 'sha256'), 'hex')) AS existing_changes_set_hash
    FROM categorized
  ),
  row_fingerprint AS (
    SELECT encode(digest(COALESCE(string_agg(
      encode(digest(concat_ws(chr(31), file.sha256, sheet.sheet_name, row.source_row_number::text, row.row_hash), 'sha256'), 'hex'),
      ':' ORDER BY file.sha256, sheet.sheet_name, row.source_row_number, row.id
    ), ''), 'sha256'), 'hex') AS row_set_hash
    FROM local801.import_batches batch
    JOIN local801.import_files file
      ON file.organization_id = $1::uuid AND file.import_batch_id = batch.id
    JOIN local801.import_sheets sheet
      ON sheet.organization_id = $1::uuid AND sheet.import_file_id = file.id
    JOIN local801.import_rows row
      ON row.organization_id = $1::uuid AND row.import_sheet_id = sheet.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
  ),
  source_meta AS (
    SELECT count(file.id)::int AS file_count,
      CASE WHEN count(file.id) = 1 THEN min(file.id::text)::uuid END AS source_file_id,
      CASE WHEN count(file.id) = 1 THEN min(file.sha256) END AS source_sha256,
      CASE WHEN count(file.id) = 1 THEN min(file.malware_scan_status) END AS malware_scan_status
    FROM local801.import_batches batch
    LEFT JOIN local801.import_files file
      ON file.organization_id = $1::uuid AND file.import_batch_id = batch.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
  ),
  previous_snapshot AS (
    SELECT snapshot.id, snapshot.snapshot_date
    FROM local801.membership_snapshots snapshot
    WHERE snapshot.organization_id = $1::uuid AND snapshot.status = 'approved'
    ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC, snapshot.id DESC
    LIMIT 1
  ),
  previous_snapshot_count AS (
    SELECT count(snapshot_row.person_id)::int AS value
    FROM previous_snapshot snapshot
    JOIN local801.membership_snapshot_rows snapshot_row
      ON snapshot_row.organization_id = $1::uuid AND snapshot_row.snapshot_id = snapshot.id
  ),
  proposed_snapshot_count AS (
    SELECT count(*)::int AS value
    FROM categorized
    WHERE category IN ('unchanged_existing', 'existing_with_changes', 'proposed_new')
  ),
  actor_gate AS (
    SELECT app_user.id
    FROM local801.users app_user
    WHERE app_user.id = $3::uuid
      AND app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id AND role.organization_id = $1::uuid
        WHERE user_role.user_id = app_user.id
          AND role.code = $4::text
          AND role.code IN ('system_owner','local_admin','membership_data_manager')
      )
  ),
  selected_batch AS (
    SELECT batch.id, batch.import_kind, batch.state, batch.processing_stage,
      batch.total_row_count, batch.included_row_count, batch.excluded_row_count,
      plan.snapshot_date, plan.effective_date,
      plan.duplicate_source_acknowledged,
      plan.large_roster_shrink_acknowledged,
      plan.large_roster_shrink_set_hash,
      source.file_count, source.source_file_id, source.source_sha256, source.malware_scan_status,
      fingerprint.row_set_hash,
      aggregate.classified_total, aggregate.unchanged_existing, aggregate.existing_with_changes,
      aggregate.proposed_new, aggregate.needs_attention, aggregate.rejected,
      aggregate.proposed_new_set_hash, aggregate.existing_changes_set_hash,
      errors.blocking_error_count, errors.unassociated_blocking_error_count,
      COALESCE(previous.value, 0)::int AS previous_snapshot_count,
      proposed.value::int AS proposed_snapshot_count,
      organization.slug AS organization_slug,
      EXISTS (
        SELECT 1
        FROM local801.import_files prior_file
        JOIN local801.import_batches prior_batch
          ON prior_batch.id = prior_file.import_batch_id
         AND prior_batch.organization_id = prior_file.organization_id
        WHERE prior_file.organization_id = $1::uuid
          AND prior_file.sha256 = source.source_sha256
          AND prior_batch.state = 'approved'
          AND prior_batch.id <> batch.id
      ) AS duplicate_source_exists,
      EXISTS (
        SELECT 1 FROM local801.import_approvals approval
        WHERE approval.organization_id = $1::uuid AND approval.import_batch_id = batch.id
      ) AS approval_exists
    FROM local801.import_batches batch
    JOIN local801.organizations organization
      ON organization.id = batch.organization_id AND organization.archived_at IS NULL
    CROSS JOIN source_meta source
    CROSS JOIN row_fingerprint fingerprint
    CROSS JOIN aggregate
    CROSS JOIN batch_error_counts errors
    CROSS JOIN previous_snapshot_count previous
    CROSS JOIN proposed_snapshot_count proposed
    LEFT JOIN local801.import_approval_plans plan
      ON plan.organization_id = $1::uuid AND plan.import_batch_id = batch.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
  ),
  normalized_counts AS (
    SELECT selected.*,
      CASE WHEN COALESCE(selected.included_row_count, 0) <> 0
        THEN selected.included_row_count ELSE selected.classified_total END::int AS fingerprint_included,
      CASE WHEN COALESCE(selected.total_row_count, 0) <> 0
        THEN selected.total_row_count
        ELSE (CASE WHEN COALESCE(selected.included_row_count, 0) <> 0
          THEN selected.included_row_count ELSE selected.classified_total END) + COALESCE(selected.excluded_row_count, 0)
      END::int AS fingerprint_total
    FROM selected_batch selected
  ),
  fingerprint_value AS (
    SELECT normalized.*,
      encode(digest(
        '{"batchId":' || to_json(normalized.id::text)::text
        || ',"counts":[' || normalized.fingerprint_total::text
          || ',' || normalized.unchanged_existing::text
          || ',' || normalized.existing_with_changes::text
          || ',' || normalized.proposed_new::text
          || ',' || normalized.needs_attention::text
          || ',' || normalized.rejected::text || ']'
        || ',"effectiveDate":' || COALESCE(to_json(normalized.effective_date::text)::text, 'null')
        || ',"existingChangesSetHash":' || to_json(normalized.existing_changes_set_hash)::text
        || ',"importKind":' || to_json(normalized.import_kind)::text
        || ',"proposedNewSetHash":' || to_json(normalized.proposed_new_set_hash)::text
        || ',"rowSetHash":' || to_json(normalized.row_set_hash)::text
        || ',"snapshotDate":' || COALESCE(to_json(normalized.snapshot_date::text)::text, 'null')
        || ',"sourceSha256":' || to_json(normalized.source_sha256)::text || '}',
        'sha256'
      ), 'hex') AS current_fingerprint
    FROM normalized_counts normalized
  ),
  synthetic_gate AS (
    SELECT count(*)::int AS total_rows,
      count(*) FILTER (
        WHERE NULLIF(btrim(normalized_json ->> 'work_email'), '') IS NOT NULL
          AND lower(btrim(normalized_json ->> 'work_email')) LIKE '%@example.test'
      )::int AS synthetic_rows
    FROM categorized
  ),
  gate_facts AS (
    SELECT fingerprint.*,
      synthetic.total_rows AS synthetic_total_rows,
      synthetic.synthetic_rows,
      (
        fingerprint.proposed_new = 0 OR EXISTS (
          SELECT 1 FROM local801.import_batch_review_decisions decision
          WHERE decision.organization_id = $1::uuid
            AND decision.import_batch_id = fingerprint.id
            AND decision.decision_type = 'allow_proposed_new'
            AND decision.set_hash = fingerprint.proposed_new_set_hash
            AND decision.set_count = fingerprint.proposed_new
        )
      ) AS proposed_new_decision_valid,
      (
        fingerprint.existing_with_changes = 0 OR EXISTS (
          SELECT 1 FROM local801.import_batch_review_decisions decision
          WHERE decision.organization_id = $1::uuid
            AND decision.import_batch_id = fingerprint.id
            AND decision.decision_type = 'acknowledge_existing_changes'
            AND decision.set_hash = fingerprint.existing_changes_set_hash
            AND decision.set_count = fingerprint.existing_with_changes
        )
      ) AS existing_changes_decision_valid
    FROM fingerprint_value fingerprint
    CROSS JOIN synthetic_gate synthetic
  ),
  guard AS (
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM gate_facts gate
      WHERE gate.organization_slug = 'local801-preview'
        AND gate.state = 'under_review'
        AND gate.processing_stage = 'ready_for_review'
        AND gate.import_kind IN ('current_roster','new_hires','membership_additions','membership_drops')
        AND gate.file_count = 1
        AND gate.source_file_id IS NOT NULL
        AND gate.source_sha256 IS NOT NULL
        AND gate.malware_scan_status = 'clean'
        AND gate.blocking_error_count = 0
        AND gate.unassociated_blocking_error_count = 0
        AND gate.needs_attention = 0
        AND gate.rejected = 0
        AND gate.proposed_new_decision_valid
        AND gate.existing_changes_decision_valid
        AND (gate.import_kind <> 'current_roster' OR gate.snapshot_date IS NOT NULL)
        AND (gate.import_kind = 'current_roster' OR gate.effective_date IS NOT NULL)
        AND (NOT gate.duplicate_source_exists OR gate.duplicate_source_acknowledged = true)
        AND (
          gate.import_kind <> 'current_roster'
          OR gate.previous_snapshot_count = 0
          OR ((gate.proposed_snapshot_count - gate.previous_snapshot_count) * 100.0 / gate.previous_snapshot_count) > -20
          OR (
            gate.large_roster_shrink_acknowledged = true
            AND gate.large_roster_shrink_set_hash = gate.current_fingerprint
          )
        )
        AND gate.synthetic_total_rows > 0
        AND gate.synthetic_rows = gate.synthetic_total_rows
        AND NOT gate.approval_exists
        AND gate.current_fingerprint = $5::text
        AND EXISTS (SELECT 1 FROM actor_gate)
    ) THEN 1 ELSE 1 / 0 END AS ok
  ),
  new_people_map AS MATERIALIZED (
    SELECT categorized.import_row_id, gen_random_uuid() AS person_id
    FROM categorized CROSS JOIN guard
    WHERE categorized.category = 'proposed_new' AND guard.ok = 1
  ),
  target_rows AS MATERIALIZED (
    SELECT categorized.*,
      COALESCE(categorized.person_id, new_person.person_id) AS target_person_id
    FROM categorized
    LEFT JOIN new_people_map new_person ON new_person.import_row_id = categorized.import_row_id
    CROSS JOIN guard
    WHERE categorized.category IN ('unchanged_existing','existing_with_changes','proposed_new')
      AND guard.ok = 1
  ),
  inserted_people AS (
    INSERT INTO local801.people (
      id, organization_id, preferred_name, first_name, last_name, membership_status,
      department, section, classification, work_location, hire_date, job_status, local_number
    )
    SELECT target.target_person_id, $1::uuid,
      NULLIF(btrim(target.normalized_json ->> 'preferred_name'), ''),
      btrim(target.normalized_json ->> 'first_name'),
      btrim(target.normalized_json ->> 'last_name'),
      CASE
        WHEN batch.import_kind = 'membership_additions' THEN 'member'
        WHEN batch.import_kind = 'membership_drops' THEN 'nonmember'
        WHEN batch.import_kind = 'current_roster'
          AND btrim(target.normalized_json ->> 'membership_status') IN ('member','nonmember','unknown')
          THEN btrim(target.normalized_json ->> 'membership_status')
        ELSE 'unknown'
      END,
      NULLIF(btrim(target.normalized_json ->> 'department'), ''),
      NULLIF(btrim(target.normalized_json ->> 'section'), ''),
      NULLIF(btrim(target.normalized_json ->> 'classification'), ''),
      NULLIF(btrim(target.normalized_json ->> 'work_location'), ''),
      NULLIF(btrim(target.normalized_json ->> 'hire_date'), '')::date,
      NULLIF(btrim(target.normalized_json ->> 'job_status'), ''),
      '0801'
    FROM target_rows target
    CROSS JOIN gate_facts batch
    WHERE target.category = 'proposed_new'
    RETURNING id
  ),
  updated_people AS (
    UPDATE local801.people person
    SET
      first_name = COALESCE(NULLIF(btrim(target.normalized_json ->> 'first_name'), ''), person.first_name),
      last_name = COALESCE(NULLIF(btrim(target.normalized_json ->> 'last_name'), ''), person.last_name),
      preferred_name = COALESCE(NULLIF(btrim(target.normalized_json ->> 'preferred_name'), ''), person.preferred_name),
      department = COALESCE(NULLIF(btrim(target.normalized_json ->> 'department'), ''), person.department),
      section = COALESCE(NULLIF(btrim(target.normalized_json ->> 'section'), ''), person.section),
      classification = COALESCE(NULLIF(btrim(target.normalized_json ->> 'classification'), ''), person.classification),
      work_location = COALESCE(NULLIF(btrim(target.normalized_json ->> 'work_location'), ''), person.work_location),
      hire_date = COALESCE(NULLIF(btrim(target.normalized_json ->> 'hire_date'), '')::date, person.hire_date),
      job_status = COALESCE(NULLIF(btrim(target.normalized_json ->> 'job_status'), ''), person.job_status),
      membership_status = CASE
        WHEN batch.import_kind = 'membership_additions' THEN 'member'
        WHEN batch.import_kind = 'membership_drops' THEN 'nonmember'
        WHEN batch.import_kind = 'current_roster'
          AND btrim(target.normalized_json ->> 'membership_status') IN ('member','nonmember','unknown')
          THEN btrim(target.normalized_json ->> 'membership_status')
        ELSE person.membership_status
      END,
      updated_at = now()
    FROM target_rows target CROSS JOIN gate_facts batch
    WHERE person.organization_id = $1::uuid
      AND person.id = target.target_person_id
      AND target.category IN ('unchanged_existing','existing_with_changes')
      AND person.archived_at IS NULL
    RETURNING person.id
  ),
  contact_values AS MATERIALIZED (
    SELECT target.target_person_id, batch.source_file_id, value.contact_type, value.contact_label,
      CASE WHEN value.contact_type IN ('work_email','personal_email') THEN lower(value.contact_value) ELSE value.contact_value END AS contact_value
    FROM target_rows target CROSS JOIN gate_facts batch
    CROSS JOIN LATERAL (VALUES
      ('work_email'::text, 'work'::text, NULLIF(btrim(target.normalized_json ->> 'work_email'), '')),
      ('personal_email'::text, 'home'::text, NULLIF(btrim(target.normalized_json ->> 'home_email'), '')),
      ('phone'::text, 'work'::text, NULLIF(btrim(target.normalized_json ->> 'work_phone'), '')),
      ('phone'::text, 'cell'::text, NULLIF(btrim(target.normalized_json ->> 'cell_phone'), '')),
      ('phone'::text, 'home'::text, NULLIF(btrim(target.normalized_json ->> 'home_phone'), ''))
    ) value(contact_type, contact_label, contact_value)
    WHERE value.contact_value IS NOT NULL
  ),
  archived_primary_contacts AS (
    UPDATE local801.person_contact_methods contact
    SET archived_at = now()
    FROM contact_values value
    WHERE contact.organization_id = $1::uuid
      AND contact.person_id = value.target_person_id
      AND contact.contact_type = value.contact_type
      AND contact.contact_label IS NOT DISTINCT FROM value.contact_label
      AND contact.is_primary = true
      AND contact.archived_at IS NULL
      AND lower(btrim(contact.contact_value)) IS DISTINCT FROM lower(btrim(value.contact_value))
    RETURNING contact.id
  ),
  contact_barrier AS (
    SELECT count(*) AS archived_count FROM archived_primary_contacts
  ),
  inserted_contacts AS (
    INSERT INTO local801.person_contact_methods (
      id, organization_id, person_id, contact_type, contact_value,
      is_primary, visibility, verified_at, source_import_file_id, contact_label
    )
    SELECT gen_random_uuid(), $1::uuid, value.target_person_id, value.contact_type,
      value.contact_value, true, 'authorized_directory', now(), value.source_file_id, value.contact_label
    FROM contact_values value CROSS JOIN contact_barrier
    WHERE NOT EXISTS (
        SELECT 1
        FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1::uuid
          AND contact.person_id = value.target_person_id
          AND contact.contact_type = value.contact_type
          AND contact.contact_label IS NOT DISTINCT FROM value.contact_label
          AND contact.archived_at IS NULL
          AND lower(btrim(contact.contact_value)) = lower(btrim(value.contact_value))
      )
    RETURNING id
  ),
  inserted_identifiers AS (
    INSERT INTO local801.person_identifiers (
      id, organization_id, person_id, identifier_type, identifier_value, source_import_file_id
    )
    SELECT gen_random_uuid(), $1::uuid, target.target_person_id, identity.identifier_type, identity.identifier_value, batch.source_file_id
    FROM target_rows target
    CROSS JOIN gate_facts batch
    CROSS JOIN LATERAL (VALUES
      ('employee_identifier'::text, NULLIF(btrim(target.normalized_json ->> 'employee_identifier'), '')),
      ('member_identifier'::text, NULLIF(btrim(target.normalized_json ->> 'member_identifier'), ''))
    ) identity(identifier_type, identifier_value)
    WHERE identity.identifier_value IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM local801.person_identifiers existing
        WHERE existing.organization_id = $1::uuid
          AND existing.person_id = target.target_person_id
          AND existing.identifier_type = identity.identifier_type
          AND lower(btrim(existing.identifier_value)) = lower(btrim(identity.identifier_value))
      )
    ON CONFLICT DO NOTHING
    RETURNING id
  ),
  membership_event_rows AS MATERIALIZED (
    SELECT target.target_person_id,
      CASE
        WHEN batch.import_kind = 'current_roster' THEN 'correction'
        WHEN batch.import_kind = 'membership_additions' THEN 'addition'
        WHEN batch.import_kind = 'membership_drops' THEN 'drop'
      END AS event_type,
      CASE WHEN batch.import_kind = 'current_roster' THEN batch.snapshot_date ELSE batch.effective_date END AS effective_date
    FROM target_rows target CROSS JOIN gate_facts batch
    WHERE (
        batch.import_kind = 'current_roster'
        AND target.category <> 'proposed_new'
        AND btrim(target.normalized_json ->> 'membership_status') IN ('member','nonmember','unknown')
        AND btrim(target.normalized_json ->> 'membership_status') IS DISTINCT FROM target.existing_membership_status
      ) OR (
        batch.import_kind = 'membership_additions'
        AND (target.category = 'proposed_new' OR target.existing_membership_status IS DISTINCT FROM 'member')
      ) OR (
        batch.import_kind = 'membership_drops'
        AND (target.category = 'proposed_new' OR target.existing_membership_status IS DISTINCT FROM 'nonmember')
      )
  ),
  inserted_membership_events AS (
    INSERT INTO local801.membership_events (
      id, organization_id, person_id, event_type, effective_date, source_import_file_id, created_by
    )
    SELECT gen_random_uuid(), $1::uuid, event.target_person_id, event.event_type, event.effective_date,
      batch.source_file_id, actor.id
    FROM membership_event_rows event
    CROSS JOIN gate_facts batch
    CROSS JOIN actor_gate actor
    RETURNING id
  ),
  inserted_employment_events AS (
    INSERT INTO local801.employment_events (
      id, organization_id, person_id, event_type, effective_date,
      department, work_location, source_import_file_id
    )
    SELECT gen_random_uuid(), $1::uuid, target.target_person_id, 'hire',
      COALESCE(NULLIF(btrim(target.normalized_json ->> 'hire_date'), '')::date, batch.effective_date),
      NULLIF(btrim(target.normalized_json ->> 'department'), ''),
      NULLIF(btrim(target.normalized_json ->> 'work_location'), ''),
      batch.source_file_id
    FROM target_rows target CROSS JOIN gate_facts batch
    WHERE batch.import_kind = 'new_hires'
    RETURNING id
  ),
  inserted_snapshot AS (
    INSERT INTO local801.membership_snapshots (
      id, organization_id, snapshot_date, status, approved_by, approved_at, source_import_batch_id
    )
    SELECT gen_random_uuid(), $1::uuid, batch.snapshot_date, 'approved', actor.id, now(), batch.id
    FROM gate_facts batch CROSS JOIN actor_gate actor
    WHERE batch.import_kind = 'current_roster'
    RETURNING id
  ),
  inserted_snapshot_rows AS (
    INSERT INTO local801.membership_snapshot_rows (
      id, organization_id, snapshot_id, person_id, membership_status,
      department, work_location, classification, row_hash
    )
    SELECT gen_random_uuid(), $1::uuid, snapshot.id, target.target_person_id,
      CASE
        WHEN btrim(target.normalized_json ->> 'membership_status') IN ('member','nonmember','unknown')
          THEN btrim(target.normalized_json ->> 'membership_status')
        WHEN target.existing_membership_status IN ('member','nonmember','unknown') THEN target.existing_membership_status
        ELSE 'unknown'
      END,
      COALESCE(NULLIF(btrim(target.normalized_json ->> 'department'), ''), target.existing_department),
      COALESCE(NULLIF(btrim(target.normalized_json ->> 'work_location'), ''), target.existing_work_location),
      COALESCE(NULLIF(btrim(target.normalized_json ->> 'classification'), ''), target.existing_classification),
      target.row_hash
    FROM target_rows target CROSS JOIN inserted_snapshot snapshot
    RETURNING id
  ),
  write_counts AS (
    SELECT
      (SELECT count(*)::int FROM inserted_people) AS inserted_people,
      (SELECT count(*)::int FROM inserted_snapshot) AS inserted_snapshots,
      (SELECT count(*)::int FROM inserted_snapshot_rows) AS inserted_snapshot_rows
  ),
  write_guard AS (
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM gate_facts batch CROSS JOIN write_counts writes
      WHERE writes.inserted_people = batch.proposed_new
        AND (batch.import_kind <> 'current_roster' OR writes.inserted_snapshots = 1)
        AND (batch.import_kind <> 'current_roster' OR writes.inserted_snapshot_rows = batch.proposed_snapshot_count)
        AND (batch.import_kind = 'current_roster' OR writes.inserted_snapshots = 0)
        AND (batch.import_kind = 'current_roster' OR writes.inserted_snapshot_rows = 0)
    ) THEN 1 ELSE 1 / 0 END AS ok
  ),
  inserted_approval AS (
    INSERT INTO local801.import_approvals (
      organization_id, import_batch_id, approved_by, approval_hash, approved_at
    )
    SELECT $1::uuid, batch.id, actor.id, $5::text, now()
    FROM gate_facts batch CROSS JOIN actor_gate actor CROSS JOIN write_guard
    WHERE write_guard.ok = 1
    RETURNING id
  ),
  approved_batch AS (
    UPDATE local801.import_batches batch
    SET state = 'approved', approved_by = actor.id, approved_at = now()
    FROM actor_gate actor, inserted_approval approval
    WHERE batch.organization_id = $1::uuid
      AND batch.id = $2::uuid
      AND batch.state = 'under_review'
    RETURNING batch.id
  )
  SELECT CASE
    WHEN (SELECT count(*) FROM approved_batch) = 1
      AND (SELECT count(*) FROM inserted_approval) = 1
    THEN true
    ELSE 1 / 0 = 1
  END AS import_executed
`;

export async function executeAuthoritativeImport(
  actor: ImportReviewActor,
  batchId: string,
  expectedFingerprint: string,
  dependencies: ImportExecutionDependencies = {},
) {
  requireApprover(actor);
  requireBatchId(batchId);
  requireFingerprint(expectedFingerprint);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const prepareAudit = dependencies.prepareAudit ?? prepareAtomicAuditStatement;

  let preflight;
  try {
    preflight = await getImportExecutionPreflight(actor, batchId, query);
  } catch (error) {
    if (error instanceof ImportExecutionPreflightError) {
      throw new ImportExecutionError(error.code, error.message, error.status);
    }
    throw error;
  }
  if (!preflight.ready || !preflight.fingerprint) {
    throw new ImportExecutionError("PREFLIGHT_BLOCKED", "The current import execution preflight is not ready.", 409);
  }
  if (preflight.fingerprint !== expectedFingerprint) {
    throw new ImportExecutionError("STALE_FINGERPRINT", "The import changed after confirmation. Refresh the preflight and confirm the new fingerprint.", 409);
  }

  const execution: DatabaseStatement = {
    sql: IMPORT_EXECUTION_SQL,
    parameters: [actor.organizationId, batchId, actor.userId, actor.role, expectedFingerprint],
  };
  const audit = await prepareAudit({
    eventType: "import.execute",
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_batch",
    subjectId: batchId,
    payload: {
      fingerprint: expectedFingerprint,
      importKind: preflight.importKind,
      totalRows: preflight.review.total,
      existingChanges: preflight.review.existingWithChanges,
      proposedNew: preflight.review.proposedNew,
    },
  }, query);
  await transaction([execution, audit]);
  return {
    executed: true,
    fingerprint: expectedFingerprint,
    importKind: preflight.importKind,
    counts: {
      total: preflight.review.total,
      existingChanges: preflight.review.existingWithChanges,
      proposedNew: preflight.review.proposedNew,
    },
  };
}

export const __testing = {
  HASH_RE,
  UUID_RE,
  requireBatchId,
  requireFingerprint,
};
