import "server-only";

import { randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { outreachHandle } from "./outreach.ts";
import { PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE } from "./pii-protected-import-classification.ts";
import {
  decryptProtectedImportRowBundle,
  type ProtectedImportReviewRow,
} from "./pii-protected-import-read.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE_RE = /^[0-9a-f]{64}$/i;
const ISSUE_LIMIT = 50;
const EMPLOYEE_CANDIDATE_CAP = 2_500;
const SUGGESTION_LIMIT = 5;

type BatchRow = { id: string; import_kind: string; created_at: string | Date };
type IssueRow = ProtectedImportReviewRow & {
  batch_id: string;
  import_kind: string;
  category: "proposed_new" | "needs_attention" | "rejected";
  department: string | null;
  classification: string | null;
  work_location: string | null;
  resolution_type: "confirm_existing" | "create_new" | null;
  resolution_person_id: string | null;
  person_id: string | null;
  work_email_identity_matches: boolean;
  error_messages: string[] | null;
};

type EmployeeRow = {
  person_id: string;
  employee_reference: number | string;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  first_name_encrypted_payload: string;
  first_name_encryption_key_version: string;
  first_name_encryption_format_version: number;
  last_name_encrypted_payload: string;
  last_name_encryption_key_version: string;
  last_name_encryption_format_version: number;
  preferred_name_encrypted_payload: string | null;
  preferred_name_encryption_key_version: string | null;
  preferred_name_encryption_format_version: number | null;
};

export type MatchCandidate = {
  personHandle: string;
  displayName: string;
  employeeReference: string;
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  score: number;
  reasons: string[];
  selected: boolean;
};

export type ImportDataIssue = {
  batchId: string;
  importKind: string;
  rowId: string;
  sheetName: string;
  sourceRowNumber: number;
  category: IssueRow["category"];
  displayName: string;
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  errorMessages: string[];
  decision: "link_existing" | "create_new" | null;
  exactWorkEmailMatch: boolean;
  exactWorkEmailEmployee: MatchCandidate | null;
  candidates: MatchCandidate[];
};

export class ImportDataIssueError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ImportDataIssueError";
    this.code = code;
    this.status = status;
  }
}

function requireAccess(context: Pick<WorkspaceContext, "role">) {
  if (!can(context.role, "manageImports")) {
    throw new ImportDataIssueError("FORBIDDEN", "Data-issue resolution is not authorized.", 403);
  }
}

function encrypted(row: Record<string, unknown>, payload: string, key: string, format: string) {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    throw new ImportDataIssueError("PROTECTED_RECORD_INVALID", "A protected employee record is unavailable.", 503);
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 } satisfies Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion">;
}

