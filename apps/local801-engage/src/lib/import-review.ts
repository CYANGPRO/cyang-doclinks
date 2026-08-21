import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement, type AuditEventType } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { isPiiProtectedReadEnabled } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type ImportReviewCategory = "unchanged_existing" | "existing_with_changes" | "proposed_new" | "needs_attention" | "rejected";
export type ImportReviewDecisionType = "allow_proposed_new" | "acknowledge_existing_changes";
export type ImportReviewActor = Pick<WorkspaceContext, "organizationId" | "userId" | "role">;

export const IMPORT_REVIEW_PAGE_SIZE = 50;
export const IMPORT_REVIEW_MAX_PAGE_SIZE = 100;

export const IMPORT_REVIEW_CLASSIFICATION_CTE = `
  batch_rows AS (
    SELECT row.id AS import_row_id, row.row_hash, row.source_row_number, row.state AS row_state,
      row.normalized_json, sheet.sheet_name, file.sha256 AS source_file_sha256
    FROM local801.import_batches batch
    JOIN local801.import_files file ON file.import_batch_id = batch.id AND file.organization_id = batch.organization_id
    JOIN local801.import_sheets sheet ON sheet.import_file_id = file.id AND sheet.organization_id = file.organization_id
    JOIN local801.import_rows row ON row.import_sheet_id = sheet.id AND row.organization_id = sheet.organization_id
    WHERE batch.organization_id = $1 AND batch.id = $2
  ),
  batch_errors AS (
    SELECT error.import_row_id
    FROM local801.import_errors error
    WHERE error.organization_id = $1 AND error.import_batch_id = $2 AND error.severity = 'error'
  ),
  row_error_counts AS (
    SELECT error.import_row_id, count(*)::int AS error_count
    FROM batch_errors error
    WHERE error.import_row_id IS NOT NULL
    GROUP BY error.import_row_id
  ),
  batch_error_counts AS (
    SELECT count(*)::int AS blocking_error_count,
      count(*) FILTER (WHERE row.import_row_id IS NULL)::int AS unassociated_blocking_error_count
    FROM batch_errors error
    LEFT JOIN batch_rows row ON row.import_row_id = error.import_row_id
  ),
  live_evidence AS (
    SELECT row.import_row_id, identifier.person_id, identifier.identifier_type::text AS evidence_type
    FROM batch_rows row JOIN local801.person_identifiers identifier ON identifier.organization_id = $1
      AND ((identifier.identifier_type = 'employee_identifier'
          AND NULLIF(btrim(row.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
          AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'employee_identifier')))
        OR (identifier.identifier_type = 'member_identifier'
          AND NULLIF(btrim(row.normalized_json ->> 'member_identifier'), '') IS NOT NULL
          AND lower(btrim(identifier.identifier_value)) = lower(btrim(row.normalized_json ->> 'member_identifier'))))
    UNION ALL
    SELECT row.import_row_id, contact.person_id, 'work_email'
    FROM batch_rows row JOIN local801.person_contact_methods contact ON contact.organization_id = $1
      AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
      AND NULLIF(btrim(row.normalized_json ->> 'work_email'), '') IS NOT NULL
      AND lower(btrim(contact.contact_value)) = lower(btrim(row.normalized_json ->> 'work_email'))
  ),
  live_matches AS (
    SELECT import_row_id, count(DISTINCT person_id)::int AS person_count,
      CASE WHEN count(DISTINCT person_id) = 1 THEN min(person_id::text)::uuid END AS person_id,
      bool_or(evidence_type = 'employee_identifier') AS employee_identifier_matches,
      bool_or(evidence_type = 'member_identifier') AS member_identifier_matches,
      bool_or(evidence_type = 'work_email') AS work_email_matches
    FROM live_evidence GROUP BY import_row_id
  ),
  primary_work_emails AS (
    SELECT DISTINCT ON (contact.person_id) contact.person_id, contact.contact_value
    FROM local801.person_contact_methods contact
    WHERE contact.organization_id = $1 AND contact.contact_type = 'work_email'
      AND contact.archived_at IS NULL AND contact.is_primary = true
    ORDER BY contact.person_id, contact.created_at, contact.id
  ),
  row_facts AS (
    SELECT row.*, COALESCE(match.person_count, 0) AS person_count, match.person_id,
      COALESCE(match.employee_identifier_matches, false) AS employee_identifier_matches,
      COALESCE(match.member_identifier_matches, false) AS member_identifier_matches,
      COALESCE(match.work_email_matches, false) AS work_email_matches,
      person.first_name AS existing_first_name, person.last_name AS existing_last_name,
      person.preferred_name AS existing_preferred_name, person.department AS existing_department,
      person.section AS existing_section, person.classification AS existing_classification,
      person.work_location AS existing_work_location, person.membership_status AS existing_membership_status,
      (person.id IS NOT NULL AND person.archived_at IS NULL) AS existing_person_active,
      primary_email.contact_value AS existing_work_email,
      COALESCE(error.error_count, 0) AS error_count
    FROM batch_rows row
    LEFT JOIN live_matches match ON match.import_row_id = row.import_row_id
    LEFT JOIN local801.people person ON person.id = match.person_id AND person.organization_id = $1
    LEFT JOIN primary_work_emails primary_email ON primary_email.person_id = person.id
    LEFT JOIN row_error_counts error ON error.import_row_id = row.import_row_id
  ),
  categorized AS (
    SELECT facts.*,
      CASE
        WHEN facts.row_state = 'rejected' THEN 'rejected'
        WHEN facts.error_count > 0 OR facts.person_count > 1
          OR (facts.person_count = 1 AND NOT facts.existing_person_active) THEN 'needs_attention'
        WHEN NULLIF(btrim(facts.normalized_json ->> 'work_email'), '') IS NOT NULL
          AND NOT (btrim(facts.normalized_json ->> 'work_email') ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$') THEN 'needs_attention'
        WHEN NULLIF(btrim(facts.normalized_json ->> 'first_name'), '') IS NULL
          OR NULLIF(btrim(facts.normalized_json ->> 'last_name'), '') IS NULL
          OR (NULLIF(btrim(facts.normalized_json ->> 'employee_identifier'), '') IS NULL
            AND NULLIF(btrim(facts.normalized_json ->> 'member_identifier'), '') IS NULL
            AND NULLIF(btrim(facts.normalized_json ->> 'work_email'), '') IS NULL) THEN 'needs_attention'
        WHEN facts.person_count = 0 THEN 'proposed_new'
        WHEN facts.person_count = 1 AND (
          (NULLIF(btrim(facts.normalized_json ->> 'first_name'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'first_name') IS DISTINCT FROM btrim(facts.existing_first_name))
          OR (NULLIF(btrim(facts.normalized_json ->> 'last_name'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'last_name') IS DISTINCT FROM btrim(facts.existing_last_name))
          OR (NULLIF(btrim(facts.normalized_json ->> 'preferred_name'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'preferred_name') IS DISTINCT FROM btrim(facts.existing_preferred_name))
          OR (NULLIF(btrim(facts.normalized_json ->> 'department'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'department') IS DISTINCT FROM btrim(facts.existing_department))
          OR (NULLIF(btrim(facts.normalized_json ->> 'section'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'section') IS DISTINCT FROM btrim(facts.existing_section))
          OR (NULLIF(btrim(facts.normalized_json ->> 'classification'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'classification') IS DISTINCT FROM btrim(facts.existing_classification))
          OR (NULLIF(btrim(facts.normalized_json ->> 'work_location'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'work_location') IS DISTINCT FROM btrim(facts.existing_work_location))
          OR (NULLIF(btrim(facts.normalized_json ->> 'membership_status'), '') IS NOT NULL
            AND btrim(facts.normalized_json ->> 'membership_status') IS DISTINCT FROM btrim(facts.existing_membership_status))
          OR (NULLIF(btrim(facts.normalized_json ->> 'work_email'), '') IS NOT NULL
            AND lower(btrim(facts.normalized_json ->> 'work_email')) IS DISTINCT FROM lower(btrim(facts.existing_work_email)))
          OR (NULLIF(btrim(facts.normalized_json ->> 'employee_identifier'), '') IS NOT NULL
            AND NOT facts.employee_identifier_matches)
          OR (NULLIF(btrim(facts.normalized_json ->> 'member_identifier'), '') IS NOT NULL
            AND NOT facts.member_identifier_matches)
        ) THEN 'existing_with_changes'
        ELSE 'unchanged_existing'
      END::text AS category
    FROM row_facts facts
  )`;

