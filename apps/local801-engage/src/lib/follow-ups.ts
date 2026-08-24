import "server-only";

import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DEFAULT_FOLLOWUP_PAGE_SIZE = 25;
export const MAX_FOLLOWUP_PAGE_SIZE = 50;
export const MAX_FOLLOWUP_SEARCH_LENGTH = 100;
export type FollowupScope = "mine" | "authorized";
export type FollowupFocus = "all" | "overdue" | "today" | "upcoming" | "completed";

type FollowupCursor = {
  priority: number;
  sortTime: number;
  lastName: string;
  firstName: string;
  handle: string;
};

export type FollowupSearchInput = {
  term?: unknown;
  scope?: unknown;
  focus?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

export type FollowupAssigneeOption = {
  handle: string;
  label: string;
};

export type FollowupQueueItem = {
  employeeHandle: string;
  followupHandle: string;
  displayName: string;
  membershipStatus: "member" | "nonmember" | "unknown";
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  dueAt: string;
  completedAt: string | null;
  status: "open" | "completed";
  bucket: "overdue" | "today" | "upcoming" | "completed";
  assignedTo: string | null;
  assignedToHandle: string | null;
  assigneeOptions: FollowupAssigneeOption[];
  campaignName: string | null;
  latestEngagementAt: string | null;
  latestOutcome: string | null;
  willingActionCount: number;
  consideringActionCount: number;
  completedActionCount: number;
  declinesAllActions: boolean;
};

export type FollowupQueuePage = {
  items: FollowupQueueItem[];
  term: string;
  requestedScope: FollowupScope;
  effectiveScope: FollowupScope;
  focus: FollowupFocus;
  pageSize: number;
  total: number;
  nextCursor: string | null;
};

type FollowupRow = {
  followup_id: string | null;
  person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  due_at: string | Date | null;
  completed_at: string | Date | null;
  status: string | null;
  assigned_to_name: string | null;
  assigned_to_handle: string | null;
  assignee_options: unknown;
  campaign_name: string | null;
  latest_engagement_at: string | Date | null;
  latest_outcome: string | null;
  willing_action_count: unknown;
  considering_action_count: unknown;
  completed_action_count: unknown;
  declines_all_actions: boolean | null;
  priority_rank: unknown;
  sort_time: unknown;
  employee_handle: string | null;
  followup_handle: string | null;
  total_count: unknown;
};

const organizationWideRoles = new Set<Role>(["system_owner", "local_admin", "cat_admin", "cat_lead"]);
const HANDLE_RE = /^[0-9a-f]{64}$/i;

export class FollowupAccessError extends Error {
  constructor(message = "Follow-up access is forbidden.") {
    super(message);
    this.name = "FollowupAccessError";
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

function normalizeMembership(value: unknown): FollowupQueueItem["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : "unknown";
}

function normalizePageSize(value: unknown) {
  return Number(scalarString(value)) === 50 ? 50 : DEFAULT_FOLLOWUP_PAGE_SIZE;
}

function normalizeFocus(value: unknown): FollowupFocus {
  const focus = scalarString(value);
  return focus === "overdue" || focus === "today" || focus === "upcoming" || focus === "completed" ? focus : "all";
}

function normalizeScope(value: unknown): FollowupScope {
  return scalarString(value) === "authorized" ? "authorized" : "mine";
}

function decodeCursor(value: unknown): FollowupCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 1000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<FollowupCursor>;
    if (!Number.isInteger(parsed.priority) || parsed.priority! < 1 || parsed.priority! > 4
      || typeof parsed.sortTime !== "number" || !Number.isFinite(parsed.sortTime)
      || typeof parsed.lastName !== "string" || parsed.lastName.length > 200
      || typeof parsed.firstName !== "string" || parsed.firstName.length > 200
      || typeof parsed.handle !== "string" || !HANDLE_RE.test(parsed.handle)) return null;
    return {
      priority: parsed.priority!,
      sortTime: parsed.sortTime,
      lastName: parsed.lastName,
      firstName: parsed.firstName,
      handle: parsed.handle.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function encodeCursor(row: FollowupRow) {
  return Buffer.from(JSON.stringify({
    priority: Number(row.priority_rank),
    sortTime: Number(row.sort_time),
    lastName: row.last_name!,
    firstName: row.first_name!,
    handle: row.followup_handle!,
  } satisfies FollowupCursor), "utf8").toString("base64url");
}

export function getEffectiveFollowupScope(role: Role, requested: FollowupScope): FollowupScope {
  if (!can(role, "recordEngagement")) throw new FollowupAccessError();
  return organizationWideRoles.has(role) ? requested : "mine";
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function like(value: string) {
  return value ? `%${escapeLikePattern(value)}%` : null;
}

function displayName(preferredName: string | null, firstName: string, lastName: string) {
  const givenName = preferredName?.trim() || firstName.trim();
  const familyName = lastName.trim();
  const normalizedGivenName = givenName.toLocaleLowerCase("en-US");
  const normalizedFamilyName = familyName.toLocaleLowerCase("en-US");
  return normalizedGivenName === normalizedFamilyName || normalizedGivenName.endsWith(` ${normalizedFamilyName}`)
    ? givenName
    : `${givenName} ${familyName}`;
}

function bucketFromRank(value: unknown): FollowupQueueItem["bucket"] {
  switch (Number(value)) {
    case 1: return "overdue";
    case 2: return "today";
    case 3: return "upcoming";
    default: return "completed";
  }
}

function normalizeAssigneeOptions(value: unknown): FollowupAssigneeOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const options: FollowupAssigneeOption[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as { handle?: unknown; label?: unknown };
    if (typeof item.handle !== "string" || !HANDLE_RE.test(item.handle) || typeof item.label !== "string" || !item.label.trim()) continue;
    const handle = item.handle.toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    options.push({ handle, label: item.label.trim() });
  }
  return options;
}

export async function getFollowupQueue(
  context: WorkspaceContext,
  input: FollowupSearchInput,
  query: DatabaseQuery = queryLocal801,
): Promise<FollowupQueuePage> {
  if (!can(context.role, "recordEngagement")) throw new FollowupAccessError();

  const term = scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_FOLLOWUP_SEARCH_LENGTH);
  const requestedScope = normalizeScope(input.scope);
  const effectiveScope = getEffectiveFollowupScope(context.role, requestedScope);
  const focus = normalizeFocus(input.focus);
  const pageSize = normalizePageSize(input.pageSize);
  const cursor = decodeCursor(input.cursor);
  const organizationWide = effectiveScope === "authorized";

  const rows = await query<FollowupRow>(`
    /* follow-ups:operational-queue */
    WITH eligible AS (
      SELECT
        followup.id AS followup_id,
        followup.person_id,
        person.first_name,
        person.last_name,
        person.preferred_name,
        person.membership_status,
        person.department,
        person.classification,
        person.work_location,
        followup.due_at,
        followup.completed_at,
        followup.status,
        assignee.display_name AS assigned_to_name,
        CASE
          WHEN assignee.id IS NULL THEN NULL
          ELSE encode(public.digest('user:' || $1::text || ':' || assignee.id::text, 'sha256'), 'hex')
        END AS assigned_to_handle,
        edit_options.assignee_options,
        campaign.name AS campaign_name,
        latest.occurred_at AS latest_engagement_at,
        latest.outcome AS latest_outcome,
        COALESCE(readiness.willing_action_count, 0) AS willing_action_count,
        COALESCE(readiness.considering_action_count, 0) AS considering_action_count,
        COALESCE(readiness.completed_action_count, 0) AS completed_action_count,
        COALESCE(readiness.declines_all_actions, false) AS declines_all_actions,
        CASE
          WHEN followup.status = 'completed' AND followup.completed_at IS NOT NULL THEN 4
          WHEN followup.due_at < now() THEN 1
          WHEN followup.due_at < (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago' THEN 2
          ELSE 3
        END AS priority_rank,
        CASE
          WHEN followup.status = 'completed' AND followup.completed_at IS NOT NULL
            THEN -extract(epoch FROM followup.completed_at)::double precision
          ELSE extract(epoch FROM followup.due_at)::double precision
        END AS sort_time,
        encode(public.digest($1::text || ':' || followup.person_id::text, 'sha256'), 'hex') AS employee_handle,
        encode(public.digest('followup:' || $1::text || ':' || followup.id::text, 'sha256'), 'hex') AS followup_handle
      FROM local801.engagement_followups followup
      JOIN local801.people person
        ON person.id = followup.person_id
       AND person.organization_id = $1::uuid
       AND person.archived_at IS NULL
      LEFT JOIN local801.users assignee
        ON assignee.id = followup.assigned_to
       AND assignee.organization_id = $1::uuid
       AND assignee.deactivated_at IS NULL
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'handle', encode(public.digest('user:' || $1::text || ':' || candidate.id::text, 'sha256'), 'hex'),
              'label', candidate.display_name
            )
            ORDER BY candidate.display_name, candidate.id
          ),
          '[]'::jsonb
        ) AS assignee_options
        FROM (
          SELECT DISTINCT app_user.id, app_user.display_name
          FROM local801.users app_user
          JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
          JOIN local801.workspace_roles role
            ON role.id = user_role.role_id
           AND role.organization_id = $1::uuid
          WHERE app_user.organization_id = $1::uuid
            AND app_user.deactivated_at IS NULL
            AND role.code IN ('system_owner','local_admin','cat_admin','cat_lead','cat_member')
            AND (
              $4::text IN ('system_owner','local_admin','cat_admin')
              OR (
                $4::text = 'cat_lead'
                AND EXISTS (
                  SELECT 1
                  FROM local801.engagement_assignments target_assignment
                  WHERE target_assignment.organization_id = $1::uuid
                    AND target_assignment.person_id = followup.person_id
                    AND target_assignment.archived_at IS NULL
                    AND target_assignment.status = 'open'
                    AND (
                      target_assignment.primary_user_id = app_user.id
                      OR target_assignment.backup_user_id = app_user.id
                    )
                )
              )
              OR ($4::text = 'cat_member' AND app_user.id = $2::uuid)
            )
        ) candidate
      ) edit_options ON followup.status = 'open' AND followup.completed_at IS NULL
      LEFT JOIN local801.engagement_events source_event
        ON source_event.id = followup.engagement_event_id
       AND source_event.organization_id = $1::uuid
      LEFT JOIN local801.outreach_campaigns campaign
        ON campaign.id = source_event.campaign_id
       AND campaign.organization_id = $1::uuid
       AND campaign.status <> 'archived'
      LEFT JOIN LATERAL (
        SELECT event.occurred_at, event.outcome
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid
          AND event.person_id = person.id
          AND event.voided_at IS NULL
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN reporting.employee_action_person_readiness readiness
        ON readiness.organization_id = $1::uuid
       AND readiness.person_id = person.id
      WHERE followup.organization_id = $1::uuid
        AND (
          $3::boolean
          OR (
            followup.assigned_to = $2::uuid
            AND (
              $4::text IN ('system_owner','local_admin','cat_admin')
              OR EXISTS (
                SELECT 1
                FROM local801.engagement_assignments assignment
                WHERE assignment.organization_id = $1::uuid
                  AND assignment.person_id = followup.person_id
                  AND assignment.archived_at IS NULL
                  AND assignment.status = 'open'
                  AND (assignment.primary_user_id = $2::uuid OR assignment.backup_user_id = $2::uuid)
              )
            )
          )
        )
        AND (
          $5::text IS NULL
          OR person.first_name ILIKE $5 ESCAPE '\\'
          OR person.last_name ILIKE $5 ESCAPE '\\'
          OR person.preferred_name ILIKE $5 ESCAPE '\\'
          OR person.department ILIKE $5 ESCAPE '\\'
          OR person.classification ILIKE $5 ESCAPE '\\'
          OR person.work_location ILIKE $5 ESCAPE '\\'
          OR campaign.name ILIKE $5 ESCAPE '\\'
          OR assignee.display_name ILIKE $5 ESCAPE '\\'
        )
    ), selected AS (
      SELECT *
      FROM eligible
      WHERE
        ($6::text = 'all' AND status = 'open' AND completed_at IS NULL)
        OR ($6::text = 'overdue' AND status = 'open' AND completed_at IS NULL AND due_at < now())
        OR (
          $6::text = 'today'
          AND status = 'open'
          AND completed_at IS NULL
          AND due_at >= now()
          AND due_at < (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago'
        )
        OR (
          $6::text = 'upcoming'
          AND status = 'open'
          AND completed_at IS NULL
          AND due_at >= (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago'
        )
        OR (
          $6::text = 'completed'
          AND status = 'completed'
          AND completed_at IS NOT NULL
          AND completed_at >= now() - interval '14 days'
        )
    ), total AS (
      SELECT count(*) AS total_count FROM selected
    ), page_rows AS (
      SELECT *
      FROM selected
      WHERE $8::integer IS NULL
         OR (priority_rank, sort_time, last_name, first_name, followup_handle)
            > ($8::integer, $9::double precision, $10::text, $11::text, $12::text)
      ORDER BY priority_rank ASC, sort_time ASC, last_name ASC, first_name ASC, followup_handle ASC
      LIMIT $7::integer
    )
    SELECT page_rows.*, total.total_count
    FROM total
    LEFT JOIN page_rows ON true
    ORDER BY page_rows.priority_rank ASC, page_rows.sort_time ASC,
             page_rows.last_name ASC, page_rows.first_name ASC, page_rows.followup_handle ASC
  `, [
    context.organizationId,
    context.userId,
    organizationWide,
    context.role,
    like(term),
    focus,
    pageSize + 1,
    cursor?.priority ?? null,
    cursor?.sortTime ?? null,
    cursor?.lastName ?? null,
    cursor?.firstName ?? null,
    cursor?.handle ?? null,
  ]);

  const total = finiteInteger(rows[0]?.total_count);
  const dataRows = rows.filter((row) =>
    row.followup_id && row.person_id && row.first_name && row.last_name
    && row.employee_handle && row.followup_handle && row.due_at,
  );
  const hasNext = dataRows.length > pageSize;
  const pageRows = dataRows.slice(0, pageSize);

  return {
    items: pageRows.map((row) => ({
      employeeHandle: row.employee_handle!,
      followupHandle: row.followup_handle!,
      displayName: displayName(row.preferred_name, row.first_name!, row.last_name!),
      membershipStatus: normalizeMembership(row.membership_status),
      department: row.department,
      classification: row.classification,
      workLocation: row.work_location,
      dueAt: normalizeTimestamp(row.due_at)!,
      completedAt: normalizeTimestamp(row.completed_at),
      status: row.status === "completed" ? "completed" : "open",
      bucket: bucketFromRank(row.priority_rank),
      assignedTo: row.assigned_to_name,
      assignedToHandle: row.assigned_to_handle,
      assigneeOptions: normalizeAssigneeOptions(row.assignee_options),
      campaignName: row.campaign_name,
      latestEngagementAt: normalizeTimestamp(row.latest_engagement_at),
      latestOutcome: row.latest_outcome,
      willingActionCount: finiteInteger(row.willing_action_count),
      consideringActionCount: finiteInteger(row.considering_action_count),
      completedActionCount: finiteInteger(row.completed_action_count),
      declinesAllActions: Boolean(row.declines_all_actions),
    })),
    term,
    requestedScope,
    effectiveScope,
    focus,
    pageSize,
    total,
    nextCursor: hasNext && pageRows.length ? encodeCursor(pageRows.at(-1)!) : null,
  };
}

export const __testing = {
  normalizeAssigneeOptions,
};
