import "server-only";

import { createHash } from "node:crypto";
import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import { getEmployeeActionProfile, type EmployeeActionProfile } from "./employee-actions.ts";
import { listRecentEngagementHistory, type RecentEngagementHistoryItem } from "./engagement-notes.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DEFAULT_OUTREACH_PAGE_SIZE = 25;
export const MAX_OUTREACH_PAGE_SIZE = 50;
export const OUTREACH_PAGE_SIZES = [25, 50] as const;
export const MAX_OUTREACH_SEARCH_LENGTH = 100;

export type OutreachScope = "assigned" | "authorized";
export type OutreachFocus = "all" | "attention" | "never-engaged" | "stale";
export type OutreachPriority = "overdue_followup" | "due_today" | "never_engaged" | "stale_90_days" | "upcoming" | "recent";

type OutreachCursor = {
  priority: number;
  due: number;
  engagement: number;
  lastName: string;
  firstName: string;
  handle: string;
};

export type OutreachSearchInput = {
  term?: unknown;
  scope?: unknown;
  focus?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

export type NormalizedOutreachSearch = {
  term: string;
  requestedScope: OutreachScope;
  focus: OutreachFocus;
  pageSize: number;
  cursor: OutreachCursor | null;
};

export type OutreachQueuePerson = {
  handle: string;
  displayName: string;
  membershipStatus: "member" | "nonmember" | "unknown";
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  workEmail: string | null;
  assignmentRelationship: "primary" | "backup" | "authorized";
  priority: OutreachPriority;
  latestEngagementAt: string | null;
  latestOutcome: string | null;
  openFollowupCount: number;
  overdueFollowupCount: number;
  nextFollowupAt: string | null;
  willingActionCount: number;
  consideringActionCount: number;
  completedActionCount: number;
  declinesAllActions: boolean;
};

export type OutreachQueuePage = {
  people: OutreachQueuePerson[];
  term: string;
  requestedScope: OutreachScope;
  effectiveScope: OutreachScope;
  focus: OutreachFocus;
  pageSize: number;
  total: number;
  previousCursor: string | null;
  nextCursor: string | null;
};

export type OutreachWorkspace = {
  handle: string;
  displayName: string;
  membershipStatus: "member" | "nonmember" | "unknown";
  department: string | null;
  section: string | null;
  classification: string | null;
  workLocation: string | null;
  workEmail: string | null;
  assignmentRelationship: "primary" | "backup" | "authorized";
  activeAssignmentCount: number;
  campaignNames: string[];
  actionReadiness: EmployeeActionProfile;
  followups: Array<{
    handle: string;
    dueAt: string;
    assignee: string | null;
    overdue: boolean;
  }>;
  recentEngagements: RecentEngagementHistoryItem[];
};

type QueueRow = {
  person_id: string | null;
  preferred_name: string | null;
  first_name: string | null;
  last_name: string | null;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  work_email: string | null;
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
  person_handle: string | null;
  total_count: unknown;
};

type WorkspaceRow = {
  person_id: string;
  person_handle: string;
  preferred_name: string | null;
  first_name: string;
  last_name: string;
  membership_status: string;
  department: string | null;
  section: string | null;
  classification: string | null;
  work_location: string | null;
  work_email: string | null;
  is_primary: boolean;
  is_backup: boolean;
  active_assignment_count: unknown;
  campaign_names: string[] | null;
};

type FollowupRow = {
  id: string;
  due_at: string | Date;
  assignee: string | null;
  overdue: boolean;
};


const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin"]);
const HANDLE_RE = /^[0-9a-f]{64}$/i;

export class OutreachAccessError extends Error {
  constructor(message = "Outreach access is forbidden.") {
    super(message);
    this.name = "OutreachAccessError";
  }
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function finiteInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function normalizeTimestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMembership(value: unknown): OutreachQueuePerson["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : "unknown";
}

function normalizePageSize(value: unknown) {
  const parsed = Number(scalarString(value));
  return parsed === 50 ? 50 : DEFAULT_OUTREACH_PAGE_SIZE;
}

function normalizeHandle(value: unknown) {
  const handle = scalarString(value).trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new OutreachAccessError("Employee workspace is not available.");
  return handle;
}

function decodeCursor(value: unknown): OutreachCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 1000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<OutreachCursor>;
    if (!Number.isInteger(parsed.priority) || parsed.priority! < 1 || parsed.priority! > 6
      || typeof parsed.due !== "number" || !Number.isFinite(parsed.due)
      || typeof parsed.engagement !== "number" || !Number.isFinite(parsed.engagement)
      || typeof parsed.lastName !== "string" || parsed.lastName.length > 200
      || typeof parsed.firstName !== "string" || parsed.firstName.length > 200
      || typeof parsed.handle !== "string" || !HANDLE_RE.test(parsed.handle)) return null;
    return {
      priority: parsed.priority!,
      due: parsed.due,
      engagement: parsed.engagement,
      lastName: parsed.lastName,
      firstName: parsed.firstName,
      handle: parsed.handle.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function encodeCursor(row: QueueRow) {
  return Buffer.from(JSON.stringify({
    priority: Number(row.priority_rank),
    due: Number(row.sort_due),
    engagement: Number(row.sort_engagement),
    lastName: row.last_name!,
    firstName: row.first_name!,
    handle: row.person_handle!,
  } satisfies OutreachCursor), "utf8").toString("base64url");
}

export function normalizeOutreachSearch(input: OutreachSearchInput): NormalizedOutreachSearch {
  const rawScope = scalarString(input.scope);
  const rawFocus = scalarString(input.focus);
  const focus: OutreachFocus = rawFocus === "attention" || rawFocus === "never-engaged" || rawFocus === "stale" ? rawFocus : "all";
  return {
    term: scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_OUTREACH_SEARCH_LENGTH),
    requestedScope: rawScope === "authorized" ? "authorized" : "assigned",
    focus,
    pageSize: normalizePageSize(input.pageSize),
    cursor: decodeCursor(input.cursor),
  };
}

export function getEffectiveOutreachScope(role: Role, requested: OutreachScope): OutreachScope {
  if (!can(role, "recordEngagement")) throw new OutreachAccessError();
  return organizationWideRoles.has(role) ? requested : "assigned";
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function like(value: string) {
  return value ? `%${escapeLikePattern(value)}%` : null;
}

function priorityLabel(value: unknown): OutreachPriority {
  switch (Number(value)) {
    case 1: return "overdue_followup";
    case 2: return "due_today";
    case 3: return "never_engaged";
    case 4: return "stale_90_days";
    case 5: return "upcoming";
    default: return "recent";
  }
}

function relationship(row: Pick<QueueRow, "is_primary" | "is_backup">): OutreachQueuePerson["assignmentRelationship"] {
  if (row.is_primary) return "primary";
  if (row.is_backup) return "backup";
  return "authorized";
}

function displayName(preferred: string | null, first: string, last: string) {
  return preferred?.trim() || `${first} ${last}`;
}

export function outreachHandle(organizationId: string, personId: string) {
  return createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
}

export async function getOutreachQueue(
  context: WorkspaceContext,
  input: OutreachSearchInput,
  query: DatabaseQuery = queryLocal801,
): Promise<OutreachQueuePage> {
  if (!can(context.role, "recordEngagement")) throw new OutreachAccessError();
  const normalized = normalizeOutreachSearch(input);
  const effectiveScope = getEffectiveOutreachScope(context.role, normalized.requestedScope);
  const organizationWide = effectiveScope === "authorized";
  const cursor = normalized.cursor;

  const rows = await query<QueueRow>(`
    /* outreach:priority-queue */
    WITH base_people AS (
      SELECT
        person.id AS person_id,
        person.preferred_name,
        person.first_name,
        person.last_name,
        person.membership_status,
        person.department,
        person.classification,
        person.work_location
      FROM local801.people person
      WHERE person.organization_id = $1::uuid
        AND person.archived_at IS NULL
        AND (
          $3::boolean
          OR EXISTS (
            SELECT 1
            FROM local801.engagement_assignments scope_assignment
            WHERE scope_assignment.organization_id = $1::uuid
              AND scope_assignment.person_id = person.id
              AND scope_assignment.archived_at IS NULL
              AND scope_assignment.status = 'open'
              AND (scope_assignment.primary_user_id = $2::uuid OR scope_assignment.backup_user_id = $2::uuid)
          )
        )
    ), signals AS (
      SELECT
        base.*,
        contact.contact_value AS work_email,
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
        SELECT
          bool_or(assignment.primary_user_id = $2::uuid) AS is_primary,
          bool_or(assignment.backup_user_id = $2::uuid) AS is_backup,
          min(assignment.due_at) FILTER (WHERE assignment.due_at IS NOT NULL) AS assignment_due_at
        FROM local801.engagement_assignments assignment
        WHERE assignment.organization_id = $1::uuid
          AND assignment.person_id = base.person_id
          AND assignment.archived_at IS NULL
          AND assignment.status = 'open'
      ) assignment_info ON true
      LEFT JOIN LATERAL (
        SELECT method.contact_value
        FROM local801.person_contact_methods method
        WHERE method.organization_id = $1::uuid
          AND method.person_id = base.person_id
          AND method.contact_type = 'work_email'
          AND method.is_primary = true
          AND method.archived_at IS NULL
          AND (
            method.visibility = 'authorized_directory'
            OR (
              method.visibility = 'assigned_only'
              AND EXISTS (
                SELECT 1
                FROM local801.engagement_assignments contact_assignment
                WHERE contact_assignment.organization_id = $1::uuid
                  AND contact_assignment.person_id = base.person_id
                  AND contact_assignment.archived_at IS NULL
                  AND contact_assignment.status = 'open'
                  AND (contact_assignment.primary_user_id = $2::uuid OR contact_assignment.backup_user_id = $2::uuid)
              )
            )
          )
        ORDER BY method.created_at ASC, method.id ASC
        LIMIT 1
      ) contact ON true
      LEFT JOIN LATERAL (
        SELECT event.occurred_at, event.outcome
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid
          AND event.person_id = base.person_id
          AND event.voided_at IS NULL
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 1
      ) latest_event ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL) AS open_count,
          count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL AND item.due_at < now()) AS overdue_count,
          min(item.due_at) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL) AS next_due_at
        FROM local801.engagement_followups item
        WHERE item.organization_id = $1::uuid
          AND item.person_id = base.person_id
      ) followup ON true
      LEFT JOIN reporting.employee_action_person_readiness readiness
        ON readiness.organization_id = $1::uuid
       AND readiness.person_id = base.person_id
      WHERE (
        $4::text IS NULL
        OR base.first_name ILIKE $4 ESCAPE '\\'
        OR base.last_name ILIKE $4 ESCAPE '\\'
        OR base.preferred_name ILIKE $4 ESCAPE '\\'
        OR base.department ILIKE $4 ESCAPE '\\'
        OR base.classification ILIKE $4 ESCAPE '\\'
        OR base.work_location ILIKE $4 ESCAPE '\\'
        OR contact.contact_value ILIKE $4 ESCAPE '\\'
      )
    ), prioritized AS (
      SELECT
        signals.*,
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
        (-COALESCE(extract(epoch FROM latest_engagement_at), 0))::double precision AS sort_engagement,
        encode(digest($1::text || ':' || person_id::text, 'sha256'), 'hex') AS person_handle
      FROM signals
    ), focused AS (
      SELECT *
      FROM prioritized
      WHERE $5::text = 'all'
         OR ($5::text = 'attention' AND priority_rank <= 4)
         OR ($5::text = 'never-engaged' AND priority_rank = 3)
         OR ($5::text = 'stale' AND priority_rank = 4)
    ), total AS (
      SELECT count(*) AS total_count FROM focused
    ), page_rows AS (
      SELECT *
      FROM focused
      WHERE $7::integer IS NULL
         OR (priority_rank, sort_due, sort_engagement, last_name, first_name, person_handle)
            > ($7::integer, $8::double precision, $9::double precision, $10::text, $11::text, $12::text)
      ORDER BY priority_rank ASC, sort_due ASC, sort_engagement ASC, last_name ASC, first_name ASC, person_handle ASC
      LIMIT $6::integer
    )
    SELECT page_rows.*, total.total_count
    FROM total
    LEFT JOIN page_rows ON true
    ORDER BY page_rows.priority_rank ASC, page_rows.sort_due ASC, page_rows.sort_engagement ASC,
             page_rows.last_name ASC, page_rows.first_name ASC, page_rows.person_handle ASC
  `, [
    context.organizationId,
    context.userId,
    organizationWide,
    like(normalized.term),
    normalized.focus,
    normalized.pageSize + 1,
    cursor?.priority ?? null,
    cursor?.due ?? null,
    cursor?.engagement ?? null,
    cursor?.lastName ?? null,
    cursor?.firstName ?? null,
    cursor?.handle ?? null,
  ]);

  const total = finiteInteger(rows[0]?.total_count);
  const dataRows = rows.filter((row) => row.person_id && row.person_handle && row.first_name && row.last_name);
  const hasNext = dataRows.length > normalized.pageSize;
  const pageRows = dataRows.slice(0, normalized.pageSize);
  const people = pageRows.map((row) => ({
    handle: row.person_handle!,
    displayName: displayName(row.preferred_name, row.first_name!, row.last_name!),
    membershipStatus: normalizeMembership(row.membership_status),
    department: row.department,
    classification: row.classification,
    workLocation: row.work_location,
    workEmail: row.work_email,
    assignmentRelationship: relationship(row),
    priority: priorityLabel(row.priority_rank),
    latestEngagementAt: normalizeTimestamp(row.latest_engagement_at),
    latestOutcome: row.latest_outcome,
    openFollowupCount: finiteInteger(row.open_followup_count),
    overdueFollowupCount: finiteInteger(row.overdue_followup_count),
    nextFollowupAt: normalizeTimestamp(row.next_followup_at),
    willingActionCount: finiteInteger(row.willing_action_count),
    consideringActionCount: finiteInteger(row.considering_action_count),
    completedActionCount: finiteInteger(row.completed_action_count),
    declinesAllActions: Boolean(row.declines_all_actions),
  }));

  return {
    people,
    term: normalized.term,
    requestedScope: normalized.requestedScope,
    effectiveScope,
    focus: normalized.focus,
    pageSize: normalized.pageSize,
    total,
    previousCursor: cursor ? null : null,
    nextCursor: hasNext && pageRows.length ? encodeCursor(pageRows.at(-1)!) : null,
  };
}

export async function getOutreachWorkspace(
  context: WorkspaceContext,
  handleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<OutreachWorkspace> {
  if (!can(context.role, "recordEngagement")) throw new OutreachAccessError();
  const handle = normalizeHandle(handleInput);
  const organizationWide = organizationWideRoles.has(context.role);

  const [row] = await query<WorkspaceRow>(`
    /* outreach:employee-workspace */
    SELECT
      person.id AS person_id,
      encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') AS person_handle,
      person.preferred_name,
      person.first_name,
      person.last_name,
      person.membership_status,
      person.department,
      person.section,
      person.classification,
      person.work_location,
      contact.contact_value AS work_email,
      COALESCE(assignments.is_primary, false) AS is_primary,
      COALESCE(assignments.is_backup, false) AS is_backup,
      COALESCE(assignments.active_assignment_count, 0) AS active_assignment_count,
      COALESCE(assignments.campaign_names, ARRAY[]::text[]) AS campaign_names
    FROM local801.people person
    LEFT JOIN LATERAL (
      SELECT method.contact_value
      FROM local801.person_contact_methods method
      WHERE method.organization_id = $1::uuid
        AND method.person_id = person.id
        AND method.contact_type = 'work_email'
        AND method.is_primary = true
        AND method.archived_at IS NULL
        AND (
          method.visibility = 'authorized_directory'
          OR (
            method.visibility = 'assigned_only'
            AND EXISTS (
              SELECT 1
              FROM local801.engagement_assignments contact_assignment
              WHERE contact_assignment.organization_id = $1::uuid
                AND contact_assignment.person_id = person.id
                AND contact_assignment.archived_at IS NULL
                AND contact_assignment.status = 'open'
                AND (contact_assignment.primary_user_id = $2::uuid OR contact_assignment.backup_user_id = $2::uuid)
            )
          )
        )
      ORDER BY method.created_at ASC, method.id ASC
      LIMIT 1
    ) contact ON true
    LEFT JOIN LATERAL (
      SELECT
        bool_or(assignment.primary_user_id = $2::uuid) AS is_primary,
        bool_or(assignment.backup_user_id = $2::uuid) AS is_backup,
        count(*) AS active_assignment_count,
        array_agg(DISTINCT campaign.name ORDER BY campaign.name) FILTER (WHERE campaign.name IS NOT NULL) AS campaign_names
      FROM local801.engagement_assignments assignment
      LEFT JOIN local801.outreach_campaigns campaign
        ON campaign.id = assignment.campaign_id
       AND campaign.organization_id = $1::uuid
       AND campaign.status <> 'archived'
      WHERE assignment.organization_id = $1::uuid
        AND assignment.person_id = person.id
        AND assignment.archived_at IS NULL
        AND assignment.status = 'open'
    ) assignments ON true
    WHERE person.organization_id = $1::uuid
      AND person.archived_at IS NULL
      AND encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') = $3::text
      AND (
        $4::boolean
        OR EXISTS (
          SELECT 1
          FROM local801.engagement_assignments scope_assignment
          WHERE scope_assignment.organization_id = $1::uuid
            AND scope_assignment.person_id = person.id
            AND scope_assignment.archived_at IS NULL
            AND scope_assignment.status = 'open'
            AND (scope_assignment.primary_user_id = $2::uuid OR scope_assignment.backup_user_id = $2::uuid)
        )
      )
    LIMIT 1
  `, [context.organizationId, context.userId, handle, organizationWide]);

  if (!row) throw new OutreachAccessError("Employee workspace is not available.");

  const [actionReadiness, followups, engagements] = await Promise.all([
    getEmployeeActionProfile(context, row.person_id, query),
    query<FollowupRow>(`
      /* outreach:employee-followups */
      SELECT followup.id, followup.due_at, assignee.display_name AS assignee,
             (followup.due_at < now()) AS overdue
      FROM local801.engagement_followups followup
      LEFT JOIN local801.users assignee
        ON assignee.id = followup.assigned_to
       AND assignee.organization_id = $1::uuid
       AND assignee.deactivated_at IS NULL
      WHERE followup.organization_id = $1::uuid
        AND followup.person_id = $2::uuid
        AND followup.status = 'open'
        AND followup.completed_at IS NULL
      ORDER BY followup.due_at ASC
      LIMIT 25
    `, [context.organizationId, row.person_id]),
    listRecentEngagementHistory(context, row.person_id, query),
  ]);

  return {
    handle: row.person_handle,
    displayName: displayName(row.preferred_name, row.first_name, row.last_name),
    membershipStatus: normalizeMembership(row.membership_status),
    department: row.department,
    section: row.section,
    classification: row.classification,
    workLocation: row.work_location,
    workEmail: row.work_email,
    assignmentRelationship: relationship(row),
    activeAssignmentCount: finiteInteger(row.active_assignment_count),
    campaignNames: Array.isArray(row.campaign_names) ? row.campaign_names.filter((value): value is string => typeof value === "string") : [],
    actionReadiness,
    followups: followups.map((followup) => ({
      handle: createHash("sha256").update(`followup:${context.organizationId}:${followup.id}`).digest("hex"),
      dueAt: normalizeTimestamp(followup.due_at)!,
      assignee: followup.assignee,
      overdue: Boolean(followup.overdue),
    })),
    recentEngagements: engagements,
  };
}