// Each token contains only stable source coordinates, the persisted row hash,
// classification, and resolved person UUID. The token itself is hashed before
// set aggregation, so raw imported values never enter the set-hash input.
export const IMPORT_REVIEW_TOKEN_CTE = `
  review_tokens AS (
    SELECT category,
      encode(digest(concat_ws(chr(31), source_file_sha256, sheet_name, source_row_number::text,
        row_hash, category, COALESCE(person_id::text, '')), 'sha256'), 'hex') AS canonical_token
    FROM categorized
  )`;

type SummaryRow = {
  total_rows: number | string | null; included_rows: number | string | null; excluded_rows: number | string | null;
  rejected_rows: number | string | null; unchanged_existing: number | string; existing_with_changes: number | string;
  proposed_new: number | string; needs_attention: number | string; rejected: number | string;
  blocking_error_count: number | string; unassociated_blocking_error_count: number | string;
  eligible_new_set_hash: string; existing_changes_set_hash: string;
  import_kind: string; previous_snapshot_date: string | Date | null; previous_snapshot_count: number | string;
  proposed_snapshot_count: number | string; entering_snapshot: number | string; leaving_snapshot: number | string;
};
type DecisionRow = { decision_type: ImportReviewDecisionType; set_hash: string; set_count: number | string; decided_at: string | Date };
type DetailRow = { import_row_id: string; sheet_name: string; source_row_number: number; category: ImportReviewCategory;
  first_name: string | null; last_name: string | null; work_email: string | null; department: string | null;
  classification: string | null; membership_status: string | null; person_id: string | null };

