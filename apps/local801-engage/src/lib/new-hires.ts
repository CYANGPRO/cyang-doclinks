import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import { outreachHandle } from "./outreach.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export const DEFAULT_NEW_HIRE_PAGE_SIZE = 25;
export const MAX_NEW_HIRE_PAGE_SIZE = 100;
export const NEW_HIRE_PAGE_SIZES = [25, 50, 100] as const;
export const MAX_NEW_HIRE_SEARCH_LENGTH = 100;

export type NewHireAssignmentFilter = "all" | "assigned" | "unassigned";
export type NewHireContactFilter = "all" | "never-engaged" | "follow-up-open" | "engaged";
export type NewHireMembershipFilter = "" | "member" | "nonmember" | "unknown";
export type NewHireContactState = "overdue_followup" | "followup_open" | "never_engaged" | "engaged";

type NewHireCursor = {
  hireDate: string;
  lastName: string;
  firstName: string;
  id: string;
};

export type NewHireSearchInput = {
  term?: unknown;
  assignment?: unknown;
  contact?: unknown;
  membershipStatus?: unknown;
  days?: unknown;
  pageSize?: unknown;
  cursor?: unknown;
};

export type NormalizedNewHireSearch = {
  term: string;
  assignment: NewHireAssignmentFilter;
  contact: NewHireContactFilter;
  membershipStatus: NewHireMembershipFilter;
  daysWithin: 30 | 60 | 90 | null;
  pageSize: number;
  cursor: NewHireCursor | null;
};

export type NewHireQueuePerson = {
  handle: string;
  displayName: string;
  hireDate: string;
  daysSinceHire: number;
  membershipStatus: "member" | "nonmember" | "unknown";
  department: string | null;
  classification: string | null;
  workLocation: string | null;
  jobStatus: string | null;
  workEmail: string | null;
  homeEmail: string | null;
  workPhone: string | null;
  cellPhone: string | null;
  homePhone: string | null;
  assigned: boolean;
  primaryOrganizers: string | null;
  backupOrganizers: string | null;
  latestEngagementAt: string | null;
  latestOutcome: string | null;
  openFollowupCount: number;
  overdueFollowupCount: number;
  nextFollowupAt: string | null;
  contactState: NewHireContactState;
};

export type NewHireQueuePage = {
  people: NewHireQueuePerson[];
  term: string;
  assignment: NewHireAssignmentFilter;
  contact: NewHireContactFilter;
  membershipStatus: NewHireMembershipFilter;
  daysWithin: 30 | 60 | 90 | null;
  pageSize: number;
  total: number;
  summary: {
    neverEngaged: number;
    unassigned: number;
    openFollowups: number;
    members: number;
  };
  nextCursor: string | null;
};

