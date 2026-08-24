import "server-only";

import { createHash } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { getProtectedImportReviewSummary } from "./pii-protected-import-review.ts";
import type { ImportReviewActor, ImportReviewSummary } from "./import-review.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const LARGE_SHRINK_THRESHOLD_PERCENT = -20;

export class ProtectedImportApplyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ProtectedImportApplyError";
    this.code = code;
    this.status = status;
  }
}

type LockedRow = {
  import_kind: string;
  batch_state: string;
  processing_stage: string | null;
  snapshot_date: string | Date | null;
  effective_date: string | Date | null;
  duplicate_source_acknowledged: boolean | null;
  large_roster_shrink_acknowledged: boolean | null;
  large_roster_shrink_set_hash: string | null;
  execution_state: string;
  source_fingerprint: string;
  review_fingerprint: string;
  mutation_fingerprint: string;
  mutation_count: number | string;
  write_mode: string;
  backfill_state: string;
  protected_read_enabled_at: string | Date | null;
  protected_write_enabled_at: string | Date | null;
  verified_at: string | Date | null;
};

type SourceRow = {
  id: string;
  sha256: string;
  malware_scan_status: string;
};

type MutationHashRow = {
  import_row_id: string;
  target_person_id: string;
  mutation_hash: string;
};

type RowFingerprint = { row_set_hash: string };
type ApprovalFact = { approval_exists: boolean; duplicate_source_exists: boolean };