export type ImportReviewSummary = {
  counts: { total: number; included: number; excluded: number | null; rejected: number; blockingErrors: number; unchangedExisting: number; existingWithChanges: number; proposedNew: number; needsAttention: number; metadataComplete: boolean };
  hashes: { proposedNew: string; existingChanges: string };
  decisions: { proposedNew: boolean; existingChanges: boolean; migrationPending: boolean };
  clicksRequired: number;
  blockers: number;
  snapshot: { previousDate: string | null; previous: number; proposed: number; entering: number; leaving: number; net: number; percentChange: number | null } | null;
};
export type ImportReviewDetail = { rows: Array<Omit<DetailRow, "import_row_id" | "person_id">>; nextCursor: string | null; pageSize: number };

function count(value: number | string | null) { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function validUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requireReviewer(actor: ImportReviewActor) { if (!can(actor.role, "approveImports")) throw new Error("Forbidden."); }
function detailCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 500) return null;
  try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); return typeof parsed.sheet === "string" && Number.isInteger(parsed.row) && validUuid(parsed.id) ? parsed as { sheet: string; row: number; id: string } : null; } catch { return null; }
}
function encodeDetailCursor(row: DetailRow) { return Buffer.from(JSON.stringify({ sheet: row.sheet_name, row: row.source_row_number, id: row.import_row_id })).toString("base64url"); }
function category(value: unknown): ImportReviewCategory { return ["unchanged_existing", "existing_with_changes", "proposed_new", "needs_attention", "rejected"].includes(String(value)) ? value as ImportReviewCategory : "needs_attention"; }