type NewHireRow = {
  person_id: string | null;
  preferred_name: string | null;
  first_name: string | null;
  last_name: string | null;
  membership_status: string | null;
  department: string | null;
  classification: string | null;
  work_location: string | null;
  job_status: string | null;
  work_email: string | null;
  home_email: string | null;
  work_phone: string | null;
  cell_phone: string | null;
  home_phone: string | null;
  hire_date: string | Date | null;
  days_since_hire: unknown;
  open_assignment_count: unknown;
  primary_organizers: string | null;
  backup_organizers: string | null;
  latest_engagement_at: string | Date | null;
  latest_outcome: string | null;
  open_followup_count: unknown;
  overdue_followup_count: unknown;
  next_followup_at: string | Date | null;
  total_count: unknown;
  never_engaged_count: unknown;
  unassigned_count: unknown;
  followup_open_count: unknown;
  member_count: unknown;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class NewHireAccessError extends Error {
  constructor() {
    super("New-hire access is forbidden.");
    this.name = "NewHireAccessError";
  }
}

function scalarString(value: unknown) {
  if (Array.isArray(value)) return scalarString(value[0]);
  return typeof value === "string" ? value : "";
}

function finiteCount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function dateOnly(value: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = value.slice(0, 10);
  return datePattern.test(text) ? text : null;
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMembership(value: unknown): NewHireMembershipFilter {
  const raw = scalarString(value);
  return raw === "member" || raw === "nonmember" || raw === "unknown" ? raw : "";
}

function normalizeMembershipValue(value: unknown): NewHireQueuePerson["membershipStatus"] {
  return value === "member" || value === "nonmember" || value === "unknown" ? value : "unknown";
}

function normalizePageSize(value: unknown) {
  const parsed = Number(scalarString(value));
  return NEW_HIRE_PAGE_SIZES.includes(parsed as (typeof NEW_HIRE_PAGE_SIZES)[number]) ? parsed : DEFAULT_NEW_HIRE_PAGE_SIZE;
}

function normalizeDays(value: unknown): 30 | 60 | 90 | null {
  const parsed = Number(scalarString(value));
  return parsed === 30 || parsed === 60 || parsed === 90 ? parsed : null;
}

function decodeCursor(value: unknown): NewHireCursor | null {
  const raw = scalarString(value);
  if (!raw || raw.length > 700) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<NewHireCursor>;
    if (typeof parsed.hireDate !== "string" || !datePattern.test(parsed.hireDate)
      || typeof parsed.lastName !== "string" || parsed.lastName.length > 200
      || typeof parsed.firstName !== "string" || parsed.firstName.length > 200
      || typeof parsed.id !== "string" || !uuidPattern.test(parsed.id)) return null;
    return { hireDate: parsed.hireDate, lastName: parsed.lastName, firstName: parsed.firstName, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(row: NewHireRow) {
  const hireDate = dateOnly(row.hire_date);
  if (!hireDate || !row.person_id || !row.last_name || !row.first_name) return null;
  return Buffer.from(JSON.stringify({
    hireDate,
    lastName: row.last_name,
    firstName: row.first_name,
    id: row.person_id,
  } satisfies NewHireCursor), "utf8").toString("base64url");
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function like(value: string) {
  return value ? `%${escapeLikePattern(value)}%` : null;
}

function contactState(row: NewHireRow): NewHireContactState {
  if (finiteCount(row.overdue_followup_count) > 0) return "overdue_followup";
  if (finiteCount(row.open_followup_count) > 0) return "followup_open";
  if (!row.latest_engagement_at) return "never_engaged";
  return "engaged";
}

export function normalizeNewHireSearch(input: NewHireSearchInput): NormalizedNewHireSearch {
  const rawAssignment = scalarString(input.assignment);
  const rawContact = scalarString(input.contact);
  return {
    term: scalarString(input.term).trim().replace(/\s+/g, " ").slice(0, MAX_NEW_HIRE_SEARCH_LENGTH),
    assignment: rawAssignment === "assigned" || rawAssignment === "unassigned" ? rawAssignment : "all",
    contact: rawContact === "never-engaged" || rawContact === "follow-up-open" || rawContact === "engaged" ? rawContact : "all",
    membershipStatus: normalizeMembership(input.membershipStatus),
    daysWithin: normalizeDays(input.days),
    pageSize: normalizePageSize(input.pageSize),
    cursor: decodeCursor(input.cursor),
  };
}

export async function getNewHireQueue(
  context: WorkspaceContext,
  input: NewHireSearchInput = {},
  query: DatabaseQuery = queryLocal801,
): Promise<NewHireQueuePage> {
  if (!can(context.role, "manageImports")) throw new NewHireAccessError();
  const normalized = normalizeNewHireSearch(input);
  const cursor = normalized.cursor;

  const rows = await query<NewHireRow>(`
    /* new-hires:latest-hire-keyset-queue */
    WITH latest_hire_events AS (
      SELECT DISTINCT ON (employment.person_id)
        employment.person_id,
        employment.effective_date AS hire_date,
        employment.department AS hire_department,
        employment.work_location AS hire_work_location
      FROM local801.employment_events employment
      WHERE employment.organization_id = $1::uuid
        AND employment.event_type = 'hire'
      ORDER BY employment.person_id, employment.effective_date DESC, employment.created_at DESC, employment.id DESC
    ), latest_hires AS (
      SELECT person.id AS person_id,
        COALESCE(person.hire_date, event.hire_date) AS hire_date,
        event.hire_department,
        event.hire_work_location
      FROM local801.people person
      LEFT JOIN latest_hire_events event ON event.person_id = person.id
      WHERE person.organization_id = $1::uuid
        AND person.archived_at IS NULL
        AND COALESCE(person.hire_date, event.hire_date) IS NOT NULL
    ), signals AS (
      SELECT
        person.id AS person_id,
        person.preferred_name,
        person.first_name,
        person.last_name,
        person.membership_status,
        COALESCE(NULLIF(trim(hire.hire_department), ''), person.department) AS department,
        person.classification,
        person.job_status,
        COALESCE(NULLIF(trim(hire.hire_work_location), ''), person.work_location) AS work_location,
        work_email.contact_value AS work_email,
        contact_details.home_email,
        contact_details.work_phone,
        contact_details.cell_phone,
        contact_details.home_phone,
        hire.hire_date,
        GREATEST(0, current_date - hire.hire_date) AS days_since_hire,
        COALESCE(assignment.open_assignment_count, 0) AS open_assignment_count,
        assignment.primary_organizers,
        assignment.backup_organizers,
        latest_event.occurred_at AS latest_engagement_at,
        latest_event.outcome AS latest_outcome,
        COALESCE(followup.open_followup_count, 0) AS open_followup_count,
        COALESCE(followup.overdue_followup_count, 0) AS overdue_followup_count,
        followup.next_followup_at
      FROM latest_hires hire
      JOIN local801.people person
        ON person.organization_id = $1::uuid
       AND person.id = hire.person_id
       AND person.archived_at IS NULL
       AND person.local_number = '0801'
      LEFT JOIN LATERAL (
        SELECT method.contact_value
        FROM local801.person_contact_methods method
        WHERE method.organization_id = $1::uuid
          AND method.person_id = person.id
          AND method.contact_type = 'work_email'
          AND method.is_primary = true
          AND method.archived_at IS NULL
          AND method.visibility = 'authorized_directory'
        ORDER BY method.created_at ASC, method.id ASC
        LIMIT 1
      ) work_email ON true
      LEFT JOIN LATERAL (
        SELECT
          max(method.contact_value) FILTER (WHERE method.contact_type = 'personal_email' AND method.contact_label = 'home') AS home_email,
          max(method.contact_value) FILTER (WHERE method.contact_type = 'phone' AND method.contact_label = 'work') AS work_phone,
          max(method.contact_value) FILTER (WHERE method.contact_type = 'phone' AND method.contact_label = 'cell') AS cell_phone,
          max(method.contact_value) FILTER (WHERE method.contact_type = 'phone' AND method.contact_label = 'home') AS home_phone
        FROM local801.person_contact_methods method
        WHERE method.organization_id = $1::uuid AND method.person_id = person.id
          AND method.is_primary = true AND method.archived_at IS NULL
          AND method.visibility = 'authorized_directory'
      ) contact_details ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS open_assignment_count,
          string_agg(DISTINCT primary_user.display_name, ', ' ORDER BY primary_user.display_name)
            FILTER (WHERE primary_user.id IS NOT NULL) AS primary_organizers,
          string_agg(DISTINCT backup_user.display_name, ', ' ORDER BY backup_user.display_name)
            FILTER (WHERE backup_user.id IS NOT NULL) AS backup_organizers
        FROM local801.engagement_assignments assignment_row
        LEFT JOIN local801.users primary_user
          ON primary_user.organization_id = $1::uuid
         AND primary_user.id = assignment_row.primary_user_id
         AND primary_user.deactivated_at IS NULL
        LEFT JOIN local801.users backup_user
          ON backup_user.organization_id = $1::uuid
         AND backup_user.id = assignment_row.backup_user_id
         AND backup_user.deactivated_at IS NULL
        WHERE assignment_row.organization_id = $1::uuid
          AND assignment_row.person_id = person.id
          AND assignment_row.archived_at IS NULL
          AND assignment_row.status = 'open'
      ) assignment ON true
      LEFT JOIN LATERAL (
        SELECT event.occurred_at, event.outcome
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid
          AND event.person_id = person.id
          AND event.voided_at IS NULL
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 1
      ) latest_event ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL)::int AS open_followup_count,
          count(*) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL AND item.due_at < now())::int AS overdue_followup_count,
          min(item.due_at) FILTER (WHERE item.status = 'open' AND item.completed_at IS NULL) AS next_followup_at
        FROM local801.engagement_followups item
        WHERE item.organization_id = $1::uuid
          AND item.person_id = person.id
      ) followup ON true
    ), filtered AS (
      SELECT *
      FROM signals
      WHERE ($2::text IS NULL
          OR first_name ILIKE $2 ESCAPE '\\'
          OR last_name ILIKE $2 ESCAPE '\\'
          OR preferred_name ILIKE $2 ESCAPE '\\'
          OR department ILIKE $2 ESCAPE '\\'
          OR classification ILIKE $2 ESCAPE '\\'
          OR work_location ILIKE $2 ESCAPE '\\'
          OR work_email ILIKE $2 ESCAPE '\\')
        AND ($3::text IS NULL OR membership_status = $3)
        AND ($4::text = 'all'
          OR ($4::text = 'assigned' AND open_assignment_count > 0)
          OR ($4::text = 'unassigned' AND open_assignment_count = 0))
        AND ($5::text = 'all'
          OR ($5::text = 'never-engaged' AND latest_engagement_at IS NULL)
          OR ($5::text = 'follow-up-open' AND open_followup_count > 0)
          OR ($5::text = 'engaged' AND latest_engagement_at IS NOT NULL AND open_followup_count = 0))
        AND ($6::integer IS NULL OR hire_date >= current_date - $6::integer)
    ), page_rows AS (
      SELECT *
      FROM filtered
      WHERE ($7::date IS NULL
        OR hire_date < $7::date
        OR (hire_date = $7::date AND (last_name, first_name, person_id) > ($8::text, $9::text, $10::uuid)))
      ORDER BY hire_date DESC, last_name ASC, first_name ASC, person_id ASC
      LIMIT $11::integer
    ), stats AS (
      SELECT
        count(*) AS total_count,
        count(*) FILTER (WHERE latest_engagement_at IS NULL) AS never_engaged_count,
        count(*) FILTER (WHERE open_assignment_count = 0) AS unassigned_count,
        count(*) FILTER (WHERE open_followup_count > 0) AS followup_open_count,
        count(*) FILTER (WHERE membership_status = 'member') AS member_count
      FROM filtered
    )
    SELECT page_rows.*, stats.total_count, stats.never_engaged_count, stats.unassigned_count,
      stats.followup_open_count, stats.member_count
    FROM stats
    LEFT JOIN page_rows ON true
    ORDER BY page_rows.hire_date DESC NULLS LAST, page_rows.last_name ASC, page_rows.first_name ASC, page_rows.person_id ASC
  `, [
    context.organizationId,
    like(normalized.term),
    normalized.membershipStatus || null,
    normalized.assignment,
    normalized.contact,
    normalized.daysWithin,
    cursor?.hireDate ?? null,
    cursor?.lastName ?? null,
    cursor?.firstName ?? null,
    cursor?.id ?? null,
    normalized.pageSize + 1,
  ]);

  const total = finiteCount(rows[0]?.total_count);
  const dataRows = rows.filter((row) => row.person_id && row.first_name && row.last_name && row.hire_date);
  const hasNext = dataRows.length > normalized.pageSize;
  const bounded = dataRows.slice(0, normalized.pageSize);
  const people: NewHireQueuePerson[] = bounded.map((row) => ({
    handle: outreachHandle(context.organizationId, row.person_id!),
    displayName: row.preferred_name?.trim() || `${row.first_name} ${row.last_name}`,
    hireDate: dateOnly(row.hire_date)!,
    daysSinceHire: finiteCount(row.days_since_hire),
    membershipStatus: normalizeMembershipValue(row.membership_status),
    department: row.department,
    classification: row.classification,
    workLocation: row.work_location,
    jobStatus: row.job_status,
    workEmail: row.work_email,
    homeEmail: row.home_email,
    workPhone: row.work_phone,
    cellPhone: row.cell_phone,
    homePhone: row.home_phone,
    assigned: finiteCount(row.open_assignment_count) > 0,
    primaryOrganizers: row.primary_organizers,
    backupOrganizers: row.backup_organizers,
    latestEngagementAt: timestamp(row.latest_engagement_at),
    latestOutcome: row.latest_outcome,
    openFollowupCount: finiteCount(row.open_followup_count),
    overdueFollowupCount: finiteCount(row.overdue_followup_count),
    nextFollowupAt: timestamp(row.next_followup_at),
    contactState: contactState(row),
  }));
  const last = hasNext ? bounded.at(-1) : null;

  return {
    people,
    term: normalized.term,
    assignment: normalized.assignment,
    contact: normalized.contact,
    membershipStatus: normalized.membershipStatus,
    daysWithin: normalized.daysWithin,
    pageSize: normalized.pageSize,
    total,
    summary: {
      neverEngaged: finiteCount(rows[0]?.never_engaged_count),
      unassigned: finiteCount(rows[0]?.unassigned_count),
      openFollowups: finiteCount(rows[0]?.followup_open_count),
      members: finiteCount(rows[0]?.member_count),
    },
    nextCursor: last ? encodeCursor(last) : null,
  };
}

export const __testing = { decodeCursor };
