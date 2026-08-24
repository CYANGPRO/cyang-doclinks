import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement, type AuditEvent } from "./audit.ts";
import {
  queryLocal801,
  runLocal801Transaction,
  type DatabaseQuery,
  type DatabaseStatement,
} from "./db.ts";
import { ControlledImportApprovalError } from "./import-approval-errors.ts";
import type { ImportKind } from "./imports.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type ImportApprovalActor = Pick<WorkspaceContext, "organizationId" | "userId" | "role">;
export type ResolutionType = "confirm_existing" | "create_new";

export type ImportApprovalDependencies = {
  query?: DatabaseQuery;
  transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  id?: () => string;
  env?: NodeJS.ProcessEnv;
};

type ResolutionFactRow = {
  batch_state: string;
  import_kind: ImportKind;
  import_row_id: string;
  row_state: string;
  normalized_json: Record<string, string | null> | string;
  blocking_error_count: number | string;
  candidate_person_count: number | string;
  candidate_person_id: string | null;
};

type ApprovalBatchRow = {
  id: string;
  import_kind: string;
  state: string;
  import_file_id: string | null;
  import_file_count: number | string;
  sha256: string | null;
  malware_scan_status: string | null;
  snapshot_date: string | Date | null;
  effective_date: string | Date | null;
  duplicate_source_acknowledged: boolean | null;
  duplicate_source_exists: boolean;
  total_blocking_error_count: number | string;
};

type ApprovalRow = {
  import_row_id: string;
  import_row_hash: string;
  sheet_name: string;
  source_row_number: number;
  row_state: string;
  normalized_json: Record<string, string | null> | string;
  resolution_type: ResolutionType | null;
  resolution_person_id: string | null;
  resolution_id: string | null;
  blocking_error_count: number | string;
  candidate_person_count: number | string;
  resolution_is_candidate: boolean;
  existing_person_active: boolean;
  existing_preferred_name: string | null;
  existing_first_name: string | null;
  existing_last_name: string | null;
  existing_membership_status: string | null;
  existing_department: string | null;
  existing_section: string | null;
  existing_classification: string | null;
  existing_work_location: string | null;
  existing_primary_work_email: string | null;
};

type LiveIdentityRow = {
  import_row_id: string;
  person_id: string;
  evidence_type: "employee_identifier" | "member_identifier" | "work_email";
};

type ExistingIdentifierRow = {
  import_row_id: string;
  identifier_type: "employee_identifier" | "member_identifier";
  identifier_value: string;
};

type PreviousSnapshotRow = {
  snapshot_id: string;
  snapshot_date: string | Date;
  person_id: string | null;
};

export type ImportApprovalReasonCode =
  | "IMPORT_NOT_FOUND"
  | "ALREADY_APPROVED"
  | "BATCH_REJECTED"
  | "UNSUPPORTED_IMPORT_KIND"
  | "LEGACY_CAT_NOT_APPROVABLE"
  | "SOURCE_FILE_MISSING"
  | "SOURCE_FILE_AMBIGUOUS"
  | "BLOCKING_VALIDATION_ERROR"
  | "REJECTED_ROWS"
  | "IDENTIFIER_CONFLICT"
  | "UNRESOLVED_ROWS"
  | "STALE_RESOLUTION"
  | "SNAPSHOT_DATE_REQUIRED"
  | "EFFECTIVE_DATE_REQUIRED"
  | "DUPLICATE_SOURCE_ACK_REQUIRED"
  | "MALWARE_NOT_CLEAN"
  | "SYNTHETIC_PREVIEW_REQUIRED";

export type ImportApprovalReason = {
  code: ImportApprovalReasonCode;
  message: string;
  count?: number;
};

export type PlannedRowAction = {
  importRowId: string;
  sheetName: string;
  sourceRowNumber: number;
  displayName: string;
  resolutionType: ResolutionType;
  existingPersonId: string | null;
  profileChanges: Array<{ field: string; from: string | null; to: string }>;
  workEmailAction: "none" | "create_primary" | "replace_primary";
  identifierActions: Array<"attach_employee_identifier" | "attach_member_identifier">;
  membershipAction: "none" | "set_member" | "set_nonmember" | "set_source_status";
  plannedMembershipStatus: "member" | "nonmember" | "unknown" | null;
  eventAction: "none" | "correction" | "hire" | "addition" | "drop";
  eventDate: string | null;
};

export type ImportApprovalPreview = {
  ready: boolean;
  fingerprint: string | null;
  fullHash: string | null;
  counts: {
    confirmedExisting: number;
    plannedNewPeople: number;
    profileFieldUpdates: number;
    workEmailChanges: number;
    identifierAttachments: number;
    membershipStatusChanges: number;
    employmentEvents: number;
    membershipEvents: number;
    snapshotRows: number;
    enteringSnapshot: number;
    leavingSnapshot: number;
  };
  snapshotDate: string | null;
  effectiveDate: string | null;
  previousSnapshot: { date: string; rowCount: number } | null;
  rows: PlannedRowAction[];
  detailLimit: number;
  entireBatchEvaluated: true;
};

export type ImportApprovalReview = {
  batch: {
    id: string;
    importKind: ImportKind | "unsupported";
    state: string;
    duplicateSourceExists: boolean;
    duplicateSourceAcknowledged: boolean;
    snapshotDate: string | null;
    effectiveDate: string | null;
  } | null;
  resolutions: Array<{
    importRowId: string;
    resolutionId: string;
    resolutionType: ResolutionType;
    personId: string | null;
  }>;
  readiness: { ready: boolean; reasons: ImportApprovalReason[] };
  preview: ImportApprovalPreview;
};

const reasonMessages: Record<ImportApprovalReasonCode, string> = {
  IMPORT_NOT_FOUND: "The import batch was not found.",
  ALREADY_APPROVED: "This import batch is already approved.",
  BATCH_REJECTED: "Rejected import batches cannot be approved.",
  UNSUPPORTED_IMPORT_KIND: "This import kind is not supported for approval.",
  LEGACY_CAT_NOT_APPROVABLE: "Legacy CAT imports are review-only and are not approvable.",
  SOURCE_FILE_MISSING: "The encrypted source file metadata is missing.",
  SOURCE_FILE_AMBIGUOUS: "The import batch has more than one source file and cannot be approved.",
  BLOCKING_VALIDATION_ERROR: "Blocking validation errors must be corrected and re-uploaded.",
  REJECTED_ROWS: "Rejected rows must be corrected and re-uploaded.",
  IDENTIFIER_CONFLICT: "Authoritative identifiers conflict and require a corrected source.",
  UNRESOLVED_ROWS: "Every approvable row requires a saved resolution.",
  STALE_RESOLUTION: "One or more resolutions no longer agree with live authoritative identity data.",
  SNAPSHOT_DATE_REQUIRED: "A snapshot date is required for a current-roster approval plan.",
  EFFECTIVE_DATE_REQUIRED: "An effective date is required for this approval plan.",
  DUPLICATE_SOURCE_ACK_REQUIRED: "An identical source was previously approved and must be acknowledged.",
  MALWARE_NOT_CLEAN: "The source file does not satisfy the malware-status requirement.",
  SYNTHETIC_PREVIEW_REQUIRED: "Pending malware status is allowed only for strictly isolated Preview records.",
};