export async function getImportReviewSummary(actor: ImportReviewActor, batchId: string, query: DatabaseQuery = queryLocal801): Promise<ImportReviewSummary> {
  requireReviewer(actor); if (!validUuid(batchId)) throw new Error("Import not found.");
  if (isPiiProtectedReadEnabled()) {
    const { getProtectedImportReviewSummary } = await import("./pii-protected-import-review.ts");
    return getProtectedImportReviewSummary(actor, batchId, query);
  }
  const [row] = await query<SummaryRow>(`WITH ${IMPORT_REVIEW_CLASSIFICATION_CTE}, ${IMPORT_REVIEW_TOKEN_CTE}, set_hashes AS (
    SELECT category, count(*)::int AS set_count,
      encode(digest(COALESCE(string_agg(canonical_token, ':' ORDER BY canonical_token), ''), 'sha256'), 'hex') AS set_hash
    FROM review_tokens WHERE category IN ('proposed_new', 'existing_with_changes') GROUP BY category
  ), aggregate AS (
    SELECT count(*) FILTER (WHERE category = 'unchanged_existing') AS unchanged_existing,
      count(*) FILTER (WHERE category = 'existing_with_changes') AS existing_with_changes,
      count(*) FILTER (WHERE category = 'proposed_new') AS proposed_new,
      count(*) FILTER (WHERE category = 'needs_attention') AS needs_attention,
      count(*) FILTER (WHERE category = 'rejected') AS rejected,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'proposed_new'), encode(digest('', 'sha256'), 'hex')) AS eligible_new_set_hash,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'existing_with_changes'), encode(digest('', 'sha256'), 'hex')) AS existing_changes_set_hash
    FROM categorized
  ), previous_snapshot AS (
    SELECT snapshot.id, snapshot.snapshot_date
    FROM local801.membership_snapshots snapshot
    WHERE snapshot.organization_id = $1 AND snapshot.status = 'approved'
    ORDER BY snapshot.snapshot_date DESC, snapshot.created_at DESC, snapshot.id DESC LIMIT 1
  ), previous_people AS (
    SELECT snapshot_row.person_id FROM previous_snapshot snapshot
    JOIN local801.membership_snapshot_rows snapshot_row
      ON snapshot_row.snapshot_id = snapshot.id AND snapshot_row.organization_id = $1
  ), proposed_people AS (
    SELECT DISTINCT person_id FROM categorized
    WHERE category IN ('unchanged_existing', 'existing_with_changes') AND person_id IS NOT NULL
  ) SELECT batch.total_row_count AS total_rows, batch.included_row_count AS included_rows,
      batch.excluded_row_count AS excluded_rows, batch.rejected_row_count AS rejected_rows,
      batch.import_kind, (SELECT snapshot_date FROM previous_snapshot) AS previous_snapshot_date,
      (SELECT count(*) FROM previous_people) AS previous_snapshot_count,
      (SELECT count(*) FROM proposed_people) + aggregate.proposed_new AS proposed_snapshot_count,
      (SELECT count(*) FROM proposed_people proposed WHERE NOT EXISTS (SELECT 1 FROM previous_people previous WHERE previous.person_id = proposed.person_id)) + aggregate.proposed_new AS entering_snapshot,
      (SELECT count(*) FROM previous_people previous WHERE NOT EXISTS (SELECT 1 FROM proposed_people proposed WHERE proposed.person_id = previous.person_id)) AS leaving_snapshot,
      errors.blocking_error_count, errors.unassociated_blocking_error_count, aggregate.*
    FROM local801.import_batches batch CROSS JOIN aggregate CROSS JOIN batch_error_counts errors
    WHERE batch.organization_id = $1 AND batch.id = $2`, [actor.organizationId, batchId]);
  if (!row) throw new Error("Import not found.");
  let decisions: DecisionRow[] = []; let migrationPending = false;
  try {
    decisions = await query<DecisionRow>(`SELECT decision_type, set_hash, set_count, decided_at FROM local801.import_batch_review_decisions WHERE organization_id = $1 AND import_batch_id = $2 ORDER BY decision_type`, [actor.organizationId, batchId]);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") migrationPending = true;
    else throw error;
  }
  const proposedNew = count(row.proposed_new); const existingChanges = count(row.existing_with_changes);
  const proposedDecision = decisions.find((item) => item.decision_type === "allow_proposed_new");
  const changesDecision = decisions.find((item) => item.decision_type === "acknowledge_existing_changes");
  const proposedAccepted = proposedNew === 0 || (proposedDecision?.set_hash === row.eligible_new_set_hash && count(proposedDecision.set_count) === proposedNew);
  const changesAccepted = existingChanges === 0 || (changesDecision?.set_hash === row.existing_changes_set_hash && count(changesDecision.set_count) === existingChanges);
  const classifiedTotal = [row.unchanged_existing, row.existing_with_changes, row.proposed_new, row.needs_attention, row.rejected]
    .map((item) => count(item)).reduce((sum, item) => sum + item, 0);
  const included = count(row.included_rows) || classifiedTotal;
  const excluded = row.excluded_rows == null ? null : count(row.excluded_rows);
  const previous = count(row.previous_snapshot_count); const proposed = count(row.proposed_snapshot_count); const net = proposed - previous;
  const snapshot = row.import_kind === "current_roster" ? { previousDate: row.previous_snapshot_date instanceof Date ? row.previous_snapshot_date.toISOString().slice(0, 10) : row.previous_snapshot_date?.slice(0, 10) ?? null, previous, proposed, entering: count(row.entering_snapshot), leaving: count(row.leaving_snapshot), net, percentChange: previous ? (net / previous) * 100 : null } : null;
  const rejected = count(row.rejected_rows) || count(row.rejected);
  const blockingErrors = count(row.blocking_error_count);
  return { counts: { total: count(row.total_rows) || included + (excluded ?? 0), included, excluded, rejected, blockingErrors, unchangedExisting: count(row.unchanged_existing), existingWithChanges: existingChanges, proposedNew, needsAttention: count(row.needs_attention), metadataComplete: row.total_rows != null && row.included_rows != null && row.excluded_rows != null }, hashes: { proposedNew: row.eligible_new_set_hash, existingChanges: row.existing_changes_set_hash }, decisions: { proposedNew: proposedAccepted, existingChanges: changesAccepted, migrationPending }, clicksRequired: Number(proposedNew > 0) + Number(existingChanges > 0), blockers: count(row.needs_attention) + rejected + count(row.unassociated_blocking_error_count), snapshot };
}

