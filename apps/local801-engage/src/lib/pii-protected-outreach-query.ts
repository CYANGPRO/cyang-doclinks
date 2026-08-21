import "server-only";

import { createHash } from "node:crypto";
import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { OutreachQueuePage, OutreachQueuePerson, OutreachSearchInput } from "./outreach.ts";
import { getEffectiveOutreachScope, normalizeOutreachSearch } from "./outreach.ts";
import {
  createPiiBlindIndex,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiNameForSearch,
  openPiiCursor,
  PiiProtectionError,
  sealPiiCursor,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import { assertPiiProtectedReadState, getPiiProtectedReadMode, PiiProtectedReadError } from "./pii-protected-read.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const CANDIDATE_CAP = 25_000;
const CURSOR_PURPOSE = "outreach-priority-v1";

type CandidateRow = {
  person_id: string;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  is_primary: boolean | null;
  is_backup: boolean | null;
  latest_engagement_at: string | Date | null;
  latest_outcome: string | null;
  open_followup_count: unknown;
  overdue_followup_count: unknown;
  next_followup_at: string | Date | null;
  willing_action_count: unknown;
  considering_action_count: unknown;
  completed_action_count: unknown;
  declines_all_actions: boolean | null;
  priority_rank: unknown;
  sort_due: unknown;
  sort_engagement: unknown;
  name_sort_encrypted_payload: string;
  name_sort_encryption_key_version: string;
  name_sort_encryption_format_version: number;
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

type ContactRow = {
  person_id: string;
  contact_method_id: string;
  contact_value_encrypted_payload: string;
  encryption_key_version: string;
  encryption_format_version: number;
};

type Cursor = { priority: number; due: number; engagement: number; sort: string; id: string };
type SearchToken = { key_version: string; hash: string };
type SearchMaterial = { tokens: SearchToken[]; email: { key_version: string; hash: string } | null };

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function encrypted(row: Record<string, unknown>, payload: string, key: string, format: string) {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    blocked("ENVELOPE_INVALID", "A protected Outreach record has an invalid encrypted field.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 } satisfies Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion">;
}

function handle(organizationId: string, personId: string) {
  return createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
}

function finiteInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function normalizeTimestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function membership(value: unknown): OutreachQueuePerson["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : "unknown";
}

function relationship(row: CandidateRow): OutreachQueuePerson["assignmentRelationship"] {
  if (row.is_primary) return "primary";
  if (row.is_backup) return "backup";
  return "authorized";
}

function priority(value: unknown): OutreachQueuePerson["priority"] {
  switch (Number(value)) {
    case 1: return "overdue_followup";
    case 2: return "due_today";
    case 3: return "never_engaged";
    case 4: return "stale_90_days";
    case 5: return "upcoming";
    default: return "recent";
  }
}

function searchMaterial(term: string, organizationId: string, config: PiiKeyConfiguration): SearchMaterial {
  if (!term) return { tokens: [], email: null };
  const words = normalizePiiNameForSearch(term).split(" ").filter((word) => Array.from(word).length >= 3);
  const tokens = words.map((word) => {
    const prefix = Array.from(word).slice(0, 20).join("");
    const index = createPiiBlindIndex(prefix, { organizationId, domain: "search:combined-name:prefix" }, config);
    return { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  });
  let email: SearchMaterial["email"] = null;
  try {
    const index = createPiiBlindIndex(normalizePiiEmail(term), { organizationId, domain: "contact:work-email" }, config);
    email = { key_version: index.blindIndexKeyVersion, hash: index.blindIndex };
  } catch (error) {
    if (!(error instanceof PiiProtectionError) || error.code !== "NORMALIZATION_FAILED") throw error;
  }
  return { tokens, email };
}

function decodeCursor(raw: unknown, organizationId: string, config: PiiKeyConfiguration): Cursor | null {
  const value = scalarString(raw);
  if (!value) return null;
  try {
    const parsed = openPiiCursor<Cursor>(value, { organizationId, purpose: CURSOR_PURPOSE }, config);
    return parsed && Number.isInteger(parsed.priority) && parsed.priority >= 1 && parsed.priority <= 6
      && Number.isFinite(parsed.due) && Number.isFinite(parsed.engagement)
      && typeof parsed.sort === "string" && parsed.sort.length <= 1000
      && typeof parsed.id === "string" && /^[0-9a-f-]{36}$/i.test(parsed.id) ? parsed : null;
  } catch (error) {
    if (error instanceof PiiProtectionError && ["CURSOR_INVALID", "CURSOR_EXPIRED", "KEY_NOT_FOUND"].includes(error.code)) return null;
    throw error;
  }
}

function key(row: { row: CandidateRow; sort: string }) {
  return [Number(row.row.priority_rank), Number(row.row.sort_due), Number(row.row.sort_engagement), row.sort, row.row.person_id] as const;
}

function compareKey(left: readonly [number, number, number, string, string], right: readonly [number, number, number, string, string]) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    || left[3].localeCompare(right[3]) || left[4].localeCompare(right[4]);
}

export async function getProtectedOutreachQueue(
  context: WorkspaceContext,
  input: OutreachSearchInput,
  query: DatabaseQuery = queryLocal801,
): Promise<OutreachQueuePage> {
  if (!can(context.role, "recordEngagement")) throw new Error("Outreach access is forbidden.");
  const mode = getPiiProtectedReadMode();
  if (mode === "legacy") blocked("PROTECTED_READ_OFF", "Protected Outreach query called while protected reads are disabled.");
  await assertPiiProtectedReadState(context.organizationId, query, mode);
  const config = getPiiKeyConfiguration();
  const normalized = normalizeOutreachSearch({ ...input, cursor: undefined });
  const effectiveScope = getEffectiveOutreachScope(context.role, normalized.requestedScope);
  const organizationWide = effectiveScope === "authorized";
  const search = searchMaterial(normalized.term, context.organizationId, config);
  const operationalPattern = normalized.term
    ? `%${normalized.term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    : null;
  const cursor = decodeCursor(input.cursor, context.organizationId, config);

  const rows = await query<CandidateRow>(`
    /* pii-protected-outreach:priority-candidates */
    WITH search_tokens AS (
      SELECT token.key_version, token.hash
      FROM jsonb_to_recordset($8::text::jsonb) AS token(key_version text, hash text)
    ), base_people AS (
      SELECT person.id AS person_id, person.membership_status, person.department, person.classification,
        person.work_location,
        protected.name_sort_encrypted_payload, protected.name_sort_encryption_key_version, protected.name_sort_encryption_format_version,
        protected.first_name_encrypted_payload, protected.first_name_encryption_key_version, protected.first_name_encryption_format_version,
        protected.last_name_encrypted_payload, protected.last_name_encryption_key_version, protected.last_name_encryption_format_version,
        protected.preferred_name_encrypted_payload, protected.preferred_name_encryption_key_version, protected.preferred_name_encryption_format_version
      FROM local801.people person
      JOIN local801.person_pii protected
        ON protected.organization_id = person.organization_id AND protected.person_id = person.id
      WHERE person.organization_id = $1::uuid AND person.archived_at IS NULL
        AND ($3::boolean OR EXISTS (
          SELECT 1 FROM local801.engagement_assignments scope_assignment
          WHERE scope_assignment.organization_id = $1::uuid AND scope_assignment.person_id = person.id
            AND scope_assignment.archived_at IS NULL AND scope_assignment.status = 'open'
            AND (scope_assignment.primary_user_id = $2::uuid OR scope_assignment.backup_user_id = $2::uuid)
        ))
        AND ($4::text IS NULL
          OR person.department ILIKE $4::text ESCAPE '\\'
          OR person.classification ILIKE $4::text ESCAPE '\\'
          OR person.work_location ILIKE $4::text ESCAPE '\\'
          OR (jsonb_array_length($8::text::jsonb) > 0 AND NOT EXISTS (
            SELECT 1 FROM search_tokens wanted
            WHERE NOT EXISTS (
              SELECT 1 FROM local801.person_search_tokens stored
              WHERE stored.organization_id = $1::uuid AND stored.person_id = person.id
                AND stored.token_domain = 'combined_name' AND stored.token_kind = 'prefix'
                AND stored.token_key_version = wanted.key_version AND stored.token_hash = wanted.hash
            )
          ))
          OR ($6::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM local801.person_contact_methods contact
            JOIN local801.pii_exact_indexes email_index
              ON email_index.organization_id = contact.organization_id
              AND email_index.entity_type = 'person_contact_method'
              AND email_index.entity_id = contact.id
              AND email_index.index_domain = 'contact:work-email'
              AND email_index.index_key_version = $6::text AND email_index.index_hash = $7::text
            WHERE contact.organization_id = $1::uuid AND contact.person_id = person.id
              AND contact.contact_type = 'work_email' AND contact.archived_at IS NULL
          )))
    ), signals AS (
      SELECT base.*,
        COALESCE(assignment_info.is_primary, false) AS is_primary,
        COALESCE(assignment_info.is_backup, false) AS is_backup,
        assignment_info.assignment_due_at,
        latest_event.occurred_at AS latest_engagement_at,
        latest_event.outcome AS latest_outcome,
        COALESCE(followup.open_count, 0) AS open_followup_count,
        COALESCE(followup.overdue_count, 0) AS overdue_followup_count,
        followup.next_due_at AS next_followup_at,
        COALESCE(readiness.willing_action_count, 0) AS willing_action_count,
        COALESCE(readiness.considering_action_count, 0) AS considering_action_count,
        COALESCE(readiness.completed_action_count, 0) AS completed_action_count,
        COALESCE(readiness.declines_all_actions, false) AS declines_all_actions
      FROM base_people base
      LEFT JOIN LATERAL (
        SELECT bool_or(assignment.primary_user_id = $2::uuid) AS is_primary,
          bool_or(assignment.backup_user_id = $2::uuid) AS is_backup,
          min(assignment.due_at) FILTER (WHERE assignment.due_at IS NOT NULL) AS assignment_due_at
        FROM local801.engagement_assignments assignment
        WHERE assignment.organization_id = $1::uuid AND assignment.person_id = base.person_id
          AND assignment.archived_at IS NULL AND assignment.status = 'open'
      ) assignment_info ON true
      LEFT JOIN LATERAL (
        SELECT event.occurred_at, event.outcome
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid AND event.person_id = base.person_id AND event.voided_at IS NULL
        ORDER BY event.occurred_at DESC, event.id DESC LIMIT 1
      ) latest_event ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL) AS open_count,
          count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL AND item.due_at < now()) AS overdue_count,
          min(item.due_at) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL) AS next_due_at
        FROM local801.engagement_followups item
        WHERE item.organization_id = $1::uuid AND item.person_id = base.person_id
      ) followup ON true
      LEFT JOIN reporting.employee_action_person_readiness readiness
        ON readiness.organization_id = $1::uuid AND readiness.person_id = base.person_id
    ), prioritized AS (
      SELECT signals.*,
        CASE
          WHEN overdue_followup_count > 0 THEN 1
          WHEN next_followup_at >= date_trunc('day', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'
           AND next_followup_at < (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago' THEN 2
          WHEN latest_engagement_at IS NULL THEN 3
          WHEN latest_engagement_at < now() - interval '90 days' THEN 4
          WHEN next_followup_at IS NOT NULL OR assignment_due_at IS NOT NULL THEN 5
          ELSE 6
        END AS priority_rank,
        COALESCE(extract(epoch FROM next_followup_at), extract(epoch FROM assignment_due_at), 32503680000)::double precision AS sort_due,
        (-COALESCE(extract(epoch FROM latest_engagement_at), 0))::double precision AS sort_engagement
      FROM signals
    )
    SELECT * FROM prioritized
    WHERE $5::text = 'all'
       OR ($5::text = 'attention' AND priority_rank <= 4)
       OR ($5::text = 'never-engaged' AND priority_rank = 3)
       OR ($5::text = 'stale' AND priority_rank = 4)
    ORDER BY person_id
    LIMIT ${CANDIDATE_CAP + 1}
  `, [
    context.organizationId,
    context.userId,
    organizationWide,
    operationalPattern,
    normalized.focus,
    search.email?.key_version ?? null,
    search.email?.hash ?? null,
    JSON.stringify(search.tokens),
  ]);
  if (rows.length > CANDIDATE_CAP) {
    blocked("OUTREACH_CANDIDATE_CAP", "The protected Outreach candidate set is too large. Narrow the search or focus.");
  }

  let candidates = rows.map((row) => {
    const sort = decryptPiiField(
      encrypted(row as unknown as Record<string, unknown>, "name_sort_encrypted_payload", "name_sort_encryption_key_version", "name_sort_encryption_format_version"),
      { organizationId: context.organizationId, entity: "person", recordId: row.person_id, field: "name-sort" }, config,
    );
    return { row, sort };
  });
  candidates.sort((left, right) => compareKey(key(left), key(right)));
  const total = candidates.length;
  if (cursor) {
    const cursorKey = [cursor.priority, cursor.due, cursor.engagement, cursor.sort, cursor.id] as const;
    candidates = candidates.filter((item) => compareKey(key(item), cursorKey) > 0);
  }
  const hasNext = candidates.length > normalized.pageSize;
  const page = candidates.slice(0, normalized.pageSize);
  const pageIds = page.map((item) => item.row.person_id);
  const contacts = pageIds.length ? await query<ContactRow>(`
    /* pii-protected-outreach:page-work-email */
    WITH requested AS (
      SELECT value.person_id::uuid AS person_id
      FROM jsonb_to_recordset($3::text::jsonb) AS value(person_id text)
    )
    SELECT DISTINCT ON (contact.person_id) contact.person_id::text, contact.id::text AS contact_method_id,
      protected.contact_value_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM requested
    JOIN local801.person_contact_methods contact
      ON contact.organization_id = $1::uuid AND contact.person_id = requested.person_id
      AND contact.contact_type = 'work_email' AND contact.is_primary = true AND contact.archived_at IS NULL
    JOIN local801.person_contact_method_pii protected
      ON protected.organization_id = contact.organization_id AND protected.contact_method_id = contact.id
    WHERE contact.visibility = 'authorized_directory'
      OR (contact.visibility = 'assigned_only' AND EXISTS (
        SELECT 1 FROM local801.engagement_assignments assignment
        WHERE assignment.organization_id = $1::uuid AND assignment.person_id = contact.person_id
          AND assignment.archived_at IS NULL AND assignment.status = 'open'
          AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
      ))
    ORDER BY contact.person_id, contact.created_at, contact.id
  `, [context.organizationId, context.userId, JSON.stringify(pageIds.map((person_id) => ({ person_id })))]) : [];
  const contactByPerson = new Map(contacts.map((row) => [row.person_id, row]));

  const people = page.map((item) => {
    const row = item.row;
    const source = row as unknown as Record<string, unknown>;
    const firstName = decryptPiiField(
      encrypted(source, "first_name_encrypted_payload", "first_name_encryption_key_version", "first_name_encryption_format_version"),
      { organizationId: context.organizationId, entity: "person", recordId: row.person_id, field: "first-name" }, config,
    );
    const lastName = decryptPiiField(
      encrypted(source, "last_name_encrypted_payload", "last_name_encryption_key_version", "last_name_encryption_format_version"),
      { organizationId: context.organizationId, entity: "person", recordId: row.person_id, field: "last-name" }, config,
    );
    let preferredName: string | null = null;
    if (row.preferred_name_encrypted_payload !== null) {
      preferredName = decryptPiiField(
        encrypted(source, "preferred_name_encrypted_payload", "preferred_name_encryption_key_version", "preferred_name_encryption_format_version"),
        { organizationId: context.organizationId, entity: "person", recordId: row.person_id, field: "preferred-name" }, config,
      );
    }
    const contact = contactByPerson.get(row.person_id);
    const workEmail = contact ? decryptPiiField(
      encrypted(contact as unknown as Record<string, unknown>, "contact_value_encrypted_payload", "encryption_key_version", "encryption_format_version"),
      { organizationId: context.organizationId, entity: "person-contact", recordId: contact.contact_method_id, field: "contact-value" }, config,
    ) : null;
    return {
      handle: handle(context.organizationId, row.person_id),
      displayName: preferredName?.trim() || `${firstName} ${lastName}`,
      membershipStatus: membership(row.membership_status),
      department: row.department,
      classification: row.classification,
      workLocation: row.work_location,
      workEmail,
      assignmentRelationship: relationship(row),
      priority: priority(row.priority_rank),
      latestEngagementAt: normalizeTimestamp(row.latest_engagement_at),
      latestOutcome: row.latest_outcome,
      openFollowupCount: finiteInteger(row.open_followup_count),
      overdueFollowupCount: finiteInteger(row.overdue_followup_count),
      nextFollowupAt: normalizeTimestamp(row.next_followup_at),
      willingActionCount: finiteInteger(row.willing_action_count),
      consideringActionCount: finiteInteger(row.considering_action_count),
      completedActionCount: finiteInteger(row.completed_action_count),
      declinesAllActions: Boolean(row.declines_all_actions),
    } satisfies OutreachQueuePerson;
  });

  const last = page.at(-1);
  return {
    people,
    term: normalized.term,
    requestedScope: normalized.requestedScope,
    effectiveScope,
    focus: normalized.focus,
    pageSize: normalized.pageSize,
    total,
    previousCursor: null,
    nextCursor: hasNext && last ? sealPiiCursor({
      priority: Number(last.row.priority_rank),
      due: Number(last.row.sort_due),
      engagement: Number(last.row.sort_engagement),
      sort: last.sort,
      id: last.row.person_id,
    }, { organizationId: context.organizationId, purpose: CURSOR_PURPOSE }, config) : null,
  };
}