function parseJson(value: Record<string, string | null> | string) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, string | null> : {};
  } catch {
    return {};
  }
}

function clean(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function normalized(value: string | null | undefined) {
  return clean(value)?.toLowerCase() ?? null;
}

function identities(values: Record<string, string | null>) {
  return {
    employee_identifier: clean(values.employee_identifier),
    member_identifier: clean(values.member_identifier),
    work_email: clean(values.work_email),
  };
}

function validImportKind(value: string): value is ImportKind {
  return value === "current_roster" || value === "new_hires" || value === "recent_hires"
    || value === "membership_additions" || value === "membership_drops" || value === "legacy_cat";
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validMembershipStatus(value: string | null): value is "member" | "nonmember" | "unknown" {
  return value === "member" || value === "nonmember" || value === "unknown";
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (!validIsoDate(value)) throw new ControlledImportApprovalError("INVALID_DATE");
  return value;
}

function databaseDate(value: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function requireApprover(actor: ImportApprovalActor) {
  if (!can(actor.role, "approveImports")) throw new ControlledImportApprovalError("FORBIDDEN");
}

function dependencies(input: ImportApprovalDependencies = {}) {
  const query = input.query ?? queryLocal801;
  const transaction = input.transaction ?? (input.query
    ? async (statements: readonly DatabaseStatement[]) => {
        for (const statement of statements) await query(statement.sql, statement.parameters);
      }
    : runLocal801Transaction);
  return {
    query,
    transaction,
    id: input.id ?? randomUUID,
    env: input.env ?? process.env,
  };
}

async function atomicWrite(
  actor: ImportApprovalActor,
  mutation: DatabaseStatement,
  event: AuditEvent,
  input: ImportApprovalDependencies,
) {
  const deps = dependencies(input);
  const audit = await prepareAtomicAuditStatement(event, deps.query);
  await deps.transaction([mutation, audit]);
}

async function loadResolutionFacts(
  actor: ImportApprovalActor,
  batchId: string,
  rowId: string,
  query: DatabaseQuery,
) {
  return query<ResolutionFactRow>(
    `
      /* approval:resolution-facts */
      SELECT batch.state AS batch_state, batch.import_kind, row.id AS import_row_id,
        row.state AS row_state, row.normalized_json,
        (SELECT count(*)::int FROM local801.import_errors error
          WHERE error.organization_id = $1 AND error.import_batch_id = $2
            AND error.import_row_id = row.id AND error.severity = 'error') AS blocking_error_count,
        (SELECT count(DISTINCT candidate.person_id)::int
          FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id
            AND candidate.person_id IS NOT NULL) AS candidate_person_count,
        (SELECT min(candidate.person_id::text)
          FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id
            AND candidate.person_id IS NOT NULL) AS candidate_person_id
      FROM local801.import_batches batch
      JOIN local801.import_files file
        ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
      JOIN local801.import_sheets sheet
        ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
      JOIN local801.import_rows row
        ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
      WHERE batch.organization_id = $1 AND batch.id = $2
        AND file.organization_id = $1 AND sheet.organization_id = $1
        AND row.organization_id = $1 AND row.id = $3
    `,
    [actor.organizationId, batchId, rowId],
  );
}

async function loadLiveIdentityMatches(
  organizationId: string,
  values: Record<string, string | null>,
  query: DatabaseQuery,
) {
  const evidence = identities(values);
  return query<{ person_id: string; evidence_type: string }>(
    `
      /* approval:single-row-live-identities */
      SELECT DISTINCT matched.person_id, matched.evidence_type
      FROM (
        SELECT identifier.person_id, identifier.identifier_type AS evidence_type
        FROM local801.person_identifiers identifier
        WHERE identifier.organization_id = $1
          AND (
            (identifier.identifier_type = 'employee_identifier' AND $2::text IS NOT NULL
              AND lower(btrim(identifier.identifier_value)) = lower(btrim($2)))
            OR (identifier.identifier_type = 'member_identifier' AND $3::text IS NOT NULL
              AND lower(btrim(identifier.identifier_value)) = lower(btrim($3)))
          )
        UNION ALL
        SELECT contact.person_id, 'work_email' AS evidence_type
        FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1
          AND contact.contact_type = 'work_email'
          AND contact.archived_at IS NULL
          AND $4::text IS NOT NULL
          AND lower(btrim(contact.contact_value)) = lower(btrim($4))
      ) matched
      ORDER BY matched.person_id, matched.evidence_type
    `,
    [organizationId, evidence.employee_identifier, evidence.member_identifier, evidence.work_email],
  );
}

function resolutionMutationSql(resolutionType: ResolutionType): string {
  if (resolutionType === "confirm_existing") {
    return `
      WITH valid_row AS (
        SELECT row.id
        FROM local801.import_batches batch
        JOIN local801.import_files file ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
        JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
        JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
        JOIN local801.import_match_candidates candidate ON candidate.import_row_id = row.id AND candidate.organization_id = row.organization_id
        JOIN local801.people person ON person.id = $5 AND person.organization_id = $2 AND person.archived_at IS NULL
        WHERE batch.id = $3 AND batch.organization_id = $2
          AND file.organization_id = $2 AND sheet.organization_id = $2
          AND row.id = $4 AND row.organization_id = $2 AND row.state <> 'rejected'
          AND batch.state NOT IN ('approved', 'rejected')
          AND NOT EXISTS (SELECT 1 FROM local801.import_errors error
            WHERE error.organization_id = $2 AND error.import_batch_id = $3
              AND error.import_row_id = row.id AND error.severity = 'error')
          AND EXISTS (
            SELECT 1 FROM local801.person_identifiers identifier
            WHERE identifier.organization_id = $2 AND identifier.person_id = $5
              AND ((identifier.identifier_type = 'employee_identifier'
                  AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
                  AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
                OR (identifier.identifier_type = 'member_identifier'
                  AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
                  AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
            UNION ALL
            SELECT 1 FROM local801.person_contact_methods contact
            WHERE contact.organization_id = $2 AND contact.person_id = $5
              AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
              AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
              AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM local801.person_identifiers identifier
            WHERE identifier.organization_id = $2 AND identifier.person_id <> $5
              AND ((identifier.identifier_type = 'employee_identifier'
                  AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
                  AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
                OR (identifier.identifier_type = 'member_identifier'
                  AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
                  AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
            UNION ALL
            SELECT 1 FROM local801.person_contact_methods contact
            WHERE contact.organization_id = $2 AND contact.person_id <> $5
              AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
              AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
              AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
          )
        GROUP BY row.id
        HAVING count(DISTINCT candidate.person_id) = 1
          AND bool_and(candidate.person_id = $5)
      ), saved_resolution AS (
        INSERT INTO local801.import_row_resolutions
          (id, organization_id, import_batch_id, import_row_id, resolution_type, person_id, decided_by)
        SELECT $1, $2, $3, valid_row.id, 'confirm_existing', $5, $6
        FROM valid_row
        ON CONFLICT (import_row_id) DO UPDATE SET
          resolution_type = 'confirm_existing', person_id = $5, decided_by = $6,
          decided_at = now(), updated_at = now()
        WHERE import_row_resolutions.organization_id = $2
          AND import_row_resolutions.import_batch_id = $3
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS resolution_saved
      FROM saved_resolution
    `;
  }
  return `
    WITH valid_row AS (
      SELECT row.id
      FROM local801.import_batches batch
      JOIN local801.import_files file ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
      JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
      JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
      WHERE batch.id = $3 AND batch.organization_id = $2
        AND file.organization_id = $2 AND sheet.organization_id = $2
        AND row.id = $4 AND row.organization_id = $2 AND row.state <> 'rejected'
        AND batch.state NOT IN ('approved', 'rejected')
        AND NULLIF(btrim(row.normalized_json ->> 'first_name'), '') IS NOT NULL
        AND NULLIF(btrim(row.normalized_json ->> 'last_name'), '') IS NOT NULL
        AND (
          NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
          OR NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
          OR NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
        )
        AND NOT EXISTS (SELECT 1 FROM local801.import_errors error
          WHERE error.organization_id = $2 AND error.import_batch_id = $3
            AND error.import_row_id = row.id AND error.severity = 'error')
        AND NOT EXISTS (SELECT 1 FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $2 AND candidate.import_row_id = row.id
            AND candidate.person_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM local801.person_identifiers identifier
          WHERE identifier.organization_id = $2
            AND (
              (identifier.identifier_type = 'employee_identifier'
                AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
                AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
              OR (identifier.identifier_type = 'member_identifier'
                AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
                AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier')))
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM local801.person_contact_methods contact
          WHERE contact.organization_id = $2 AND contact.contact_type = 'work_email'
            AND contact.archived_at IS NULL
            AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
            AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
        )
    ), saved_resolution AS (
      INSERT INTO local801.import_row_resolutions
        (id, organization_id, import_batch_id, import_row_id, resolution_type, person_id, decided_by)
      SELECT $1, $2, $3, valid_row.id, 'create_new', NULL, $5
      FROM valid_row
      ON CONFLICT (import_row_id) DO UPDATE SET
        resolution_type = 'create_new', person_id = NULL, decided_by = $5,
        decided_at = now(), updated_at = now()
      WHERE import_row_resolutions.organization_id = $2
        AND import_row_resolutions.import_batch_id = $3
      RETURNING id
    )
    SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS resolution_saved
    FROM saved_resolution
  `;
}

export async function setImportRowResolution(
  actor: ImportApprovalActor,
  input: { batchId: string; rowId: string; resolutionType: unknown },
  inputDependencies: ImportApprovalDependencies = {},
) {
  requireApprover(actor);
  if (!validUuid(input.batchId) || !validUuid(input.rowId)) {
    throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  }
  if (input.resolutionType !== "confirm_existing" && input.resolutionType !== "create_new") {
    throw new ControlledImportApprovalError("INVALID_RESOLUTION");
  }
  const deps = dependencies(inputDependencies);
  const facts = await loadResolutionFacts(actor, input.batchId, input.rowId, deps.query);
  const fact = facts[0];
  if (!fact) throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  if (fact.batch_state === "approved" || fact.batch_state === "rejected" || fact.row_state === "rejected") {
    throw new ControlledImportApprovalError("IMPORT_NOT_RESOLVABLE");
  }
  if (Number(fact.blocking_error_count) > 0) throw new ControlledImportApprovalError("IMPORT_NOT_RESOLVABLE");
  const values = parseJson(fact.normalized_json);
  const candidatePersonIds = [...new Set(facts.map((row) => row.candidate_person_id).filter((id): id is string => Boolean(id)))];
  const candidatePersonCount = Number(fact.candidate_person_count ?? candidatePersonIds.length);
  const liveMatches = await loadLiveIdentityMatches(actor.organizationId, values, deps.query);
  const livePersonIds = [...new Set(liveMatches.map((match) => match.person_id))];
  let personId: string | null = null;
  if (input.resolutionType === "confirm_existing") {
    if (candidatePersonCount > 1) throw new ControlledImportApprovalError("IDENTIFIER_CONFLICT");
    if (candidatePersonCount !== 1 || candidatePersonIds.length !== 1) throw new ControlledImportApprovalError("INVALID_RESOLUTION");
    personId = candidatePersonIds[0];
    if (livePersonIds.length !== 1 || livePersonIds[0] !== personId) {
      throw new ControlledImportApprovalError("STALE_RESOLUTION");
    }
  } else {
    const identity = identities(values);
    if (!clean(values.first_name) || !clean(values.last_name) || !Object.values(identity).some(Boolean)) {
      throw new ControlledImportApprovalError("INVALID_RESOLUTION");
    }
    if (candidatePersonCount > 0 || livePersonIds.length > 0) {
      throw new ControlledImportApprovalError("STALE_RESOLUTION");
    }
  }
  const resolutionId = deps.id();
  const parameters = input.resolutionType === "confirm_existing"
    ? [resolutionId, actor.organizationId, input.batchId, input.rowId, personId, actor.userId]
    : [resolutionId, actor.organizationId, input.batchId, input.rowId, actor.userId];
  await atomicWrite(
    actor,
    { sql: resolutionMutationSql(input.resolutionType), parameters },
    {
      eventType: "import.resolution_set",
      actorId: actor.userId,
      organizationId: actor.organizationId,
      subjectType: "import_row",
      subjectId: input.rowId,
      payload: { resolution_type: input.resolutionType },
    },
    inputDependencies,
  );
  return { resolutionType: input.resolutionType };
}

export async function clearImportRowResolution(
  actor: ImportApprovalActor,
  input: { batchId: string; rowId: string },
  inputDependencies: ImportApprovalDependencies = {},
) {
  requireApprover(actor);
  if (!validUuid(input.batchId) || !validUuid(input.rowId)) {
    throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  }
  const mutation: DatabaseStatement = {
    sql: `
      WITH deleted_resolution AS (
        DELETE FROM local801.import_row_resolutions resolution
        USING local801.import_batches batch
        WHERE resolution.organization_id = $1 AND resolution.import_batch_id = $2
          AND resolution.import_row_id = $3
          AND batch.id = resolution.import_batch_id AND batch.organization_id = $1
          AND batch.state NOT IN ('approved', 'rejected')
        RETURNING resolution.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS resolution_cleared
      FROM deleted_resolution
    `,
    parameters: [actor.organizationId, input.batchId, input.rowId],
  };
  await atomicWrite(actor, mutation, {
    eventType: "import.resolution_cleared",
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_row",
    subjectId: input.rowId,
    payload: {},
  }, inputDependencies);
  return { cleared: true };
}

async function loadPlanBatch(actor: ImportApprovalActor, batchId: string, query: DatabaseQuery) {
  const [batch] = await query<{ id: string; import_kind: string; state: string }>(
    `SELECT id, import_kind, state FROM local801.import_batches WHERE id = $1 AND organization_id = $2`,
    [batchId, actor.organizationId],
  );
  return batch;
}

export async function saveImportApprovalPlan(
  actor: ImportApprovalActor,
  input: { batchId: string; snapshotDate?: unknown; effectiveDate?: unknown },
  inputDependencies: ImportApprovalDependencies = {},
) {
  requireApprover(actor);
  if (!validUuid(input.batchId)) throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  const deps = dependencies(inputDependencies);
  const batch = await loadPlanBatch(actor, input.batchId, deps.query);
  if (!batch) throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  if (batch.state === "approved" || batch.state === "rejected"
    || !validImportKind(batch.import_kind) || batch.import_kind === "legacy_cat") {
    throw new ControlledImportApprovalError("IMPORT_NOT_RESOLVABLE");
  }
  const snapshotDate = optionalDate(input.snapshotDate);
  const effectiveDate = optionalDate(input.effectiveDate);
  const storedSnapshotDate = batch.import_kind === "current_roster" ? snapshotDate : null;
  const storedEffectiveDate = batch.import_kind === "current_roster" ? null : effectiveDate;
  const mutation: DatabaseStatement = {
    sql: `
      WITH saved_plan AS (
        INSERT INTO local801.import_approval_plans
          (id, organization_id, import_batch_id, snapshot_date, effective_date, created_by, updated_by)
        SELECT $1, $2, batch.id, $4::date, $5::date, actor.id, actor.id
        FROM local801.import_batches batch
        JOIN local801.users actor ON actor.id = $3 AND actor.organization_id = $2 AND actor.deactivated_at IS NULL
        WHERE batch.id = $6 AND batch.organization_id = $2
          AND batch.state NOT IN ('approved', 'rejected') AND batch.import_kind <> 'legacy_cat'
        ON CONFLICT (import_batch_id) DO UPDATE SET
          snapshot_date = EXCLUDED.snapshot_date,
          effective_date = EXCLUDED.effective_date,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        WHERE import_approval_plans.organization_id = $2
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS plan_saved
      FROM saved_plan
    `,
    parameters: [deps.id(), actor.organizationId, actor.userId, storedSnapshotDate, storedEffectiveDate, input.batchId],
  };
  await atomicWrite(actor, mutation, {
    eventType: "import.approval_plan_update",
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_batch",
    subjectId: input.batchId,
    payload: { import_kind: batch.import_kind },
  }, inputDependencies);
  return { snapshotDate: storedSnapshotDate, effectiveDate: storedEffectiveDate };
}

const duplicateSourceSql = `
  /* approval:duplicate-source */
  WITH current_source AS (
    SELECT current_batch.id AS import_batch_id,
      count(current_file.id)::int AS source_file_count,
      CASE WHEN count(current_file.id) = 1 THEN min(current_file.sha256) ELSE NULL END AS sha256
    FROM local801.import_batches current_batch
    LEFT JOIN local801.import_files current_file
      ON current_file.import_batch_id = current_batch.id
      AND current_file.organization_id = current_batch.organization_id
    WHERE current_batch.id = $2 AND current_batch.organization_id = $1
    GROUP BY current_batch.id
  )
  SELECT current_source.source_file_count,
    current_source.source_file_count = 1 AND EXISTS (
      SELECT 1
      FROM local801.import_files prior_file
      JOIN local801.import_batches prior_batch
        ON prior_batch.id = prior_file.import_batch_id
        AND prior_batch.organization_id = prior_file.organization_id
      WHERE prior_file.organization_id = $1
        AND prior_file.sha256 = current_source.sha256
        AND prior_batch.organization_id = $1
        AND prior_batch.state = 'approved'
        AND prior_batch.id <> current_source.import_batch_id
    ) AS duplicate_exists
  FROM current_source
`;

async function duplicateSourceStatus(actor: ImportApprovalActor, batchId: string, query: DatabaseQuery) {
  const [result] = await query<{ duplicate_exists: boolean; source_file_count: number | string }>(
    duplicateSourceSql,
    [actor.organizationId, batchId],
  );
  return result
    ? { duplicateExists: result.duplicate_exists === true, sourceFileCount: Number(result.source_file_count) }
    : null;
}

export async function acknowledgeDuplicateImportSource(
  actor: ImportApprovalActor,
  batchId: string,
  inputDependencies: ImportApprovalDependencies = {},
) {
  requireApprover(actor);
  if (!validUuid(batchId)) throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  const deps = dependencies(inputDependencies);
  const duplicate = await duplicateSourceStatus(actor, batchId, deps.query);
  if (!duplicate) throw new ControlledImportApprovalError("IMPORT_NOT_FOUND");
  if (duplicate.sourceFileCount !== 1) {
    throw new ControlledImportApprovalError("SOURCE_FILE_AMBIGUOUS");
  }
  if (!duplicate.duplicateExists) {
    throw new ControlledImportApprovalError("DUPLICATE_SOURCE_ACK_REQUIRED");
  }
  const mutation: DatabaseStatement = {
    sql: `
      WITH current_source AS (
        SELECT current_batch.id AS import_batch_id, min(current_file.sha256) AS sha256
        FROM local801.import_batches current_batch
        JOIN local801.import_files current_file
          ON current_file.import_batch_id = current_batch.id
          AND current_file.organization_id = current_batch.organization_id
        WHERE current_batch.id = $4 AND current_batch.organization_id = $2
          AND current_batch.state NOT IN ('approved', 'rejected')
        GROUP BY current_batch.id
        HAVING count(current_file.id) = 1
      ), duplicate_batch AS (
        SELECT current_source.import_batch_id AS id
        FROM current_source
        WHERE EXISTS (
          SELECT 1 FROM local801.import_files prior_file
          JOIN local801.import_batches prior_batch
            ON prior_batch.id = prior_file.import_batch_id
            AND prior_batch.organization_id = prior_file.organization_id
          WHERE prior_file.organization_id = $2
            AND prior_file.sha256 = current_source.sha256
            AND prior_batch.organization_id = $2
            AND prior_batch.state = 'approved'
            AND prior_batch.id <> current_source.import_batch_id
        )
      ), saved_plan AS (
        INSERT INTO local801.import_approval_plans
          (id, organization_id, import_batch_id, duplicate_source_acknowledged,
           duplicate_source_acknowledged_by, duplicate_source_acknowledged_at, created_by, updated_by)
        SELECT $1, $2, duplicate_batch.id, true, actor.id, now(), actor.id, actor.id
        FROM duplicate_batch
        JOIN local801.users actor ON actor.id = $3 AND actor.organization_id = $2 AND actor.deactivated_at IS NULL
        ON CONFLICT (import_batch_id) DO UPDATE SET
          duplicate_source_acknowledged = true,
          duplicate_source_acknowledged_by = EXCLUDED.duplicate_source_acknowledged_by,
          duplicate_source_acknowledged_at = EXCLUDED.duplicate_source_acknowledged_at,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        WHERE import_approval_plans.organization_id = $2
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS duplicate_acknowledged
      FROM saved_plan
    `,
    parameters: [deps.id(), actor.organizationId, actor.userId, batchId],
  };
  await atomicWrite(actor, mutation, {
    eventType: "import.duplicate_source_ack",
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_batch",
    subjectId: batchId,
    payload: { duplicate_source_acknowledged: true },
  }, inputDependencies);
  return { acknowledged: true };
}

async function loadApprovalDataset(actor: ImportApprovalActor, batchId: string, query: DatabaseQuery) {
  const [batch] = await query<ApprovalBatchRow>(
    `
      /* approval:batch */
      SELECT batch.id, batch.import_kind, batch.state,
        file.id AS import_file_id, file.sha256, file.malware_scan_status,
        (SELECT count(*)::int FROM local801.import_files counted_file
          WHERE counted_file.organization_id = $1 AND counted_file.import_batch_id = batch.id) AS import_file_count,
        plan.snapshot_date, plan.effective_date, plan.duplicate_source_acknowledged,
        (SELECT count(*)::int FROM local801.import_errors error
          WHERE error.organization_id = $1 AND error.import_batch_id = batch.id
            AND error.severity = 'error') AS total_blocking_error_count,
        EXISTS (
          SELECT 1 FROM local801.import_files prior_file
          JOIN local801.import_batches prior_batch
            ON prior_batch.id = prior_file.import_batch_id AND prior_batch.organization_id = prior_file.organization_id
          WHERE prior_file.organization_id = $1 AND prior_file.sha256 = file.sha256
            AND prior_batch.organization_id = $1 AND prior_batch.state = 'approved'
            AND prior_batch.id <> batch.id
        ) AS duplicate_source_exists
      FROM local801.import_batches batch
      LEFT JOIN LATERAL (
        SELECT id, sha256, malware_scan_status FROM local801.import_files
        WHERE import_batch_id = batch.id AND organization_id = batch.organization_id
        ORDER BY created_at, id LIMIT 1
      ) file ON true
      LEFT JOIN local801.import_approval_plans plan
        ON plan.import_batch_id = batch.id AND plan.organization_id = batch.organization_id
      WHERE batch.id = $2 AND batch.organization_id = $1
    `,
    [actor.organizationId, batchId],
  );
  if (!batch) return { batch: null, rows: [], live: [], existingIdentifiers: [], previousSnapshot: [] };
  const rows = await query<ApprovalRow>(
    `
      /* approval:rows-entire-batch */
      SELECT row.id AS import_row_id, row.row_hash AS import_row_hash, sheet.sheet_name,
        row.source_row_number, row.state AS row_state, row.normalized_json,
        resolution.id AS resolution_id, resolution.resolution_type, resolution.person_id AS resolution_person_id,
        (SELECT count(*)::int FROM local801.import_errors error
          WHERE error.organization_id = $1 AND error.import_batch_id = $2
            AND error.import_row_id = row.id AND error.severity = 'error') AS blocking_error_count,
        (SELECT count(DISTINCT candidate.person_id)::int FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id
            AND candidate.person_id IS NOT NULL) AS candidate_person_count,
        EXISTS (SELECT 1 FROM local801.import_match_candidates candidate
          WHERE candidate.organization_id = $1 AND candidate.import_row_id = row.id
            AND candidate.person_id = resolution.person_id) AS resolution_is_candidate,
        person.id IS NOT NULL AND person.archived_at IS NULL AS existing_person_active,
        person.preferred_name AS existing_preferred_name, person.first_name AS existing_first_name,
        person.last_name AS existing_last_name, person.membership_status AS existing_membership_status,
        person.department AS existing_department, person.section AS existing_section,
        person.classification AS existing_classification, person.work_location AS existing_work_location,
        primary_email.contact_value AS existing_primary_work_email
      FROM local801.import_batches batch
      JOIN local801.import_files file ON file.import_batch_id = batch.id
        AND file.organization_id = batch.organization_id
      JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
      JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
      LEFT JOIN local801.import_row_resolutions resolution
        ON resolution.import_row_id = row.id AND resolution.import_batch_id = batch.id
          AND resolution.organization_id = batch.organization_id
      LEFT JOIN local801.people person
        ON person.id = resolution.person_id AND person.organization_id = $1
      LEFT JOIN LATERAL (
        SELECT contact.contact_value FROM local801.person_contact_methods contact
        WHERE contact.organization_id = $1 AND contact.person_id = person.id
          AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL AND contact.is_primary = true
        ORDER BY contact.created_at, contact.id LIMIT 1
      ) primary_email ON true
      WHERE batch.id = $2 AND batch.organization_id = $1
        AND file.organization_id = $1 AND sheet.organization_id = $1 AND row.organization_id = $1
      ORDER BY sheet.created_at, sheet.id, row.source_row_number, row.id
    `,
    [actor.organizationId, batchId],
  );
  const live = await query<LiveIdentityRow>(
    `
      /* approval:live-identities-entire-batch */
      SELECT DISTINCT matched.import_row_id, matched.person_id, matched.evidence_type
      FROM (
        SELECT row.id AS import_row_id, identifier.person_id, identifier.identifier_type AS evidence_type
        FROM local801.import_batches batch
        JOIN local801.import_files file ON file.import_batch_id = batch.id
          AND file.organization_id = batch.organization_id
        JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
        JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
        JOIN local801.person_identifiers identifier ON identifier.organization_id = $1
          AND ((identifier.identifier_type = 'employee_identifier'
              AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
              AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
            OR (identifier.identifier_type = 'member_identifier'
              AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
              AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
        WHERE batch.id = $2 AND batch.organization_id = $1
          AND file.organization_id = $1 AND sheet.organization_id = $1 AND row.organization_id = $1
        UNION ALL
        SELECT row.id AS import_row_id, contact.person_id, 'work_email' AS evidence_type
        FROM local801.import_batches batch
        JOIN local801.import_files file ON file.import_batch_id = batch.id
          AND file.organization_id = batch.organization_id
        JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
        JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
        JOIN local801.person_contact_methods contact ON contact.organization_id = $1
          AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
          AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
          AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
        WHERE batch.id = $2 AND batch.organization_id = $1
          AND file.organization_id = $1 AND sheet.organization_id = $1 AND row.organization_id = $1
      ) matched
      ORDER BY matched.import_row_id, matched.person_id, matched.evidence_type
    `,
    [actor.organizationId, batchId],
  );
  const existingIdentifiers = await query<ExistingIdentifierRow>(
    `
      /* approval:existing-identifiers */
      SELECT resolution.import_row_id, identifier.identifier_type, identifier.identifier_value
      FROM local801.import_row_resolutions resolution
      JOIN local801.person_identifiers identifier
        ON identifier.person_id = resolution.person_id AND identifier.organization_id = resolution.organization_id
      WHERE resolution.organization_id = $1 AND resolution.import_batch_id = $2
        AND identifier.organization_id = $1
        AND identifier.identifier_type IN ('employee_identifier', 'member_identifier')
      ORDER BY resolution.import_row_id, identifier.identifier_type, identifier.id
    `,
    [actor.organizationId, batchId],
  );
  const previousSnapshot = batch.import_kind === "current_roster"
    ? await query<PreviousSnapshotRow>(
        `
          /* approval:previous-snapshot */
          SELECT snapshot.id AS snapshot_id, snapshot.snapshot_date, snapshot_row.person_id
          FROM local801.membership_snapshots snapshot
          LEFT JOIN local801.membership_snapshot_rows snapshot_row
            ON snapshot_row.snapshot_id = snapshot.id AND snapshot_row.organization_id = snapshot.organization_id
          WHERE snapshot.organization_id = $1 AND snapshot.status = 'approved'
            AND snapshot.snapshot_date <= $2::date
            AND snapshot.id = (
              SELECT id FROM local801.membership_snapshots
              WHERE organization_id = $1 AND status = 'approved'
                AND snapshot_date <= $2::date
              ORDER BY snapshot_date DESC, created_at DESC, id DESC LIMIT 1
            )
          ORDER BY snapshot_row.person_id
        `,
        [actor.organizationId, databaseDate(batch.snapshot_date)],
      )
    : [];
  return { batch, rows, live, existingIdentifiers, previousSnapshot };
}

function syntheticIdentitiesOnly(rows: ApprovalRow[]) {
  return rows.every((row) => {
    const identity = identities(parseJson(row.normalized_json));
    return (!identity.work_email || normalized(identity.work_email)?.endsWith("@example.test"))
      && (!identity.employee_identifier || identity.employee_identifier.toUpperCase().startsWith("SYNTH-"))
      && (!identity.member_identifier || identity.member_identifier.toUpperCase().startsWith("SYNTH-"));
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function addReason(target: Map<ImportApprovalReasonCode, ImportApprovalReason>, code: ImportApprovalReasonCode, count?: number) {
  const current = target.get(code);
  target.set(code, { code, message: reasonMessages[code], count: (current?.count ?? 0) + (count ?? 0) || undefined });
}

function displayName(values: Record<string, string | null>, row: ApprovalRow) {
  return clean(values.preferred_name)
    || [clean(values.first_name), clean(values.last_name)].filter(Boolean).join(" ")
    || row.existing_preferred_name
    || [row.existing_first_name, row.existing_last_name].filter(Boolean).join(" ")
    || "Import row";
}

function evaluateDataset(
  actor: ImportApprovalActor,
  dataset: Awaited<ReturnType<typeof loadApprovalDataset>>,
  env: NodeJS.ProcessEnv,
): ImportApprovalReview {
  const reasons = new Map<ImportApprovalReasonCode, ImportApprovalReason>();
  const emptyPreview: ImportApprovalPreview = {
    ready: false,
    fingerprint: null,
    fullHash: null,
    counts: {
      confirmedExisting: 0, plannedNewPeople: 0, profileFieldUpdates: 0,
      workEmailChanges: 0, identifierAttachments: 0, membershipStatusChanges: 0,
      employmentEvents: 0, membershipEvents: 0, snapshotRows: 0,
      enteringSnapshot: 0, leavingSnapshot: 0,
    },
    snapshotDate: null,
    effectiveDate: null,
    previousSnapshot: null,
    rows: [], detailLimit: 50, entireBatchEvaluated: true,
  };
  if (!dataset.batch) {
    addReason(reasons, "IMPORT_NOT_FOUND");
    return { batch: null, resolutions: [], readiness: { ready: false, reasons: [...reasons.values()] }, preview: emptyPreview };
  }
  const batch = dataset.batch;
  const snapshotDate = databaseDate(batch.snapshot_date);
  const effectiveDate = databaseDate(batch.effective_date);
  if (batch.state === "approved") addReason(reasons, "ALREADY_APPROVED");
  if (batch.state === "rejected") addReason(reasons, "BATCH_REJECTED");
  if (!validImportKind(batch.import_kind)) addReason(reasons, "UNSUPPORTED_IMPORT_KIND");
  if (batch.import_kind === "legacy_cat") addReason(reasons, "LEGACY_CAT_NOT_APPROVABLE");
  if (!batch.import_file_id || !batch.sha256) addReason(reasons, "SOURCE_FILE_MISSING");
  if (Number(batch.import_file_count) !== 1) {
    addReason(reasons, Number(batch.import_file_count) > 1 ? "SOURCE_FILE_AMBIGUOUS" : "SOURCE_FILE_MISSING");
  }
  const batchBlockingErrors = Number(batch.total_blocking_error_count);
  if (batch.import_kind === "current_roster" && !snapshotDate) addReason(reasons, "SNAPSHOT_DATE_REQUIRED");
  if ((batch.import_kind === "membership_additions" || batch.import_kind === "membership_drops") && !effectiveDate) {
    addReason(reasons, "EFFECTIVE_DATE_REQUIRED");
  }
  if (batch.duplicate_source_exists && !batch.duplicate_source_acknowledged) {
    addReason(reasons, "DUPLICATE_SOURCE_ACK_REQUIRED");
  }
  if (batch.malware_scan_status !== "clean") {
    const previewException = env.VERCEL_ENV === "preview"
      || (env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production"
        && env.LOCAL801_ALLOW_SYNTHETIC_SEED === "1");
    if (batch.malware_scan_status !== "pending" || !previewException) addReason(reasons, "MALWARE_NOT_CLEAN");
    else if (!syntheticIdentitiesOnly(dataset.rows)) addReason(reasons, "SYNTHETIC_PREVIEW_REQUIRED");
  }

  const liveByRow = new Map<string, LiveIdentityRow[]>();
  for (const match of dataset.live) liveByRow.set(match.import_row_id, [...(liveByRow.get(match.import_row_id) ?? []), match]);
  const identifiersByRow = new Map<string, ExistingIdentifierRow[]>();
  for (const identifier of dataset.existingIdentifiers) {
    identifiersByRow.set(identifier.import_row_id, [...(identifiersByRow.get(identifier.import_row_id) ?? []), identifier]);
  }
  const actions: PlannedRowAction[] = [];
  let unresolved = 0;
  let rejected = 0;
  let blockingErrors = Number.isFinite(batchBlockingErrors) ? batchBlockingErrors : 1;
  let conflicts = 0;
  let stale = 0;
  let missingNewHireDate = 0;

  for (const row of dataset.rows) {
    const values = parseJson(row.normalized_json);
    const identity = identities(values);
    const live = liveByRow.get(row.import_row_id) ?? [];
    const livePeople = [...new Set(live.map((match) => match.person_id))];
    const candidateCount = Number(row.candidate_person_count);
    if (row.row_state === "rejected") rejected += 1;
    if (candidateCount > 1) conflicts += 1;
    if (!row.resolution_type) {
      unresolved += 1;
      continue;
    }
    let validResolution = true;
    if (row.resolution_type === "confirm_existing") {
      if (candidateCount !== 1 || !row.resolution_is_candidate || !row.existing_person_active
        || !row.resolution_person_id || livePeople.length !== 1 || livePeople[0] !== row.resolution_person_id) {
        validResolution = false;
      }
    } else if (candidateCount !== 0 || livePeople.length !== 0
      || !clean(values.first_name) || !clean(values.last_name) || !Object.values(identity).some(Boolean)) {
      validResolution = false;
    }
    if (!validResolution) {
      stale += 1;
      continue;
    }

    const profileChanges: PlannedRowAction["profileChanges"] = [];
    if (row.resolution_type === "confirm_existing") {
      const profileFields = [
        ["first_name", row.existing_first_name], ["last_name", row.existing_last_name],
        ["preferred_name", row.existing_preferred_name], ["department", row.existing_department],
        ["section", row.existing_section], ["classification", row.existing_classification],
        ["work_location", row.existing_work_location],
      ] as const;
      for (const [field, existing] of profileFields) {
        const source = clean(values[field]);
        if (source && source !== clean(existing)) profileChanges.push({ field, from: existing, to: source });
      }
    }

    const identifierActions: PlannedRowAction["identifierActions"] = [];
    if (row.resolution_type === "confirm_existing") {
      for (const type of ["employee_identifier", "member_identifier"] as const) {
        const source = identity[type];
        if (!source) continue;
        const owners = live.filter((match) => match.evidence_type === type).map((match) => match.person_id);
        if (owners.some((owner) => owner !== row.resolution_person_id)) {
          validResolution = false;
          break;
        }
        if (owners.length === 0) {
          const existingOfType = (identifiersByRow.get(row.import_row_id) ?? [])
            .filter((item) => item.identifier_type === type);
          if (existingOfType.some((item) => normalized(item.identifier_value) !== normalized(source))) {
            conflicts += 1;
            validResolution = false;
            break;
          }
          identifierActions.push(type === "employee_identifier" ? "attach_employee_identifier" : "attach_member_identifier");
        }
      }
    } else {
      if (identity.employee_identifier) identifierActions.push("attach_employee_identifier");
      if (identity.member_identifier) identifierActions.push("attach_member_identifier");
    }
    if (!validResolution) {
      stale += 1;
      continue;
    }

    let workEmailAction: PlannedRowAction["workEmailAction"] = "none";
    if (identity.work_email) {
      if (row.resolution_type === "create_new") workEmailAction = "create_primary";
      else if (normalized(identity.work_email) !== normalized(row.existing_primary_work_email)) workEmailAction = "replace_primary";
    }

    let membershipAction: PlannedRowAction["membershipAction"] = "none";
    let plannedMembershipStatus: PlannedRowAction["plannedMembershipStatus"] = row.resolution_type === "create_new"
      ? "unknown"
      : null;
    let eventAction: PlannedRowAction["eventAction"] = "none";
    let eventDate: string | null = null;
    if (batch.import_kind === "current_roster") {
      const sourceStatus = clean(values.membership_status);
      if (sourceStatus && !validMembershipStatus(sourceStatus)) {
        blockingErrors += 1;
      } else if (validMembershipStatus(sourceStatus) && sourceStatus !== row.existing_membership_status) {
        membershipAction = "set_source_status";
        plannedMembershipStatus = sourceStatus;
        if (row.resolution_type === "confirm_existing") eventAction = "correction";
      }
    } else if (batch.import_kind === "new_hires" || batch.import_kind === "recent_hires") {
      const rowHireDate = clean(values.hire_date);
      if (rowHireDate && validIsoDate(rowHireDate)) eventDate = rowHireDate;
      else if (rowHireDate) blockingErrors += 1;
      else if (!rowHireDate && effectiveDate) eventDate = effectiveDate;
      else missingNewHireDate += 1;
      eventAction = "hire";
    } else if (batch.import_kind === "membership_additions") {
      eventDate = effectiveDate;
      if (row.resolution_type === "create_new" || row.existing_membership_status !== "member") {
        membershipAction = "set_member";
        plannedMembershipStatus = "member";
        eventAction = "addition";
      }
    } else if (batch.import_kind === "membership_drops") {
      eventDate = effectiveDate;
      if (row.resolution_type === "create_new" || row.existing_membership_status !== "nonmember") {
        membershipAction = "set_nonmember";
        plannedMembershipStatus = "nonmember";
        eventAction = "drop";
      }
    }

    actions.push({
      importRowId: row.import_row_id,
      sheetName: row.sheet_name,
      sourceRowNumber: row.source_row_number,
      displayName: displayName(values, row),
      resolutionType: row.resolution_type,
      existingPersonId: row.resolution_person_id,
      profileChanges,
      workEmailAction,
      identifierActions,
      membershipAction,
      plannedMembershipStatus,
      eventAction,
      eventDate,
    });
  }
  if (blockingErrors > 0) addReason(reasons, "BLOCKING_VALIDATION_ERROR", blockingErrors);
  if (rejected > 0) addReason(reasons, "REJECTED_ROWS", rejected);
  if (conflicts > 0) addReason(reasons, "IDENTIFIER_CONFLICT", conflicts);
  if (unresolved > 0) addReason(reasons, "UNRESOLVED_ROWS", unresolved);
  if (stale > 0) addReason(reasons, "STALE_RESOLUTION", stale);
  if ((batch.import_kind === "new_hires" || batch.import_kind === "recent_hires") && missingNewHireDate > 0) addReason(reasons, "EFFECTIVE_DATE_REQUIRED", missingNewHireDate);

  const previousPeople = new Set(dataset.previousSnapshot.map((row) => row.person_id).filter((id): id is string => Boolean(id)));
  const plannedPeople = new Set(actions.map((action) => action.existingPersonId).filter((id): id is string => Boolean(id)));
  const createdCount = actions.filter((action) => action.resolutionType === "create_new").length;
  const counts = {
    confirmedExisting: actions.filter((action) => action.resolutionType === "confirm_existing").length,
    plannedNewPeople: createdCount,
    profileFieldUpdates: actions.reduce((count, action) => count + action.profileChanges.length, 0),
    workEmailChanges: actions.filter((action) => action.workEmailAction !== "none").length,
    identifierAttachments: actions.reduce((count, action) => count + action.identifierActions.length, 0),
    membershipStatusChanges: actions.filter((action) => action.membershipAction !== "none").length,
    employmentEvents: actions.filter((action) => action.eventAction === "hire").length,
    membershipEvents: actions.filter((action) => ["correction", "addition", "drop"].includes(action.eventAction)).length,
    snapshotRows: batch.import_kind === "current_roster" ? actions.length : 0,
    enteringSnapshot: batch.import_kind === "current_roster"
      ? [...plannedPeople].filter((id) => !previousPeople.has(id)).length + createdCount : 0,
    leavingSnapshot: batch.import_kind === "current_roster"
      ? [...previousPeople].filter((id) => !plannedPeople.has(id)).length : 0,
  };
  const ready = reasons.size === 0;
  const sortedRows = [...dataset.rows].sort((left, right) => left.import_row_id.localeCompare(right.import_row_id));
  const sortedActions = [...actions].sort((left, right) => left.importRowId.localeCompare(right.importRowId));
  const hashInput = ready ? {
    organizationId: actor.organizationId,
    batchId: batch.id,
    importKind: batch.import_kind,
    sourceSha256: batch.sha256,
    snapshotDate,
    effectiveDate,
    rowHashes: sortedRows.map((row) => row.import_row_hash),
    resolutions: sortedRows.map((row) => ({
      rowId: row.import_row_id,
      type: row.resolution_type,
      personId: row.resolution_person_id,
    })),
    actions: sortedActions.map((action) => ({
      rowId: action.importRowId,
      type: action.resolutionType,
      personId: action.existingPersonId,
      profileFields: action.profileChanges.map((change) => change.field).sort(),
      workEmailAction: action.workEmailAction,
      identifierActions: [...action.identifierActions].sort(),
      membershipAction: action.membershipAction,
      plannedMembershipStatus: action.plannedMembershipStatus,
      eventAction: action.eventAction,
      eventDate: action.eventDate,
    })),
  } : null;
  const fullHash = hashInput ? createHash("sha256").update(canonical(hashInput)).digest("hex") : null;
  const previousSnapshot = dataset.previousSnapshot[0]
    ? { date: databaseDate(dataset.previousSnapshot[0].snapshot_date) ?? "", rowCount: previousPeople.size }
    : null;
  const preview: ImportApprovalPreview = {
    ready,
    fingerprint: fullHash?.slice(0, 12).toUpperCase() ?? null,
    fullHash,
    counts,
    snapshotDate,
    effectiveDate,
    previousSnapshot,
    rows: actions.slice(0, 50),
    detailLimit: 50,
    entireBatchEvaluated: true,
  };
  return {
    batch: {
      id: batch.id,
      importKind: validImportKind(batch.import_kind) ? batch.import_kind : "unsupported",
      state: batch.state,
      duplicateSourceExists: batch.duplicate_source_exists,
      duplicateSourceAcknowledged: batch.duplicate_source_acknowledged === true,
      snapshotDate,
      effectiveDate,
    },
    resolutions: dataset.rows.flatMap((row) => row.resolution_id && row.resolution_type
      ? [{ importRowId: row.import_row_id, resolutionId: row.resolution_id, resolutionType: row.resolution_type, personId: row.resolution_person_id }]
      : []),
    readiness: { ready, reasons: [...reasons.values()] },
    preview,
  };
}

/**
 * @deprecated Full-batch Phase 2B-1 compatibility evaluator. Do not use this
 * materializing service as a 20K approval executor. The aggregate/keyset review
 * services in import-review.ts are the supported large-batch review path.
 */
export async function getImportApprovalReview(
  actor: ImportApprovalActor,
  batchId: string,
  inputDependencies: ImportApprovalDependencies = {},
) {
  requireApprover(actor);
  const deps = dependencies(inputDependencies);
  const dataset = await loadApprovalDataset(actor, batchId, deps.query);
  return evaluateDataset(actor, dataset, deps.env);
}

/** @deprecated See getImportApprovalReview; this delegates to the full-batch evaluator. */
export async function getImportApprovalReadiness(
  actor: ImportApprovalActor,
  batchId: string,
  inputDependencies: ImportApprovalDependencies = {},
) {
  return (await getImportApprovalReview(actor, batchId, inputDependencies)).readiness;
}

/** @deprecated See getImportApprovalReview; this delegates to the full-batch evaluator. */
export async function getImportApprovalPreview(
  actor: ImportApprovalActor,
  batchId: string,
  inputDependencies: ImportApprovalDependencies = {},
) {
  return (await getImportApprovalReview(actor, batchId, inputDependencies)).preview;
}

export const __testing = { validIsoDate, canonical, syntheticIdentitiesOnly, duplicateSourceSql };