export async function getImportReviewDetail(actor: ImportReviewActor, batchId: string, input: { category?: unknown; search?: unknown; cursor?: unknown; pageSize?: unknown }, query: DatabaseQuery = queryLocal801): Promise<ImportReviewDetail> {
  requireReviewer(actor); if (!validUuid(batchId)) throw new Error("Import not found.");
  if (isPiiProtectedReadEnabled()) {
    const { getProtectedImportReviewDetail } = await import("./pii-protected-import-review.ts");
    return getProtectedImportReviewDetail(actor, batchId, input, { query });
  }
  const selected = category(input.category); const search = typeof input.search === "string" ? input.search.trim().slice(0, 100) : "";
  const cursor = detailCursor(input.cursor); const requested = Number(input.pageSize); const pageSize = [25, 50, 100].includes(requested) ? requested : IMPORT_REVIEW_PAGE_SIZE;
  const rows = await query<DetailRow>(`WITH ${IMPORT_REVIEW_CLASSIFICATION_CTE}
    SELECT import_row_id, sheet_name, source_row_number, category,
      normalized_json ->> 'first_name' AS first_name, normalized_json ->> 'last_name' AS last_name,
      normalized_json ->> 'work_email' AS work_email, normalized_json ->> 'department' AS department,
      normalized_json ->> 'classification' AS classification, normalized_json ->> 'membership_status' AS membership_status,
      person_id
    FROM categorized
    WHERE category = $3
      AND ($4::text IS NULL OR concat_ws(' ', normalized_json ->> 'first_name', normalized_json ->> 'last_name', normalized_json ->> 'work_email', normalized_json ->> 'department', normalized_json ->> 'classification') ILIKE $4 ESCAPE '\\')
      AND ($5::text IS NULL OR (sheet_name, source_row_number, import_row_id) > ($5::text, $6::integer, $7::uuid))
    ORDER BY sheet_name, source_row_number, import_row_id LIMIT $8::integer`, [actor.organizationId, batchId, selected, search ? `%${search.replace(/[\\%_]/g, (item) => `\\${item}`)}%` : null, cursor?.sheet ?? null, cursor?.row ?? null, cursor?.id ?? null, pageSize + 1]);
  const hasNext = rows.length > pageSize; const bounded = rows.slice(0, pageSize);
  return { rows: bounded.map(({ import_row_id: _rowId, person_id: _personId, ...item }) => item), nextCursor: hasNext ? encodeDetailCursor(bounded.at(-1)!) : null, pageSize };
}

function decisionCategory(type: ImportReviewDecisionType) { return type === "allow_proposed_new" ? "proposed_new" : "existing_with_changes"; }
function decisionEvent(type: ImportReviewDecisionType): AuditEventType { return type === "allow_proposed_new" ? "import.review_new_people" : "import.review_existing_changes"; }