function employeeName(row: EmployeeRow, organizationId: string, config: PiiKeyConfiguration) {
  const source = row as unknown as Record<string, unknown>;
  const first = decryptPiiField(encrypted(source, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "first-name" }, config).trim();
  const last = decryptPiiField(encrypted(source, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "last-name" }, config).trim();
  const preferred = row.preferred_name_encrypted_payload === null ? null : decryptPiiField(
    encrypted(source, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version"),
    { organizationId, entity: "person", recordId: row.person_id, field: "preferred-name" }, config,
  ).trim();
  return { first, last, preferred, displayName: fullName(first, last, preferred) };
}

function fullName(first: string | undefined, last: string | undefined, preferred?: string | null) {
  const legal = `${first ?? ""} ${last ?? ""}`.trim();
  const alias = preferred?.trim();
  if (!legal) return alias || "Name unavailable";
  return alias && alias.toLocaleLowerCase("en-US") !== (first ?? "").trim().toLocaleLowerCase("en-US")
    ? `${legal} (${alias})`
    : legal;
}

function normalized(value: string | null | undefined) {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

function editDistance(left: string, right: string) {
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

type RankSource = { firstName: string; lastName: string; preferredName?: string | null; department?: string | null; classification?: string | null; workLocation?: string | null };
type RankTarget = RankSource & { personId: string; selected?: boolean };

export function rankPossibleEmployeeMatches(source: RankSource, employees: readonly RankTarget[]) {
  const sourceFirst = normalized(source.firstName);
  const sourceLast = normalized(source.lastName);
  const sourceFull = normalized(`${source.firstName} ${source.lastName}`);
  return employees.map((employee) => {
    const targetFirst = normalized(employee.firstName);
    const targetPreferred = normalized(employee.preferredName);
    const targetLast = normalized(employee.lastName);
    const targetFull = normalized(`${employee.firstName} ${employee.lastName}`);
    const reasons: string[] = [];
    let score = 0;
    if (sourceFull && sourceFull === targetFull) {
      score = 92;
      reasons.push("Exact full-name match");
    } else if (sourceLast && sourceLast === targetLast && sourceFirst && (sourceFirst === targetFirst || sourceFirst === targetPreferred)) {
      score = 90;
      reasons.push("First and last name match");
    } else if (sourceLast && sourceLast === targetLast && sourceFirst[0] && sourceFirst[0] === (targetFirst[0] || targetPreferred[0])) {
      score = 72;
      reasons.push("Same last name and first initial");
    } else if (sourceFull && targetFull) {
      const similarity = 1 - editDistance(sourceFull, targetFull) / Math.max(sourceFull.length, targetFull.length);
      if (similarity >= 0.82) { score = 78; reasons.push("Very similar full name"); }
      else if (similarity >= 0.68) { score = 62; reasons.push("Similar full name"); }
    }
    for (const [sourceValue, targetValue, reason] of [
      [source.department, employee.department, "Same department"],
      [source.classification, employee.classification, "Same classification"],
      [source.workLocation, employee.workLocation, "Same work location"],
    ] as const) {
      if (normalized(sourceValue) && normalized(sourceValue) === normalized(targetValue)) {
        score += 4;
        reasons.push(reason);
      }
    }
    if (employee.selected) { score = 100; reasons.unshift("Current saved decision"); }
    return { personId: employee.personId, score: Math.min(score, 100), reasons };
  }).filter((candidate) => candidate.score >= 62)
    .sort((left, right) => right.score - left.score || left.personId.localeCompare(right.personId))
    .slice(0, SUGGESTION_LIMIT);
}

async function latestReviewBatch(context: WorkspaceContext, query: DatabaseQuery) {
  const [batch] = await query<BatchRow>(`
    SELECT id::text, import_kind, created_at
    FROM local801.import_batches
    WHERE organization_id = $1::uuid
      AND state = 'under_review'
      AND (processing_stage = 'ready_for_review' OR processing_stage IS NULL)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [context.organizationId]);
  return batch ?? null;
}

export async function getImportDataIssues(context: WorkspaceContext, query: DatabaseQuery = queryLocal801): Promise<{ batchId: string | null; issues: ImportDataIssue[]; hasMore: boolean }> {
  requireAccess(context);
  const mode = getPiiProtectedReadMode();
  if (mode === "legacy") throw new ImportDataIssueError("PROTECTED_READ_REQUIRED", "Import issue matching requires protected PII reads.", 503);
  await assertPiiProtectedReadState(context.organizationId, query, mode);
  const batch = await latestReviewBatch(context, query);
  if (!batch) return { batchId: null, issues: [], hasMore: false };
  const [rows, employees] = await Promise.all([
    query<IssueRow>(`WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}
      SELECT $2::uuid::text AS batch_id, $3::text AS import_kind,
        categorized.import_row_id::text, categorized.sheet_name, categorized.source_row_number,
        categorized.category, categorized.normalized_json ->> 'department' AS department,
        categorized.normalized_json ->> 'classification' AS classification,
        categorized.normalized_json ->> 'work_location' AS work_location,
        categorized.resolution_type, categorized.resolution_person_id::text,
        categorized.person_id::text, categorized.work_email_identity_matches,
        protected.direct_pii_encrypted_payload, protected.encryption_key_version,
        protected.encryption_format_version, protected.direct_pii_field_set_version,
        protected.direct_pii_presence_mask, protected.direct_pii_validity_mask,
        protected.row_integrity_hash, protected.row_integrity_key_version,
        COALESCE(errors.messages, ARRAY[]::text[]) AS error_messages
      FROM categorized
      JOIN local801.import_row_pii protected
        ON protected.organization_id = $1::uuid AND protected.import_row_id = categorized.import_row_id
      LEFT JOIN LATERAL (
        SELECT array_agg(error.message ORDER BY error.created_at, error.id) AS messages
        FROM local801.import_errors error
        WHERE error.organization_id = $1::uuid AND error.import_batch_id = $2::uuid
          AND error.import_row_id = categorized.import_row_id AND error.severity = 'error'
      ) errors ON true
      WHERE categorized.category IN ('proposed_new','needs_attention','rejected')
      ORDER BY CASE categorized.category WHEN 'rejected' THEN 0 WHEN 'needs_attention' THEN 1 ELSE 2 END,
        categorized.sheet_name, categorized.source_row_number, categorized.import_row_id
      LIMIT ${ISSUE_LIMIT + 1}
    `, [context.organizationId, batch.id, batch.import_kind]),
    query<EmployeeRow>(`
      SELECT person.id::text AS person_id, person.employee_reference, person.department,
        person.classification, person.work_location,
        protected.first_name_encrypted_payload, protected.first_name_encryption_key_version, protected.first_name_encryption_format_version,
        protected.last_name_encrypted_payload, protected.last_name_encryption_key_version, protected.last_name_encryption_format_version,
        protected.preferred_name_encrypted_payload, protected.preferred_name_encryption_key_version, protected.preferred_name_encryption_format_version
      FROM local801.people person
      JOIN local801.person_pii protected
        ON protected.organization_id = person.organization_id AND protected.person_id = person.id
      WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
      ORDER BY person.id
      LIMIT ${EMPLOYEE_CANDIDATE_CAP + 1}
    `, [context.organizationId]),
  ]);
  if (employees.length > EMPLOYEE_CANDIDATE_CAP) throw new ImportDataIssueError("CANDIDATE_LIMIT", "The employee list is too large for safe possible-match review.", 503);
  const keyConfig = getPiiKeyConfiguration();
  const employeeDetails = employees.map((employee) => ({ employee, ...employeeName(employee, context.organizationId, keyConfig) }));
  const hasMore = rows.length > ISSUE_LIMIT;
  const boundedRows = rows.slice(0, ISSUE_LIMIT);
  return {
    batchId: batch.id,
    hasMore,
    issues: boundedRows.map((row) => {
      const bundle = decryptProtectedImportRowBundle(row, context.organizationId, keyConfig);
      const ranked = row.work_email_identity_matches ? [] : rankPossibleEmployeeMatches({
        firstName: bundle.first_name ?? "",
        lastName: bundle.last_name ?? "",
        preferredName: bundle.preferred_name,
        department: row.department,
        classification: row.classification,
        workLocation: row.work_location,
      }, employeeDetails.map((item) => ({
        personId: item.employee.person_id,
        firstName: item.first,
        lastName: item.last,
        preferredName: item.preferred,
        department: item.employee.department,
        classification: item.employee.classification,
        workLocation: item.employee.work_location,
        selected: item.employee.person_id === row.resolution_person_id,
      })));
      const byId = new Map(employeeDetails.map((item) => [item.employee.person_id, item]));
      const candidateDetails = (personId: string, score: number, reasons: string[], selected: boolean): MatchCandidate | null => {
        const item = byId.get(personId);
        if (!item) return null;
        return {
          personHandle: outreachHandle(context.organizationId, item.employee.person_id),
          displayName: item.displayName,
          employeeReference: `L801-${String(item.employee.employee_reference).padStart(6, "0")}`,
          department: item.employee.department,
          classification: item.employee.classification,
          workLocation: item.employee.work_location,
          score,
          reasons,
          selected,
        };
      };
      const exactWorkEmailEmployee = row.work_email_identity_matches && row.person_id
        ? candidateDetails(row.person_id, 100, ["Exact active work email"], true)
        : null;
      return {
        batchId: batch.id,
        importKind: batch.import_kind,
        rowId: row.import_row_id,
        sheetName: row.sheet_name,
        sourceRowNumber: Number(row.source_row_number),
        category: row.category,
        displayName: fullName(bundle.first_name, bundle.last_name, bundle.preferred_name),
        department: row.department,
        classification: row.classification,
        workLocation: row.work_location,
        errorMessages: Array.isArray(row.error_messages) ? row.error_messages : [],
        decision: row.resolution_type === "confirm_existing" ? "link_existing" : row.resolution_type === "create_new" ? "create_new" : null,
        exactWorkEmailMatch: Boolean(row.work_email_identity_matches),
        exactWorkEmailEmployee,
        candidates: ranked.flatMap((candidate) => {
          const candidateDetail = candidateDetails(candidate.personId, candidate.score, candidate.reasons, candidate.personId === row.resolution_person_id);
          return candidateDetail ? [candidateDetail] : [];
        }),
      };
    }),
  };
}

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new ImportDataIssueError("INVALID_TARGET", `${label} is invalid.`, 400);
  return value.toLowerCase();
}

export async function resolveImportDataIssue(
  context: WorkspaceContext,
  input: { batchId: unknown; rowId: unknown; action: unknown; personHandle?: unknown },
  dependencies: { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  requireAccess(context);
  const batchId = requireUuid(input.batchId, "Import batch");
  const rowId = requireUuid(input.rowId, "Import row");
  if (!["link_existing", "create_new", "clear", "exclude"].includes(String(input.action))) {
    throw new ImportDataIssueError("INVALID_ACTION", "Choose a valid data-issue action.", 400);
  }
  const action = input.action as "link_existing" | "create_new" | "clear" | "exclude";
  const query = dependencies.query ?? queryLocal801;
  const [facts] = await query<{ category: string; work_email_identity_matches: boolean; automatic_person_count: number | string; automatic_person_id: string | null; direct_pii_presence_mask: number | string | null }>(`
    WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}
    SELECT categorized.category, categorized.work_email_identity_matches,
      categorized.automatic_person_count, categorized.automatic_person_id::text,
      protected.direct_pii_presence_mask
    FROM categorized
    JOIN local801.import_batches batch ON batch.organization_id = $1::uuid AND batch.id = $2::uuid
    JOIN local801.import_row_pii protected ON protected.organization_id = $1::uuid AND protected.import_row_id = categorized.import_row_id
    WHERE categorized.import_row_id = $3::uuid AND batch.state = 'under_review'
      AND (batch.processing_stage = 'ready_for_review' OR batch.processing_stage IS NULL)
    LIMIT 1
  `, [context.organizationId, batchId, rowId]);
  if (!facts) throw new ImportDataIssueError("NOT_FOUND", "This import issue is no longer available.", 404);
  if (facts.work_email_identity_matches && (action === "link_existing" || action === "create_new")) {
    throw new ImportDataIssueError("WORK_EMAIL_MATCH_LOCKED", "An exact active work-email match already controls this row and cannot be overridden.", 409);
  }
  if (Number(facts.automatic_person_count) > 0 && (action === "link_existing" || action === "create_new")) {
    throw new ImportDataIssueError("EXACT_IDENTITY_MATCH_LOCKED", "An exact email or identifier match already exists. Correct the source conflict instead of overriding it.", 409);
  }
  if ((action === "link_existing" || action === "create_new") && facts.category === "rejected") {
    throw new ImportDataIssueError("ROW_REJECTED", "Correct the rejected source data or remove this row from the import.", 409);
  }

  let personId: string | null = null;
  if (action === "link_existing") {
    if (typeof input.personHandle !== "string" || !HANDLE_RE.test(input.personHandle)) {
      throw new ImportDataIssueError("INVALID_PERSON", "Choose a valid employee record.", 400);
    }
    const [person] = await query<{ id: string }>(`
      SELECT id::text FROM local801.people
      WHERE organization_id = $1::uuid AND archived_at IS NULL
        AND encode(public.digest($1::text || ':' || id::text, 'sha256'), 'hex') = $2
      LIMIT 1
    `, [context.organizationId, input.personHandle.toLowerCase()]);
    if (!person) throw new ImportDataIssueError("PERSON_NOT_FOUND", "The selected employee is no longer active.", 404);
    personId = person.id;
  }
  if (action === "create_new") {
    const mask = Number(facts.direct_pii_presence_mask ?? 0);
    const hasNames = (mask & 1) !== 0 && (mask & 2) !== 0;
    const hasIdentity = (mask & 8) !== 0 || (mask & 16) !== 0 || (mask & 32) !== 0 || (mask & 64) !== 0;
    if (!hasNames || !hasIdentity) {
      throw new ImportDataIssueError("NEW_RECORD_INCOMPLETE", "A new employee requires a full name and at least one email or employee/member identifier.", 409);
    }
  }

  const statements: DatabaseStatement[] = [];
  if (action === "link_existing" || action === "create_new") {
    statements.push({
      sql: `WITH valid AS (
        SELECT row.id
        FROM local801.import_batches batch
        JOIN local801.import_files file ON file.organization_id = batch.organization_id AND file.import_batch_id = batch.id
        JOIN local801.import_sheets sheet ON sheet.organization_id = file.organization_id AND sheet.import_file_id = file.id
        JOIN local801.import_rows row ON row.organization_id = sheet.organization_id AND row.import_sheet_id = sheet.id
        WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid AND row.id = $3::uuid
          AND batch.state = 'under_review' AND row.state <> 'excluded'
      ), saved AS (
        INSERT INTO local801.import_row_resolutions
          (id, organization_id, import_batch_id, import_row_id, resolution_type, person_id, decided_by)
        SELECT $4::uuid, $1::uuid, $2::uuid, valid.id, $5, $6::uuid, $7::uuid FROM valid
        ON CONFLICT (import_row_id) DO UPDATE SET resolution_type = excluded.resolution_type,
          person_id = excluded.person_id, decided_by = excluded.decided_by, decided_at = now(), updated_at = now()
        WHERE local801.import_row_resolutions.organization_id = $1::uuid
          AND local801.import_row_resolutions.import_batch_id = $2::uuid
        RETURNING id
      ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM saved`,
      parameters: [context.organizationId, batchId, rowId, randomUUID(), action === "link_existing" ? "confirm_existing" : "create_new", personId, context.userId],
    });
  } else if (action === "clear") {
    statements.push({
      sql: `WITH removed AS (
        DELETE FROM local801.import_row_resolutions resolution
        USING local801.import_batches batch
        WHERE resolution.organization_id = $1::uuid AND resolution.import_batch_id = $2::uuid
          AND resolution.import_row_id = $3::uuid AND batch.id = resolution.import_batch_id
          AND batch.organization_id = resolution.organization_id AND batch.state = 'under_review'
        RETURNING resolution.id
      ) SELECT CASE WHEN count(*) <= 1 THEN true ELSE false END FROM removed`,
      parameters: [context.organizationId, batchId, rowId],
    });
  } else {
    statements.push({
      sql: `WITH changed AS (
        UPDATE local801.import_rows row SET state = 'excluded'
        FROM local801.import_sheets sheet, local801.import_files file, local801.import_batches batch
        WHERE row.organization_id = $1::uuid AND row.id = $3::uuid AND row.state <> 'excluded'
          AND sheet.organization_id = row.organization_id AND sheet.id = row.import_sheet_id
          AND file.organization_id = sheet.organization_id AND file.id = sheet.import_file_id
          AND batch.organization_id = file.organization_id AND batch.id = $2::uuid
          AND batch.id = file.import_batch_id AND batch.state = 'under_review'
        RETURNING row.id
      ), removed_resolution AS (
        DELETE FROM local801.import_row_resolutions resolution USING changed
        WHERE resolution.organization_id = $1::uuid AND resolution.import_batch_id = $2::uuid
          AND resolution.import_row_id = changed.id RETURNING resolution.id
      ), recounted AS (
        UPDATE local801.import_batches batch SET
          included_row_count = counts.included_count,
          excluded_row_count = counts.excluded_count
        FROM (
          SELECT count(*) FILTER (WHERE row.state <> 'excluded')::int AS included_count,
            count(*) FILTER (WHERE row.state = 'excluded')::int AS excluded_count
          FROM local801.import_files file
          JOIN local801.import_sheets sheet ON sheet.organization_id = file.organization_id AND sheet.import_file_id = file.id
          JOIN local801.import_rows row ON row.organization_id = sheet.organization_id AND row.import_sheet_id = sheet.id
          WHERE file.organization_id = $1::uuid AND file.import_batch_id = $2::uuid
        ) counts
        WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
          AND EXISTS (SELECT 1 FROM changed)
        RETURNING batch.id
      ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM recounted`,
      parameters: [context.organizationId, batchId, rowId],
    });
  }
  statements.push({
    sql: `DELETE FROM local801.import_batch_review_decisions WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid`,
    parameters: [context.organizationId, batchId],
  }, {
    sql: `UPDATE local801.protected_import_execution_sets SET state = 'invalidated', invalidated_at = now(), updated_at = now()
      WHERE organization_id = $1::uuid AND import_batch_id = $2::uuid AND state = 'prepared'`,
    parameters: [context.organizationId, batchId],
  });
  statements.push(await prepareAtomicAuditStatement({
    eventType: action === "clear" ? "import.resolution_cleared" : action === "exclude" ? "record.update" : "import.resolution_set",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "import_row",
    subjectId: rowId,
    payload: { workflow: "data_issue_resolution", action },
  }, query));
  await (dependencies.runTransaction ?? runLocal801Transaction)(statements);
  return { action };
}
