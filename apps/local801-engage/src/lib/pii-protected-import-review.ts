import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement, type AuditEventType } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import {
  IMPORT_REVIEW_MAX_PAGE_SIZE,
  IMPORT_REVIEW_PAGE_SIZE,
  IMPORT_REVIEW_TOKEN_CTE,
  type ImportReviewActor,
  type ImportReviewCategory,
  type ImportReviewDecisionType,
  type ImportReviewDetail,
  type ImportReviewSummary,
} from "./import-review.ts";
import { PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE } from "./pii-protected-import-classification.ts";
import {
  createPiiBlindIndex,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiIdentifier,
  normalizePiiNameForSearch,
  PiiProtectionError,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

type SummaryRow = {
  total_rows: number | string | null;
  included_rows: number | string | null;
  excluded_rows: number | string | null;
  rejected_rows: number | string | null;
  unchanged_existing: number | string;
  existing_with_changes: number | string;
  proposed_new: number | string;
  needs_attention: number | string;
  rejected: number | string;
  blocking_error_count: number | string;
  unassociated_blocking_error_count: number | string;
  eligible_new_set_hash: string;
  existing_changes_set_hash: string;
  import_kind: string;
  previous_snapshot_date: string | Date | null;
  previous_snapshot_count: number | string;
  proposed_snapshot_count: number | string;
  entering_snapshot: number | string;
  leaving_snapshot: number | string;
};

type DecisionRow = {
  decision_type: ImportReviewDecisionType;
  set_hash: string;
  set_count: number | string;
  decided_at: string | Date;
};

type DetailRow = {
  import_row_id: string;
  sheet_name: string;
  source_row_number: number;
  category: ImportReviewCategory;
  first_name: string | null;
  last_name: string | null;
  work_email: string | null;
  work_phone: string | null;
  personal_email: string | null;
  department: string | null;
  classification: string | null;
  membership_status: string | null;
  person_id: string | null;
};

type SearchIndex = { domain: string; key_version: string; hash: string };

function requireReviewer(actor: ImportReviewActor) {
  if (!can(actor.role, "approveImports")) throw new Error("Forbidden.");
}

function requireBatchId(value: string) {
  if (!UUID_RE.test(value)) throw new Error("Import not found.");
}

function count(value: number | string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function category(value: unknown): ImportReviewCategory {
  return ["unchanged_existing", "existing_with_changes", "proposed_new", "needs_attention", "rejected"].includes(String(value))
    ? value as ImportReviewCategory
    : "needs_attention";
}

function cursor(value: unknown) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof parsed.sheet === "string"
      && Number.isInteger(parsed.row)
      && typeof parsed.id === "string"
      && UUID_RE.test(parsed.id)
      ? { sheet: parsed.sheet, row: Number(parsed.row), id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(row: DetailRow) {
  return Buffer.from(JSON.stringify({ sheet: row.sheet_name, row: row.source_row_number, id: row.import_row_id })).toString("base64url");
}

function escapeLike(value: string) {
  return `%${value.replace(/[\\%_]/g, (item) => `\\${item}`)}%`;
}

function safeNormalize(normalize: () => string) {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof PiiProtectionError && error.code === "NORMALIZATION_FAILED") return null;
    throw error;
  }
}

function protectedSearchIndexes(organizationId: string, raw: string, keyConfig: PiiKeyConfiguration): SearchIndex[] {
  if (!raw) return [];
  const targets: Array<[string, string | null]> = [
    ["person:first-name", safeNormalize(() => normalizePiiNameForSearch(raw))],
    ["person:last-name", safeNormalize(() => normalizePiiNameForSearch(raw))],
    ["person:preferred-name", safeNormalize(() => normalizePiiNameForSearch(raw))],
    ["contact:work-email", safeNormalize(() => normalizePiiEmail(raw))],
    ["identifier:employee-identifier", safeNormalize(() => normalizePiiIdentifier(raw))],
    ["identifier:member-identifier", safeNormalize(() => normalizePiiIdentifier(raw))],
  ];
  return targets.flatMap(([domain, normalized]) => {
    if (!normalized) return [];
    const index = createPiiBlindIndex(normalized, { organizationId, domain }, keyConfig);
    return [{ domain, key_version: index.blindIndexKeyVersion, hash: index.blindIndex }];
  });
}

export async function getProtectedImportReviewSummary(
  actor: ImportReviewActor,
  batchId: string,
  query: DatabaseQuery = queryLocal801,
): Promise<ImportReviewSummary> {
  requireReviewer(actor);
  requireBatchId(batchId);
  const [row] = await query<SummaryRow>(`WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}, ${IMPORT_REVIEW_TOKEN_CTE}, set_hashes AS (
    SELECT category, count(*)::int AS set_count,
      encode(public.digest(COALESCE(string_agg(canonical_token, ':' ORDER BY canonical_token), ''), 'sha256'), 'hex') AS set_hash
    FROM review_tokens WHERE category IN ('proposed_new', 'existing_with_changes') GROUP BY category
  ), aggregate AS (
    SELECT count(*) FILTER (WHERE category = 'unchanged_existing') AS unchanged_existing,
      count(*) FILTER (WHERE category = 'existing_with_changes') AS existing_with_changes,
      count(*) FILTER (WHERE category = 'proposed_new') AS proposed_new,
      count(*) FILTER (WHERE category = 'needs_attention') AS needs_attention,
      count(*) FILTER (WHERE category = 'rejected') AS rejected,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'proposed_new'), encode(public.digest('', 'sha256'), 'hex')) AS eligible_new_set_hash,
      COALESCE((SELECT set_hash FROM set_hashes WHERE category = 'existing_with_changes'), encode(public.digest('', 'sha256'), 'hex')) AS existing_changes_set_hash
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

  let decisions: DecisionRow[] = [];
  let migrationPending = false;
  try {
    decisions = await query<DecisionRow>(
      `SELECT decision_type, set_hash, set_count, decided_at FROM local801.import_batch_review_decisions WHERE organization_id = $1 AND import_batch_id = $2 ORDER BY decision_type`,
      [actor.organizationId, batchId],
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") migrationPending = true;
    else throw error;
  }

  const proposedNew = count(row.proposed_new);
  const existingChanges = count(row.existing_with_changes);
  const proposedDecision = decisions.find((item) => item.decision_type === "allow_proposed_new");
  const changesDecision = decisions.find((item) => item.decision_type === "acknowledge_existing_changes");
  const proposedAccepted = proposedNew === 0 || (proposedDecision?.set_hash === row.eligible_new_set_hash && count(proposedDecision.set_count) === proposedNew);
  const changesAccepted = existingChanges === 0 || (changesDecision?.set_hash === row.existing_changes_set_hash && count(changesDecision.set_count) === existingChanges);
  const classifiedTotal = [row.unchanged_existing, row.existing_with_changes, row.proposed_new, row.needs_attention, row.rejected]
    .map((item) => count(item)).reduce((sum, item) => sum + item, 0);
  const included = count(row.included_rows) || classifiedTotal;
  const excluded = row.excluded_rows == null ? null : count(row.excluded_rows);
  const previous = count(row.previous_snapshot_count);
  const proposed = count(row.proposed_snapshot_count);
  const net = proposed - previous;
  const snapshot = row.import_kind === "current_roster" ? {
    previousDate: row.previous_snapshot_date instanceof Date
      ? row.previous_snapshot_date.toISOString().slice(0, 10)
      : row.previous_snapshot_date?.slice(0, 10) ?? null,
    previous,
    proposed,
    entering: count(row.entering_snapshot),
    leaving: count(row.leaving_snapshot),
    net,
    percentChange: previous ? (net / previous) * 100 : null,
  } : null;
  const rejected = count(row.rejected_rows) || count(row.rejected);
  const blockingErrors = count(row.blocking_error_count);
  return {
    counts: {
      total: count(row.total_rows) || included + (excluded ?? 0),
      included,
      excluded,
      rejected,
      blockingErrors,
      unchangedExisting: count(row.unchanged_existing),
      existingWithChanges: existingChanges,
      proposedNew,
      needsAttention: count(row.needs_attention),
      metadataComplete: row.total_rows != null && row.included_rows != null && row.excluded_rows != null,
    },
    hashes: { proposedNew: row.eligible_new_set_hash, existingChanges: row.existing_changes_set_hash },
    decisions: { proposedNew: proposedAccepted, existingChanges: changesAccepted, migrationPending },
    clicksRequired: Number(proposedNew > 0) + Number(existingChanges > 0),
    blockers: count(row.needs_attention) + rejected + count(row.unassociated_blocking_error_count),
    snapshot,
  };
}

export async function getProtectedImportReviewDetail(
  actor: ImportReviewActor,
  batchId: string,
  input: { category?: unknown; search?: unknown; cursor?: unknown; pageSize?: unknown },
  dependencies: { query?: DatabaseQuery; keyConfig?: PiiKeyConfiguration; env?: NodeJS.ProcessEnv } = {},
): Promise<ImportReviewDetail> {
  requireReviewer(actor);
  requireBatchId(batchId);
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(dependencies.env ?? process.env);
  const selected = category(input.category);
  const search = typeof input.search === "string" ? input.search.trim().slice(0, 100) : "";
  const searchIndexes = protectedSearchIndexes(actor.organizationId, search, keyConfig);
  const pageCursor = cursor(input.cursor);
  const requested = Number(input.pageSize);
  const pageSize = [25, 50, 100].includes(requested) ? Math.min(requested, IMPORT_REVIEW_MAX_PAGE_SIZE) : IMPORT_REVIEW_PAGE_SIZE;
  const rows = await query<DetailRow>(`WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}, search_indexes AS (
      SELECT value.domain, value.key_version, value.hash
      FROM jsonb_to_recordset($5::text::jsonb) AS value(domain text, key_version text, hash text)
    )
    SELECT import_row_id, sheet_name, source_row_number, category,
      NULL::text AS first_name, NULL::text AS last_name, NULL::text AS work_email,
      NULL::text AS personal_email, NULL::text AS work_phone,
      normalized_json ->> 'department' AS department,
      normalized_json ->> 'classification' AS classification,
      normalized_json ->> 'membership_status' AS membership_status,
      person_id
    FROM categorized
    WHERE category = $3
      AND ($4::text IS NULL
        OR concat_ws(' ', normalized_json ->> 'department', normalized_json ->> 'classification', normalized_json ->> 'work_location') ILIKE $4 ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM local801.pii_exact_indexes imported
          JOIN search_indexes search
            ON search.domain = imported.index_domain
            AND search.key_version = imported.index_key_version
            AND search.hash = imported.index_hash
          WHERE imported.organization_id = $1::uuid
            AND imported.entity_type = 'import_row'
            AND imported.entity_id = categorized.import_row_id
        ))
      AND ($6::text IS NULL OR (sheet_name, source_row_number, import_row_id) > ($6::text, $7::integer, $8::uuid))
    ORDER BY sheet_name, source_row_number, import_row_id LIMIT $9::integer`, [
    actor.organizationId,
    batchId,
    selected,
    search ? escapeLike(search) : null,
    JSON.stringify(searchIndexes),
    pageCursor?.sheet ?? null,
    pageCursor?.row ?? null,
    pageCursor?.id ?? null,
    pageSize + 1,
  ]);
  const hasNext = rows.length > pageSize;
  const bounded = rows.slice(0, pageSize);
  return {
    rows: bounded.map(({ import_row_id: _rowId, person_id: _personId, ...item }) => item),
    nextCursor: hasNext ? encodeCursor(bounded.at(-1)!) : null,
    pageSize,
  };
}

function decisionCategory(type: ImportReviewDecisionType) {
  return type === "allow_proposed_new" ? "proposed_new" : "existing_with_changes";
}

function decisionEvent(type: ImportReviewDecisionType): AuditEventType {
  return type === "allow_proposed_new" ? "import.review_new_people" : "import.review_existing_changes";
}

export async function setProtectedImportReviewDecision(
  actor: ImportReviewActor,
  batchId: string,
  type: ImportReviewDecisionType,
  expectedHash: string,
  dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  requireReviewer(actor);
  requireBatchId(batchId);
  if (!HASH_RE.test(expectedHash)) throw new Error("Invalid review decision.");
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const selected = decisionCategory(type);
  const mutation: DatabaseStatement = {
    sql: `WITH ${PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE}, ${IMPORT_REVIEW_TOKEN_CTE}, current_set AS (
      SELECT encode(public.digest(COALESCE(string_agg(canonical_token, ':' ORDER BY canonical_token), ''), 'sha256'), 'hex') AS set_hash,
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
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS decision_saved FROM saved`,
    parameters: [actor.organizationId, batchId, selected, type, actor.userId, expectedHash],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: decisionEvent(type),
    actorId: actor.userId,
    organizationId: actor.organizationId,
    subjectType: "import_batch",
    subjectId: batchId,
    payload: { decisionType: type },
  }, query);
  await transaction([mutation, audit]);
}