export async function setImportReviewDecision(actor: ImportReviewActor, batchId: string, type: ImportReviewDecisionType, expectedHash: string, dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {}) {
  requireReviewer(actor); if (!validUuid(batchId) || !/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error("Invalid review decision.");
  if (isPiiProtectedReadEnabled()) {
    const { setProtectedImportReviewDecision } = await import("./pii-protected-import-review.ts");
    return setProtectedImportReviewDecision(actor, batchId, type, expectedHash, dependencies);
  }
  const query = dependencies.query ?? queryLocal801; const transaction = dependencies.transaction ?? runLocal801Transaction;
  const selected = decisionCategory(type);
  const mutation: DatabaseStatement = { sql: `WITH ${IMPORT_REVIEW_CLASSIFICATION_CTE}, ${IMPORT_REVIEW_TOKEN_CTE}, current_set AS (
      SELECT encode(digest(COALESCE(string_agg(canonical_token, ':' ORDER BY canonical_token), ''), 'sha256'), 'hex') AS set_hash,
        count(*)::int AS set_count
      FROM review_tokens WHERE category = $3
    ), saved AS (
      INSERT INTO local801.import_batch_review_decisions
        (organization_id, import_batch_id, decision_type, set_hash, set_count, decided_by)
      SELECT $1, batch.id, $4, current_set.set_hash, current_set.set_count, actor.id
      FROM local801.import_batches batch CROSS JOIN current_set
      JOIN local801.users actor ON actor.id = $5 AND actor.organization_id = batch.organization_id AND actor.deactivated_at IS NULL
      WHERE batch.organization_id = $1 AND batch.id = $2 AND batch.state NOT IN ('approved', 'rejected')
        AND current_set.set_count > 0 AND current_set.set_hash = $6
      ON CONFLICT (import_batch_id, decision_type) DO UPDATE SET set_hash = EXCLUDED.set_hash,
        set_count = EXCLUDED.set_count, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now()
      WHERE import_batch_review_decisions.organization_id = $1
      RETURNING id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS decision_saved FROM saved`, parameters: [actor.organizationId, batchId, selected, type, actor.userId, expectedHash] };
  const audit = await prepareAtomicAuditStatement({ eventType: decisionEvent(type), actorId: actor.userId, organizationId: actor.organizationId, subjectType: "import_batch", subjectId: batchId, payload: { decisionType: type } }, query);
  await transaction([mutation, audit]);
}

export async function clearImportReviewDecision(actor: ImportReviewActor, batchId: string, type: ImportReviewDecisionType, dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {}) {
  requireReviewer(actor); if (!validUuid(batchId)) throw new Error("Invalid review decision.");
  const query = dependencies.query ?? queryLocal801; const transaction = dependencies.transaction ?? runLocal801Transaction;
  const mutation: DatabaseStatement = { sql: `WITH removed AS (DELETE FROM local801.import_batch_review_decisions decision USING local801.import_batches batch WHERE decision.organization_id = $1 AND decision.import_batch_id = $2 AND decision.decision_type = $3 AND batch.id = decision.import_batch_id AND batch.organization_id = decision.organization_id AND batch.state NOT IN ('approved', 'rejected') RETURNING decision.id) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS decision_cleared FROM removed`, parameters: [actor.organizationId, batchId, type] };
  const audit = await prepareAtomicAuditStatement({ eventType: "import.review_decision_cleared", actorId: actor.userId, organizationId: actor.organizationId, subjectType: "import_batch", subjectId: batchId, payload: { decisionType: type } }, query);
  await transaction([mutation, audit]);
}

export function summarizeGeneratedReviewRows(categories: readonly ImportReviewCategory[]) {
  const counts = Object.fromEntries(["unchanged_existing", "existing_with_changes", "proposed_new", "needs_attention", "rejected"].map((item) => [item, 0])) as Record<ImportReviewCategory, number>;
  for (const item of categories) counts[item] += 1;
  return { counts, routineDecisionCount: Number(counts.existing_with_changes > 0) + Number(counts.proposed_new > 0), blocked: counts.needs_attention + counts.rejected > 0 };
}