type ApplyResultRow = {
  approved_batch_count: number | string;
  executed_set_count: number | string;
  inserted_approval_count: number | string;
  mutation_count: number | string;
  applied_people_count: number | string;
  person_pii_count: number | string;
  new_people_count: number | string;
  identifier_candidate_count: number | string;
  identifier_applied_count: number | string;
  inserted_identifier_count: number | string;
  inserted_identifier_pii_count: number | string;
  inserted_identifier_index_count: number | string;
  contact_candidate_count: number | string;
  contact_applied_count: number | string;
  inserted_contact_count: number | string;
  inserted_contact_pii_count: number | string;
  inserted_contact_index_count: number | string;
  snapshot_count: number | string;
  snapshot_row_count: number | string;
  reconciliation_ok: boolean;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function preflightCanonical(value: Record<string, unknown>) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function reviewFingerprint(summary: ImportReviewSummary) {
  return sha256(canonical({
    proposedNew: summary.hashes.proposedNew,
    existingChanges: summary.hashes.existingChanges,
    counts: summary.counts,
    decisions: {
      proposedNew: summary.decisions.proposedNew,
      existingChanges: summary.decisions.existingChanges,
    },
  }));
}

function sourceFingerprint(rows: readonly SourceRow[]) {
  return sha256(rows.map((row) => row.sha256).sort().join(":"));
}

function mutationFingerprint(source: string, review: string, rows: readonly MutationHashRow[]) {
  return sha256(canonical({
    sourceFingerprint: source,
    reviewFingerprint: review,
    mutationHashes: rows.map((row) => row.mutation_hash).sort(),
  }));
}

function dateOnly(value: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function integer(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function assertAtomicApplyReconciled(
  result: ApplyResultRow | undefined,
  expected: { mutationCount: number; newPeopleCount: number; importKind: string },
) {
  const currentRoster = expected.importKind === "current_roster";
  if (!result || result.reconciliation_ok !== true
    || integer(result.approved_batch_count) !== 1
    || integer(result.executed_set_count) !== 1
    || integer(result.inserted_approval_count) !== 1
    || integer(result.mutation_count) !== expected.mutationCount
    || integer(result.applied_people_count) !== expected.mutationCount
    || integer(result.person_pii_count) !== expected.mutationCount
    || integer(result.new_people_count) !== expected.newPeopleCount
    || integer(result.identifier_candidate_count) !== integer(result.identifier_applied_count)
    || integer(result.inserted_identifier_count) !== integer(result.inserted_identifier_pii_count)
    || integer(result.inserted_identifier_count) !== integer(result.inserted_identifier_index_count)
    || integer(result.contact_candidate_count) !== integer(result.contact_applied_count)
    || integer(result.inserted_contact_count) !== integer(result.inserted_contact_pii_count)
    || integer(result.inserted_contact_count) !== integer(result.inserted_contact_index_count)
    || integer(result.snapshot_count) !== (currentRoster ? 1 : 0)
    || integer(result.snapshot_row_count) !== (currentRoster ? expected.mutationCount : 0)) {
    throw new ProtectedImportApplyError(
      "ATOMIC_RECONCILIATION_FAILED",
      "The protected import was not committed because the applied roster did not exactly match the reviewed set. No roster changes were applied.",
      503,
    );
  }
}

function requireUuid(value: string, label: string) {
  if (!UUID_RE.test(value)) throw new ProtectedImportApplyError("INVALID_ID", `${label} is invalid.`, 400);
}

function requireHash(value: string, label: string) {
  if (!HASH_RE.test(value)) throw new ProtectedImportApplyError("INVALID_FINGERPRINT", `${label} is invalid.`, 400);
}

function enabled(env: NodeJS.ProcessEnv) {
  return env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"
    && env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"
    && env.LOCAL801_PII_BACKFILL_ENABLED !== "1"
    && env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"
    && env.LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1";
}

async function lockExecution(
  query: DatabaseQuery,
  actor: ImportReviewActor,
  batchId: string,
  executionSetId: string,
): Promise<LockedRow> {
  const [row] = await query<LockedRow>(`
    /* pii-protected-execution:lock */
    SELECT batch.import_kind, batch.state AS batch_state, batch.processing_stage,
      plan.snapshot_date, plan.effective_date, plan.duplicate_source_acknowledged,
      plan.large_roster_shrink_acknowledged, plan.large_roster_shrink_set_hash,
      execution.state AS execution_state, execution.source_fingerprint,
      execution.review_fingerprint, execution.mutation_fingerprint, execution.mutation_count,
      protection.write_mode, protection.backfill_state,
      protection.protected_read_enabled_at, protection.protected_write_enabled_at, protection.verified_at
    FROM local801.import_batches batch
    JOIN local801.protected_import_execution_sets execution
      ON execution.organization_id = batch.organization_id
     AND execution.import_batch_id = batch.id
     AND execution.id = $3::uuid
    JOIN local801.pii_protection_state protection
      ON protection.organization_id = batch.organization_id
    LEFT JOIN local801.import_approval_plans plan
      ON plan.organization_id = batch.organization_id AND plan.import_batch_id = batch.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
    FOR UPDATE OF batch, execution
  `, [actor.organizationId, batchId, executionSetId]);
  if (!row) throw new ProtectedImportApplyError("EXECUTION_SET_NOT_FOUND", "The prepared protected execution set is unavailable.", 404);
  return row;
}

async function lockSources(query: DatabaseQuery, actor: ImportReviewActor, batchId: string) {
  return query<SourceRow>(`
    /* pii-protected-execution:lock-sources */
    SELECT id::text, sha256, malware_scan_status
    FROM local801.import_files
    WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid
    ORDER BY sha256, id
    FOR SHARE
  `, [actor.organizationId, batchId]);
}

async function lockMutations(query: DatabaseQuery, actor: ImportReviewActor, executionSetId: string) {
  return query<MutationHashRow>(`
    /* pii-protected-execution:lock-mutations */
    SELECT import_row_id::text, target_person_id::text, mutation_hash
    FROM local801.protected_import_execution_mutations
    WHERE organization_id = $1::uuid AND execution_set_id = $2::uuid
    ORDER BY mutation_hash, import_row_id
    FOR SHARE
  `, [actor.organizationId, executionSetId]);
}

async function rowSetHash(query: DatabaseQuery, actor: ImportReviewActor, batchId: string) {
  const [row] = await query<RowFingerprint>(`
    SELECT encode(public.digest(COALESCE(string_agg(
      encode(public.digest(concat_ws(chr(31), file.sha256, sheet.sheet_name, import_row.source_row_number::text, import_row.row_hash), 'sha256'), 'hex'),
      ':' ORDER BY file.sha256, sheet.sheet_name, import_row.source_row_number, import_row.id
    ), ''), 'sha256'), 'hex') AS row_set_hash
    FROM local801.import_files file
    JOIN local801.import_sheets sheet
      ON sheet.organization_id = file.organization_id AND sheet.import_file_id = file.id
    JOIN local801.import_rows import_row
      ON import_row.organization_id = sheet.organization_id AND import_row.import_sheet_id = sheet.id
    WHERE file.organization_id = $1::uuid AND file.import_batch_id = $2::uuid
  `, [actor.organizationId, batchId]);
  if (!row || !HASH_RE.test(row.row_set_hash)) throw new ProtectedImportApplyError("SOURCE_FINGERPRINT_INVALID", "The reviewed import-row fingerprint is unavailable.");
  return row.row_set_hash;
}

async function approvalFacts(query: DatabaseQuery, actor: ImportReviewActor, batchId: string, sourceSha256: string) {
  const [row] = await query<ApprovalFact>(`
    SELECT EXISTS (
      SELECT 1 FROM local801.import_approvals approval
      WHERE approval.organization_id = $1::uuid AND approval.import_batch_id = $2::uuid
    ) AS approval_exists,
    EXISTS (
      SELECT 1
      FROM local801.import_files prior_file
      JOIN local801.import_batches prior_batch
        ON prior_batch.id = prior_file.import_batch_id AND prior_batch.organization_id = prior_file.organization_id
      WHERE prior_file.organization_id = $1::uuid
        AND prior_file.sha256 = $3::text
        AND prior_batch.state = 'approved'
        AND prior_batch.id <> $2::uuid
    ) AS duplicate_source_exists
  `, [actor.organizationId, batchId, sourceSha256]);
  return row ?? { approval_exists: false, duplicate_source_exists: false };
}

function preflightFingerprint(input: {
  batchId: string;
  importKind: string;
  sourceSha256: string;
  rowSetHash: string;
  summary: ImportReviewSummary;
  snapshotDate: string | null;
  effectiveDate: string | null;
}) {
  return sha256(preflightCanonical({
    batchId: input.batchId,
    importKind: input.importKind,
    sourceSha256: input.sourceSha256,
    rowSetHash: input.rowSetHash,
    proposedNewSetHash: input.summary.hashes.proposedNew,
    existingChangesSetHash: input.summary.hashes.existingChanges,
    counts: [
      input.summary.counts.total,
      input.summary.counts.unchangedExisting,
      input.summary.counts.existingWithChanges,
      input.summary.counts.proposedNew,
      input.summary.counts.needsAttention,
      input.summary.counts.rejected,
    ],
    snapshotDate: input.snapshotDate,
    effectiveDate: input.effectiveDate,
  }));
}

function assertReady(input: {
  locked: LockedRow;
  sources: readonly SourceRow[];
  mutations: readonly MutationHashRow[];
  summary: ImportReviewSummary;
  currentSourceFingerprint: string;
  currentReviewFingerprint: string;
  currentMutationFingerprint: string;
  expectedMutationFingerprint: string;
  currentPreflightFingerprint: string;
  approval: ApprovalFact;
}) {
  const { locked, sources, mutations, summary } = input;
  if (locked.write_mode !== "protected" || locked.backfill_state !== "complete"
    || !locked.protected_read_enabled_at || !locked.protected_write_enabled_at || !locked.verified_at) {
    throw new ProtectedImportApplyError("PROTECTED_STATE_REQUIRED", "The database has not completed protected-only PII cutover.");
  }
  if (locked.batch_state !== "under_review" || locked.processing_stage !== "ready_for_review") {
    throw new ProtectedImportApplyError("BATCH_NOT_REVIEWABLE", "The import batch is no longer ready for authoritative execution.");
  }
  if (locked.execution_state !== "prepared") throw new ProtectedImportApplyError("EXECUTION_SET_STALE", "The protected execution set is no longer prepared.");
  if (!HASH_RE.test(locked.mutation_fingerprint) || locked.mutation_fingerprint !== input.expectedMutationFingerprint) {
    throw new ProtectedImportApplyError("STALE_FINGERPRINT", "The protected mutation fingerprint changed after confirmation.");
  }
  if (locked.source_fingerprint !== input.currentSourceFingerprint
    || locked.review_fingerprint !== input.currentReviewFingerprint
    || locked.mutation_fingerprint !== input.currentMutationFingerprint) {
    throw new ProtectedImportApplyError("STALE_EXECUTION_SET", "The source, review, or protected mutation set changed after preparation.");
  }
  if (integer(locked.mutation_count) !== mutations.length
    || mutations.length !== summary.counts.unchangedExisting + summary.counts.existingWithChanges + summary.counts.proposedNew) {
    throw new ProtectedImportApplyError("MUTATION_COUNT_MISMATCH", "The prepared protected mutation set no longer reconciles to review.");
  }
  if (sources.length !== 1 || !HASH_RE.test(sources[0].sha256)) throw new ProtectedImportApplyError("SOURCE_FILE_REQUIRED", "Exactly one immutable source file is required.");
  if (sources[0].malware_scan_status !== "clean") throw new ProtectedImportApplyError("MALWARE_NOT_CLEAN", "The source file must still have a clean malware verdict.");
  if (!summary.counts.metadataComplete || summary.blockers > 0 || summary.counts.blockingErrors > 0
    || summary.decisions.migrationPending || !summary.decisions.proposedNew || !summary.decisions.existingChanges) {
    throw new ProtectedImportApplyError("REVIEW_BLOCKED", "The protected review is no longer complete and unblocked.");
  }
  if (!["current_roster", "new_hires", "recent_hires", "membership_additions", "membership_drops"].includes(locked.import_kind)) {
    throw new ProtectedImportApplyError("UNSUPPORTED_IMPORT_KIND", "This import kind cannot execute authoritative roster changes.");
  }
  const snapshotDate = dateOnly(locked.snapshot_date);
  const effectiveDate = dateOnly(locked.effective_date);
  if (locked.import_kind === "current_roster" && !snapshotDate) throw new ProtectedImportApplyError("SNAPSHOT_DATE_REQUIRED", "The authoritative roster snapshot date is missing.");
  if (locked.import_kind !== "current_roster" && !effectiveDate) throw new ProtectedImportApplyError("EFFECTIVE_DATE_REQUIRED", "The import effective date is missing.");
  if (input.approval.approval_exists) throw new ProtectedImportApplyError("ALREADY_APPROVED", "This import already has an authoritative approval.");
  if (input.approval.duplicate_source_exists && locked.duplicate_source_acknowledged !== true) {
    throw new ProtectedImportApplyError("DUPLICATE_SOURCE_ACK_REQUIRED", "The duplicate source acknowledgement is no longer valid.");
  }
  if (locked.import_kind === "current_roster" && summary.snapshot?.percentChange != null
    && summary.snapshot.percentChange <= LARGE_SHRINK_THRESHOLD_PERCENT
    && !(locked.large_roster_shrink_acknowledged === true && locked.large_roster_shrink_set_hash === input.currentPreflightFingerprint)) {
    throw new ProtectedImportApplyError("LARGE_ROSTER_SHRINK_ACK_REQUIRED", "The large roster shrink acknowledgement is stale or missing.");
  }
}

export const PROTECTED_IMPORT_APPLY_SQL = `
  WITH actor_gate AS MATERIALIZED (
    SELECT app_user.id
    FROM local801.users app_user
    WHERE app_user.organization_id = $1::uuid AND app_user.id = $4::uuid AND app_user.deactivated_at IS NULL
      AND EXISTS (
        SELECT 1 FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid
        WHERE user_role.user_id = app_user.id AND role.code = $5::text
          AND role.code IN ('system_owner','local_admin','membership_data_manager')
      )
  ), selected_batch AS MATERIALIZED (
    SELECT batch.id, batch.import_kind, plan.snapshot_date, plan.effective_date, source.id AS source_file_id
    FROM local801.import_batches batch
    JOIN local801.import_files source ON source.organization_id = batch.organization_id AND source.import_batch_id = batch.id
    LEFT JOIN local801.import_approval_plans plan ON plan.organization_id = batch.organization_id AND plan.import_batch_id = batch.id
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
      AND batch.state = 'under_review' AND batch.processing_stage = 'ready_for_review'
  ), execution_gate AS MATERIALIZED (
    SELECT execution.id
    FROM local801.protected_import_execution_sets execution
    JOIN local801.pii_protection_state protection ON protection.organization_id = execution.organization_id
    WHERE execution.organization_id = $1::uuid AND execution.import_batch_id = $2::uuid
      AND execution.id = $3::uuid AND execution.state = 'prepared'
      AND execution.mutation_fingerprint = $6::text
      AND protection.write_mode = 'protected' AND protection.backfill_state = 'complete'
      AND protection.protected_read_enabled_at IS NOT NULL
      AND protection.protected_write_enabled_at IS NOT NULL AND protection.verified_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM actor_gate)
      AND NOT EXISTS (
        SELECT 1 FROM local801.protected_import_execution_mutations mutation
        WHERE mutation.organization_id = $1::uuid AND mutation.execution_set_id = execution.id
          AND mutation.operational_json ?| ARRAY['first_name','last_name','preferred_name','work_email','personal_email','employee_identifier','member_identifier']
      )
      AND execution.mutation_count = (
        SELECT count(*) FROM local801.protected_import_execution_mutations mutation
        WHERE mutation.organization_id = $1::uuid AND mutation.execution_set_id = execution.id
      )
  ), mutations AS MATERIALIZED (
    SELECT mutation.*
    FROM local801.protected_import_execution_mutations mutation
    CROSS JOIN execution_gate gate
    WHERE mutation.organization_id = $1::uuid AND mutation.execution_set_id = gate.id
  ), inserted_people AS (
    INSERT INTO local801.people (
      id, organization_id, preferred_name, first_name, last_name, membership_status,
      department, section, classification, work_location, hire_date, job_status, local_number
    )
    SELECT mutation.target_person_id, $1::uuid, NULL,
      'Protected', 'Person ' || left(mutation.target_person_id::text, 8),
      CASE
        WHEN batch.import_kind = 'membership_additions' THEN 'member'
        WHEN batch.import_kind = 'membership_drops' THEN 'nonmember'
        WHEN batch.import_kind = 'current_roster' AND mutation.operational_json ->> 'membership_status' IN ('member','nonmember','unknown')
          THEN mutation.operational_json ->> 'membership_status'
        ELSE 'unknown'
      END,
      NULLIF(btrim(mutation.operational_json ->> 'department'), ''),
      NULLIF(btrim(mutation.operational_json ->> 'section'), ''),
      NULLIF(btrim(mutation.operational_json ->> 'classification'), ''),
      NULLIF(btrim(mutation.operational_json ->> 'work_location'), ''),
      NULLIF(btrim(mutation.operational_json ->> 'hire_date'), '')::date,
      NULLIF(btrim(mutation.operational_json ->> 'job_status'), ''),
      '0801'
    FROM mutations mutation CROSS JOIN selected_batch batch
    WHERE mutation.mutation_kind = 'new'
    RETURNING id, membership_status, department, work_location, classification
  ), updated_people AS (
    UPDATE local801.people person
    SET department = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'department'), ''), person.department),
      section = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'section'), ''), person.section),
      classification = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'classification'), ''), person.classification),
      work_location = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'work_location'), ''), person.work_location),
      hire_date = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'hire_date'), '')::date, person.hire_date),
      job_status = COALESCE(NULLIF(btrim(mutation.operational_json ->> 'job_status'), ''), person.job_status),
      membership_status = CASE
        WHEN batch.import_kind = 'membership_additions' THEN 'member'
        WHEN batch.import_kind = 'membership_drops' THEN 'nonmember'
        WHEN batch.import_kind = 'current_roster' AND mutation.operational_json ->> 'membership_status' IN ('member','nonmember','unknown')
          THEN mutation.operational_json ->> 'membership_status'
        ELSE person.membership_status
      END,
      updated_at = now()
    FROM mutations mutation CROSS JOIN selected_batch batch
    WHERE mutation.mutation_kind = 'existing' AND person.organization_id = $1::uuid
      AND person.id = mutation.target_person_id AND person.archived_at IS NULL
    RETURNING person.id, person.membership_status, person.department, person.work_location, person.classification
  ), applied_people AS MATERIALIZED (
    SELECT id, membership_status, department, work_location, classification FROM inserted_people
    UNION ALL
    SELECT id, membership_status, department, work_location, classification FROM updated_people
  ), person_barrier AS (
    SELECT count(*) AS touched FROM applied_people
  ), upsert_person_pii AS (
    INSERT INTO local801.person_pii (
      organization_id, person_id,
      first_name_encrypted_payload, first_name_encryption_key_version, first_name_encryption_format_version,
      last_name_encrypted_payload, last_name_encryption_key_version, last_name_encryption_format_version,
      preferred_name_encrypted_payload, preferred_name_encryption_key_version, preferred_name_encryption_format_version,
      name_sort_encrypted_payload, name_sort_encryption_key_version, name_sort_encryption_format_version, updated_at
    )
    SELECT $1::uuid, mutation.target_person_id,
      mutation.person_protected_json ->> 'firstNameEncryptedPayload', mutation.person_protected_json ->> 'firstNameEncryptionKeyVersion', (mutation.person_protected_json ->> 'firstNameEncryptionFormatVersion')::integer,
      mutation.person_protected_json ->> 'lastNameEncryptedPayload', mutation.person_protected_json ->> 'lastNameEncryptionKeyVersion', (mutation.person_protected_json ->> 'lastNameEncryptionFormatVersion')::integer,
      mutation.person_protected_json ->> 'preferredNameEncryptedPayload', mutation.person_protected_json ->> 'preferredNameEncryptionKeyVersion', NULLIF(mutation.person_protected_json ->> 'preferredNameEncryptionFormatVersion','')::integer,
      mutation.person_protected_json ->> 'nameSortEncryptedPayload', mutation.person_protected_json ->> 'nameSortEncryptionKeyVersion', (mutation.person_protected_json ->> 'nameSortEncryptionFormatVersion')::integer, now()
    FROM mutations mutation CROSS JOIN person_barrier
    ON CONFLICT (organization_id, person_id) DO UPDATE SET
      first_name_encrypted_payload = excluded.first_name_encrypted_payload,
      first_name_encryption_key_version = excluded.first_name_encryption_key_version,
      first_name_encryption_format_version = excluded.first_name_encryption_format_version,
      last_name_encrypted_payload = excluded.last_name_encrypted_payload,
      last_name_encryption_key_version = excluded.last_name_encryption_key_version,
      last_name_encryption_format_version = excluded.last_name_encryption_format_version,
      preferred_name_encrypted_payload = excluded.preferred_name_encrypted_payload,
      preferred_name_encryption_key_version = excluded.preferred_name_encryption_key_version,
      preferred_name_encryption_format_version = excluded.preferred_name_encryption_format_version,
      name_sort_encrypted_payload = excluded.name_sort_encrypted_payload,
      name_sort_encryption_key_version = excluded.name_sort_encryption_key_version,
      name_sort_encryption_format_version = excluded.name_sort_encryption_format_version,
      updated_at = now()
    RETURNING person_id
  ), staged_person_indexes AS MATERIALIZED (
    SELECT mutation.target_person_id,
      item ->> 'domain' AS domain, item ->> 'keyVersion' AS key_version, item ->> 'hash' AS hash
    FROM mutations mutation CROSS JOIN LATERAL jsonb_array_elements(mutation.exact_indexes_json) item
    WHERE item ->> 'entityType' = 'person' AND (item ->> 'entityId')::uuid = mutation.target_person_id
  ), deleted_person_indexes AS (
    DELETE FROM local801.pii_exact_indexes existing
    USING (SELECT DISTINCT target_person_id FROM mutations) target
    WHERE existing.organization_id = $1::uuid AND existing.entity_type = 'person'
      AND existing.entity_id = target.target_person_id
    RETURNING existing.id
  ), inserted_person_indexes AS (
    INSERT INTO local801.pii_exact_indexes (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
    SELECT $1::uuid, 'person', target_person_id, domain, key_version, hash
    FROM staged_person_indexes CROSS JOIN (SELECT count(*) FROM deleted_person_indexes) barrier
    ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version)
      DO UPDATE SET index_hash = excluded.index_hash
    RETURNING id
  ), deleted_search_tokens AS (
    DELETE FROM local801.person_search_tokens existing
    USING (SELECT DISTINCT target_person_id FROM mutations) target
    WHERE existing.organization_id = $1::uuid AND existing.person_id = target.target_person_id
    RETURNING existing.id
  ), inserted_search_tokens AS (
    INSERT INTO local801.person_search_tokens (
      organization_id, person_id, token_domain, token_kind, token_key_version, token_hash
    )
    SELECT $1::uuid, mutation.target_person_id,
      token ->> 'tokenDomain', token ->> 'tokenKind', token ->> 'keyVersion', token ->> 'hash'
    FROM mutations mutation CROSS JOIN LATERAL jsonb_array_elements(mutation.search_tokens_json) token
    CROSS JOIN (SELECT count(*) FROM deleted_search_tokens) barrier
    ON CONFLICT DO NOTHING
    RETURNING id
  ), identifier_candidates AS MATERIALIZED (
    SELECT mutation.target_person_id, batch.source_file_id,
      (identifier_item.item ->> 'personIdentifierId')::uuid AS staged_id,
      identifier_item.item ->> 'identifierType' AS identifier_type,
      identifier_item.item ->> 'encryptedPayload' AS encrypted_payload,
      identifier_item.item ->> 'encryptionKeyVersion' AS encryption_key_version,
      (identifier_item.item ->> 'encryptionFormatVersion')::integer AS encryption_format_version,
      exact.item ->> 'domain' AS index_domain,
      exact.item ->> 'keyVersion' AS index_key_version,
      exact.item ->> 'hash' AS index_hash
    FROM mutations mutation CROSS JOIN selected_batch batch
    CROSS JOIN LATERAL jsonb_array_elements(mutation.identifier_protected_json) AS identifier_item(item)
    JOIN LATERAL (
      SELECT exact_item AS item
      FROM jsonb_array_elements(mutation.exact_indexes_json) exact_item
      WHERE exact_item ->> 'entityType' = 'person_identifier'
        AND exact_item ->> 'entityId' = identifier_item.item ->> 'personIdentifierId'
      LIMIT 1
    ) exact ON true
  ), resolved_identifiers AS MATERIALIZED (
    SELECT candidate.*, existing_index.entity_id AS existing_id, existing_identifier.person_id AS existing_person_id
    FROM identifier_candidates candidate
    LEFT JOIN local801.pii_exact_indexes existing_index
      ON existing_index.organization_id = $1::uuid
      AND existing_index.entity_type = 'person_identifier'
      AND existing_index.index_domain = candidate.index_domain
      AND existing_index.index_key_version = candidate.index_key_version
      AND existing_index.index_hash = candidate.index_hash
    LEFT JOIN local801.person_identifiers existing_identifier
      ON existing_identifier.organization_id = $1::uuid AND existing_identifier.id = existing_index.entity_id
  ), identifier_conflict_guard AS MATERIALIZED (
    SELECT NOT EXISTS (
      SELECT 1 FROM resolved_identifiers
      WHERE existing_id IS NOT NULL AND existing_person_id IS DISTINCT FROM target_person_id
    ) AS ok
  ), inserted_identifiers AS (
    INSERT INTO local801.person_identifiers (
      id, organization_id, person_id, identifier_type, identifier_value, source_import_file_id
    )
    SELECT candidate.staged_id, $1::uuid, candidate.target_person_id, candidate.identifier_type,
      'protected:' || candidate.staged_id::text, candidate.source_file_id
    FROM resolved_identifiers candidate CROSS JOIN identifier_conflict_guard guard
    WHERE guard.ok AND candidate.existing_id IS NULL
    RETURNING id
  ), inserted_identifier_pii AS (
    INSERT INTO local801.person_identifier_pii (
      organization_id, person_identifier_id, identifier_value_encrypted_payload,
      encryption_key_version, encryption_format_version, updated_at
    )
    SELECT $1::uuid, candidate.staged_id, candidate.encrypted_payload,
      candidate.encryption_key_version, candidate.encryption_format_version, now()
    FROM resolved_identifiers candidate
    JOIN inserted_identifiers inserted ON inserted.id = candidate.staged_id
    ON CONFLICT (organization_id, person_identifier_id) DO UPDATE SET
      identifier_value_encrypted_payload = excluded.identifier_value_encrypted_payload,
      encryption_key_version = excluded.encryption_key_version,
      encryption_format_version = excluded.encryption_format_version,
      updated_at = now()
    RETURNING person_identifier_id
  ), inserted_identifier_indexes AS (
    INSERT INTO local801.pii_exact_indexes (
      organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash
    )
    SELECT $1::uuid, 'person_identifier', candidate.staged_id,
      candidate.index_domain, candidate.index_key_version, candidate.index_hash
    FROM resolved_identifiers candidate
    JOIN inserted_identifiers inserted ON inserted.id = candidate.staged_id
    ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version)
      DO UPDATE SET index_hash = excluded.index_hash
    RETURNING id
  ), contact_candidates AS MATERIALIZED (
    SELECT mutation.target_person_id, batch.source_file_id,
      (contact_item.item ->> 'contactMethodId')::uuid AS staged_id,
      contact_item.item ->> 'contactType' AS contact_type,
      NULLIF(contact_item.item ->> 'contactLabel', '') AS contact_label,
      contact_item.item ->> 'encryptedPayload' AS encrypted_payload,
      contact_item.item ->> 'encryptionKeyVersion' AS encryption_key_version,
      (contact_item.item ->> 'encryptionFormatVersion')::integer AS encryption_format_version,
      COALESCE((contact_item.item ->> 'isPrimary')::boolean, true) AS is_primary,
      COALESCE(NULLIF(contact_item.item ->> 'visibility',''), 'authorized_directory') AS visibility,
      exact.item ->> 'domain' AS index_domain,
      exact.item ->> 'keyVersion' AS index_key_version,
      exact.item ->> 'hash' AS index_hash
    FROM mutations mutation CROSS JOIN selected_batch batch
    CROSS JOIN LATERAL jsonb_array_elements(mutation.contact_protected_json) AS contact_item(item)
    JOIN LATERAL (
      SELECT exact_item AS item
      FROM jsonb_array_elements(mutation.exact_indexes_json) exact_item
      WHERE exact_item ->> 'entityType' = 'person_contact_method'
        AND exact_item ->> 'entityId' = contact_item.item ->> 'contactMethodId'
      LIMIT 1
    ) exact ON true
    WHERE contact_item.item ->> 'contactType' IN ('work_email', 'personal_email', 'phone')
  ), resolved_contacts AS MATERIALIZED (
    SELECT candidate.*, existing.id AS existing_id
    FROM contact_candidates candidate
    LEFT JOIN LATERAL (
      SELECT contact.id
      FROM local801.person_contact_methods contact
      JOIN local801.pii_exact_indexes existing_index
        ON existing_index.organization_id = contact.organization_id
        AND existing_index.entity_type = 'person_contact_method'
        AND existing_index.entity_id = contact.id
        AND existing_index.index_domain = candidate.index_domain
        AND existing_index.index_key_version = candidate.index_key_version
        AND existing_index.index_hash = candidate.index_hash
      WHERE contact.organization_id = $1::uuid AND contact.person_id = candidate.target_person_id
        AND contact.contact_type = candidate.contact_type
        AND contact.contact_label IS NOT DISTINCT FROM candidate.contact_label
        AND contact.archived_at IS NULL
      ORDER BY contact.is_primary DESC, contact.created_at, contact.id
      LIMIT 1
    ) existing ON true
  ), archived_primary_contacts AS (
    UPDATE local801.person_contact_methods contact
    SET archived_at = now()
    FROM resolved_contacts candidate
    WHERE contact.organization_id = $1::uuid AND contact.person_id = candidate.target_person_id
      AND contact.contact_type = candidate.contact_type
      AND contact.contact_label IS NOT DISTINCT FROM candidate.contact_label
      AND candidate.is_primary = true
      AND contact.is_primary = true AND contact.archived_at IS NULL
      AND contact.id IS DISTINCT FROM candidate.existing_id
    RETURNING contact.id
  ), promoted_existing_contacts AS (
    UPDATE local801.person_contact_methods contact
    SET is_primary = true, verified_at = COALESCE(contact.verified_at, now())
    FROM resolved_contacts candidate
    CROSS JOIN (SELECT count(*) FROM archived_primary_contacts) archive_barrier
    WHERE candidate.existing_id IS NOT NULL AND contact.organization_id = $1::uuid AND contact.id = candidate.existing_id
    RETURNING contact.id
  ), inserted_contacts AS (
    INSERT INTO local801.person_contact_methods (
      id, organization_id, person_id, contact_type, contact_value, is_primary,
      visibility, verified_at, source_import_file_id, contact_label
    )
    SELECT candidate.staged_id, $1::uuid, candidate.target_person_id, candidate.contact_type,
      CASE WHEN candidate.contact_type IN ('work_email','personal_email')
        THEN 'protected-' || candidate.staged_id::text || '@invalid.local'
        ELSE 'protected:' || candidate.staged_id::text END, candidate.is_primary,
      candidate.visibility, now(), candidate.source_file_id, candidate.contact_label
    FROM resolved_contacts candidate
    CROSS JOIN (SELECT count(*) FROM archived_primary_contacts) archive_barrier
    CROSS JOIN (SELECT count(*) FROM promoted_existing_contacts) promote_barrier
    WHERE candidate.existing_id IS NULL
    RETURNING id
  ), inserted_contact_pii AS (
    INSERT INTO local801.person_contact_method_pii (
      organization_id, contact_method_id, contact_value_encrypted_payload,
      encryption_key_version, encryption_format_version, updated_at
    )
    SELECT $1::uuid, candidate.staged_id, candidate.encrypted_payload,
      candidate.encryption_key_version, candidate.encryption_format_version, now()
    FROM resolved_contacts candidate JOIN inserted_contacts inserted ON inserted.id = candidate.staged_id
    ON CONFLICT (organization_id, contact_method_id) DO UPDATE SET
      contact_value_encrypted_payload = excluded.contact_value_encrypted_payload,
      encryption_key_version = excluded.encryption_key_version,
      encryption_format_version = excluded.encryption_format_version,
      updated_at = now()
    RETURNING contact_method_id
  ), upserted_contact_indexes AS (
    INSERT INTO local801.pii_exact_indexes (
      organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash
    )
    SELECT $1::uuid, 'person_contact_method', COALESCE(candidate.existing_id, candidate.staged_id),
      exact.item ->> 'domain', exact.item ->> 'keyVersion', exact.item ->> 'hash'
    FROM resolved_contacts candidate
    CROSS JOIN LATERAL (
      SELECT exact_item AS item
      FROM mutations mutation
      CROSS JOIN LATERAL jsonb_array_elements(mutation.exact_indexes_json) exact_item
      WHERE mutation.target_person_id = candidate.target_person_id
        AND exact_item ->> 'entityType' = 'person_contact_method'
        AND exact_item ->> 'entityId' = candidate.staged_id::text
    ) exact
    WHERE candidate.existing_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM inserted_contacts inserted WHERE inserted.id = candidate.staged_id
    )
    ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version)
      DO UPDATE SET index_hash = excluded.index_hash
    RETURNING entity_id
  ), membership_event_rows AS MATERIALIZED (
    SELECT mutation.target_person_id,
      CASE
        WHEN batch.import_kind = 'current_roster' THEN 'correction'
        WHEN batch.import_kind = 'membership_additions' THEN 'addition'
        WHEN batch.import_kind = 'membership_drops' THEN 'drop'
      END AS event_type,
      CASE WHEN batch.import_kind = 'current_roster' THEN batch.snapshot_date ELSE batch.effective_date END AS effective_date,
      person.membership_status AS post_status,
      mutation.operational_json ->> 'membership_status' AS imported_status,
      mutation.mutation_kind
    FROM mutations mutation CROSS JOIN selected_batch batch
    JOIN applied_people person ON person.id = mutation.target_person_id
  ), inserted_membership_events AS (
    INSERT INTO local801.membership_events (
      id, organization_id, person_id, event_type, effective_date, source_import_file_id, created_by
    )
    SELECT gen_random_uuid(), $1::uuid, event.target_person_id, event.event_type, event.effective_date,
      batch.source_file_id, actor.id
    FROM membership_event_rows event CROSS JOIN selected_batch batch CROSS JOIN actor_gate actor
    WHERE event.event_type IS NOT NULL
      AND (batch.import_kind IN ('membership_additions','membership_drops') OR event.mutation_kind = 'existing')
    RETURNING id
  ), inserted_employment_events AS (
    INSERT INTO local801.employment_events (
      id, organization_id, person_id, event_type, effective_date, department, work_location, source_import_file_id
    )
    SELECT gen_random_uuid(), $1::uuid, mutation.target_person_id, 'hire',
      COALESCE(NULLIF(btrim(mutation.operational_json ->> 'hire_date'), '')::date, batch.effective_date),
      NULLIF(btrim(mutation.operational_json ->> 'department'), ''),
      NULLIF(btrim(mutation.operational_json ->> 'work_location'), ''), batch.source_file_id
    FROM mutations mutation CROSS JOIN selected_batch batch
    WHERE batch.import_kind IN ('new_hires','recent_hires')
    RETURNING id
  ), superseded_same_date_snapshot AS (
    UPDATE local801.membership_snapshots snapshot
    SET status = 'superseded'
    FROM selected_batch batch
    WHERE batch.import_kind = 'current_roster'
      AND snapshot.organization_id = $1::uuid
      AND snapshot.status = 'approved'
      AND snapshot.snapshot_date = batch.snapshot_date
      AND snapshot.source_import_batch_id IS DISTINCT FROM batch.id
    RETURNING snapshot.id
  ), inserted_snapshot AS (
    INSERT INTO local801.membership_snapshots (
      id, organization_id, snapshot_date, status, approved_by, approved_at, source_import_batch_id
    )
    SELECT gen_random_uuid(), $1::uuid, batch.snapshot_date, 'approved', actor.id, now(), batch.id
    FROM selected_batch batch CROSS JOIN actor_gate actor
    CROSS JOIN (SELECT count(*) FROM superseded_same_date_snapshot) supersession_barrier
    WHERE batch.import_kind = 'current_roster'
    RETURNING id
  ), inserted_snapshot_rows AS (
    INSERT INTO local801.membership_snapshot_rows (
      id, organization_id, snapshot_id, person_id, membership_status,
      department, work_location, classification, row_hash
    )
    SELECT gen_random_uuid(), $1::uuid, snapshot.id, mutation.target_person_id,
      person.membership_status, person.department, person.work_location, person.classification,
      import_row.row_hash
    FROM mutations mutation CROSS JOIN inserted_snapshot snapshot
    JOIN applied_people person ON person.id = mutation.target_person_id
    JOIN local801.import_rows import_row ON import_row.organization_id = $1::uuid AND import_row.id = mutation.import_row_id
    RETURNING id
  ), write_counts AS MATERIALIZED (
    SELECT
      (SELECT count(*)::int FROM mutations) AS mutation_count,
      (SELECT count(*)::int FROM applied_people) AS applied_people_count,
      (SELECT count(*)::int FROM upsert_person_pii) AS person_pii_count,
      (SELECT count(*)::int FROM inserted_people) AS new_people_count,
      (SELECT count(*)::int FROM identifier_candidates) AS identifier_candidate_count,
      ((SELECT count(*)::int FROM resolved_identifiers WHERE existing_id IS NOT NULL)
        + (SELECT count(*)::int FROM inserted_identifiers)) AS identifier_applied_count,
      (SELECT count(*)::int FROM inserted_identifiers) AS inserted_identifier_count,
      (SELECT count(*)::int FROM inserted_identifier_pii) AS inserted_identifier_pii_count,
      (SELECT count(*)::int FROM inserted_identifier_indexes) AS inserted_identifier_index_count,
      (SELECT count(*)::int FROM contact_candidates) AS contact_candidate_count,
      ((SELECT count(*)::int FROM resolved_contacts WHERE existing_id IS NOT NULL)
        + (SELECT count(*)::int FROM inserted_contacts)) AS contact_applied_count,
      (SELECT count(*)::int FROM inserted_contacts) AS inserted_contact_count,
      (SELECT count(*)::int FROM inserted_contact_pii) AS inserted_contact_pii_count,
      (SELECT count(DISTINCT contact_index.entity_id)::int
        FROM upserted_contact_indexes contact_index
        JOIN inserted_contacts inserted_contact ON inserted_contact.id = contact_index.entity_id
      ) AS inserted_contact_index_count,
      (SELECT count(*)::int FROM inserted_snapshot) AS snapshot_count,
      (SELECT count(*)::int FROM inserted_snapshot_rows) AS snapshot_row_count
  ), write_guard AS MATERIALIZED (
    SELECT EXISTS (
      SELECT 1 FROM selected_batch batch CROSS JOIN write_counts counts
      WHERE counts.mutation_count = (SELECT mutation_count FROM local801.protected_import_execution_sets WHERE id = $3::uuid)
        AND counts.applied_people_count = counts.mutation_count
        AND counts.person_pii_count = counts.mutation_count
        AND counts.new_people_count = $7::integer
        AND counts.identifier_candidate_count = counts.identifier_applied_count
        AND counts.inserted_identifier_count = counts.inserted_identifier_pii_count
        AND counts.inserted_identifier_count = counts.inserted_identifier_index_count
        AND counts.contact_candidate_count = counts.contact_applied_count
        AND counts.inserted_contact_count = counts.inserted_contact_pii_count
        AND counts.inserted_contact_count = counts.inserted_contact_index_count
        AND (SELECT ok FROM identifier_conflict_guard)
        AND (batch.import_kind <> 'current_roster' OR (counts.snapshot_count = 1 AND counts.snapshot_row_count = counts.mutation_count))
        AND (batch.import_kind = 'current_roster' OR (counts.snapshot_count = 0 AND counts.snapshot_row_count = 0))
    ) AS ok
  ), inserted_approval AS (
    INSERT INTO local801.import_approvals (
      organization_id, import_batch_id, approved_by, approval_hash, approved_at
    )
    SELECT $1::uuid, batch.id, actor.id, $6::text, now()
    FROM selected_batch batch CROSS JOIN actor_gate actor CROSS JOIN write_guard guard
    WHERE guard.ok
    RETURNING id
  ), approved_batch AS (
    UPDATE local801.import_batches batch
    SET state = 'approved', approved_by = actor.id, approved_at = now()
    FROM actor_gate actor CROSS JOIN inserted_approval approval
    WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid AND batch.state = 'under_review'
    RETURNING batch.id
  ), executed_set AS (
    UPDATE local801.protected_import_execution_sets execution
    SET state = 'executed', executed_at = now(), updated_at = now()
    FROM approved_batch batch
    WHERE execution.organization_id = $1::uuid AND execution.id = $3::uuid AND execution.state = 'prepared'
      AND execution.mutation_fingerprint = $6::text
    RETURNING execution.id
  )
  SELECT
    (SELECT count(*)::int FROM approved_batch) AS approved_batch_count,
    (SELECT count(*)::int FROM executed_set) AS executed_set_count,
    (SELECT count(*)::int FROM inserted_approval) AS inserted_approval_count,
    counts.mutation_count, counts.applied_people_count, counts.person_pii_count,
    counts.new_people_count,
    counts.identifier_candidate_count, counts.identifier_applied_count,
    counts.inserted_identifier_count, counts.inserted_identifier_pii_count, counts.inserted_identifier_index_count,
    counts.contact_candidate_count, counts.contact_applied_count,
    counts.inserted_contact_count, counts.inserted_contact_pii_count, counts.inserted_contact_index_count,
    counts.snapshot_count, counts.snapshot_row_count,
    guard.ok AS reconciliation_ok
  FROM write_counts counts CROSS JOIN write_guard guard
`;

export async function applyPreparedProtectedImport(
  actor: ImportReviewActor,
  batchId: string,
  executionSetId: string,
  expectedMutationFingerprint: string,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    transaction?: typeof withLocal801Transaction;
  } = {},
) {
  if (!can(actor.role, "approveImports")) throw new ProtectedImportApplyError("FORBIDDEN", "Authoritative import execution is not authorized.", 403);
  requireUuid(batchId, "Import batch id");
  requireUuid(executionSetId, "Protected execution set id");
  requireHash(expectedMutationFingerprint, "Protected mutation fingerprint");
  const env = dependencies.env ?? process.env;
  if (!enabled(env)) throw new ProtectedImportApplyError("PROTECTED_EXECUTION_DISABLED", "Protected authoritative import execution is disabled.", 404);
  const transaction = dependencies.transaction ?? withLocal801Transaction;

  return transaction(async (query) => {
    const locked = await lockExecution(query, actor, batchId, executionSetId);
    const [sources, mutations, summary, rowHash] = await Promise.all([
      lockSources(query, actor, batchId),
      lockMutations(query, actor, executionSetId),
      getProtectedImportReviewSummary(actor, batchId, query),
      rowSetHash(query, actor, batchId),
    ]);
    const currentSourceFingerprint = sourceFingerprint(sources);
    const currentReviewFingerprint = reviewFingerprint(summary);
    const currentMutationFingerprint = mutationFingerprint(currentSourceFingerprint, currentReviewFingerprint, mutations);
    const snapshotDate = dateOnly(locked.snapshot_date);
    const effectiveDate = dateOnly(locked.effective_date);
    const sourceSha256 = sources.length === 1 ? sources[0].sha256 : "";
    const currentPreflightFingerprint = HASH_RE.test(sourceSha256) ? preflightFingerprint({
      batchId,
      importKind: locked.import_kind,
      sourceSha256,
      rowSetHash: rowHash,
      summary,
      snapshotDate,
      effectiveDate,
    }) : "";
    const approval = HASH_RE.test(sourceSha256)
      ? await approvalFacts(query, actor, batchId, sourceSha256)
      : { approval_exists: false, duplicate_source_exists: false };

    assertReady({
      locked, sources, mutations, summary,
      currentSourceFingerprint, currentReviewFingerprint, currentMutationFingerprint,
      expectedMutationFingerprint, currentPreflightFingerprint, approval,
    });

    const [result] = await query<ApplyResultRow>(PROTECTED_IMPORT_APPLY_SQL, [
      actor.organizationId,
      batchId,
      executionSetId,
      actor.userId,
      actor.role,
      expectedMutationFingerprint,
      summary.counts.proposedNew,
    ]);
    assertAtomicApplyReconciled(result, {
      mutationCount: mutations.length,
      newPeopleCount: summary.counts.proposedNew,
      importKind: locked.import_kind,
    });

    const audit = await prepareAtomicAuditStatement({
      eventType: "import.execute",
      actorId: actor.userId,
      organizationId: actor.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: {
        protectedExecution: true,
        mutationFingerprint: expectedMutationFingerprint,
        executionSetId,
        importKind: locked.import_kind,
        totalRows: summary.counts.total,
        existingChanges: summary.counts.existingWithChanges,
        proposedNew: summary.counts.proposedNew,
      },
    }, query);
    const [auditResult] = await query<{ audit_written: boolean }>(audit.sql, audit.parameters);
    if (!auditResult?.audit_written) throw new ProtectedImportApplyError("AUDIT_FAILED", "The protected import audit event could not be committed.", 503);

    return {
      executed: true as const,
      executionSetId,
      mutationFingerprint: expectedMutationFingerprint,
      importKind: locked.import_kind,
      counts: {
        total: summary.counts.total,
        existingChanges: summary.counts.existingWithChanges,
        proposedNew: summary.counts.proposedNew,
      },
    };
  });
}

export const __testing = {
  canonical,
  preflightCanonical,
  reviewFingerprint,
  sourceFingerprint,
  mutationFingerprint,
  preflightFingerprint,
  enabled,
  assertAtomicApplyReconciled,
};
