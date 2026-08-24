import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

type CampaignRow = {
  campaign_handle: string | null;
  name: string | null;
  status: string | null;
  starts_on: string | Date | null;
  ends_on: string | Date | null;
  launched_at: string | Date | null;
  created_at: string | Date | null;
  population_count: number | string;
  assigned_count: number | string;
  contacted_count: number | string;
  completed_count: number | string;
  overdue_count: number | string;
};

export type CampaignSummary = {
  handle: string;
  name: string;
  status: "draft" | "active" | "closed";
  startsOn: string | null;
  endsOn: string | null;
  launchedAt: string | null;
  population: number;
  assigned: number;
  contacted: number;
  completed: number;
  unassigned: number;
  overdue: number;
  remaining: number;
  completionPercentage: number;
};

export type CampaignPage = { campaigns: CampaignSummary[]; nextCursor: string | null; pageSize: number };

type CampaignCursor = { createdAt: string; handle: string };
type PopulationCursor = { lastName: string; firstName: string; handle: string };

export type CampaignPopulationPerson = {
  personHandle: string;
  first_name: string;
  last_name: string;
  department: string | null;
  assignment_status: string | null;
  assignee_name: string | null;
  assignment_due_at: string | null;
  contacted: boolean;
  completed: boolean;
  overdue: boolean;
};

export type CampaignPopulationFilters = {
  assignment: "all" | "assigned" | "unassigned";
  workflow: "all" | "not_contacted" | "contacted" | "completed" | "overdue";
};

export type CampaignOrganizerProgress = {
  assigneeHandle: string;
  assigneeName: string;
  assigned: number;
  open: number;
  completed: number;
  overdue: number;
};

const handlePattern = /^[0-9a-f]{64}$/;

function number(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dateOnly(value: string | Date | null) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function publicStatus(value: string | null): CampaignSummary["status"] {
  return value === "active" || value === "closed" ? value : "draft";
}

function validTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 50) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function campaignCursor(value: unknown): CampaignCursor | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CampaignCursor>;
    const createdAt = validTimestamp(parsed.createdAt);
    return createdAt && typeof parsed.handle === "string" && handlePattern.test(parsed.handle)
      ? { createdAt, handle: parsed.handle }
      : null;
  } catch {
    return null;
  }
}

function encodeCampaignCursor(row: CampaignRow) {
  const createdAt = timestamp(row.created_at);
  if (!createdAt || !row.campaign_handle || !handlePattern.test(row.campaign_handle)) return null;
  return Buffer.from(JSON.stringify({ createdAt, handle: row.campaign_handle } satisfies CampaignCursor)).toString("base64url");
}

function populationCursor(value: unknown): PopulationCursor | null {
  if (typeof value !== "string" || value.length > 600) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PopulationCursor>;
    return typeof parsed.lastName === "string" && parsed.lastName.length <= 200
      && typeof parsed.firstName === "string" && parsed.firstName.length <= 200
      && typeof parsed.handle === "string" && handlePattern.test(parsed.handle)
      ? { lastName: parsed.lastName, firstName: parsed.firstName, handle: parsed.handle }
      : null;
  } catch {
    return null;
  }
}

function encodePopulationCursor(row: PopulationRow) {
  if (!row.person_handle || !handlePattern.test(row.person_handle)) return null;
  return Buffer.from(JSON.stringify({
    lastName: row.last_name,
    firstName: row.first_name,
    handle: row.person_handle,
  } satisfies PopulationCursor)).toString("base64url");
}

function campaignSummary(row: CampaignRow): CampaignSummary {
  const population = number(row.population_count);
  const completed = Math.min(number(row.completed_count), population);
  return {
    handle: row.campaign_handle!,
    name: row.name!,
    status: publicStatus(row.status),
    startsOn: dateOnly(row.starts_on),
    endsOn: dateOnly(row.ends_on),
    launchedAt: timestamp(row.launched_at),
    population,
    assigned: Math.min(number(row.assigned_count), population),
    contacted: Math.min(number(row.contacted_count), population),
    completed,
    unassigned: Math.max(0, population - Math.min(number(row.assigned_count), population)),
    overdue: Math.min(number(row.overdue_count), population),
    remaining: Math.max(0, population - completed),
    completionPercentage: population ? Math.round((completed / population) * 100) : 0,
  };
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "manageCampaigns")) throw new Error("Forbidden.");
}

export async function getCampaignsPage(
  context: WorkspaceContext,
  input: { cursor?: unknown; pageSize?: unknown } = {},
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignPage> {
  requireAccess(context);
  const requested = Number(input.pageSize);
  const pageSize = [25, 50, 100].includes(requested) ? requested : 25;
  const position = campaignCursor(input.cursor);
  const rows = await query<CampaignRow>(`
    /* campaigns:aggregate-keyset-page */
    WITH population_counts AS (
      SELECT organization_id, campaign_id, count(*)::int AS population_count
      FROM local801.outreach_campaign_population
      WHERE organization_id = $1::uuid
      GROUP BY organization_id, campaign_id
    ), assignment_counts AS (
      SELECT organization_id, campaign_id,
        count(DISTINCT person_id)::int AS assigned_count,
        count(DISTINCT person_id) FILTER (WHERE status = 'completed')::int AS completed_count,
        count(DISTINCT person_id) FILTER (WHERE status = 'open' AND due_at < now())::int AS overdue_count
      FROM local801.engagement_assignments
      WHERE organization_id = $1::uuid AND archived_at IS NULL
      GROUP BY organization_id, campaign_id
    ), contact_counts AS (
      SELECT organization_id, campaign_id, count(DISTINCT person_id)::int AS contacted_count
      FROM local801.engagement_events
      WHERE organization_id = $1::uuid AND voided_at IS NULL
      GROUP BY organization_id, campaign_id
    ), base AS (
      SELECT
        encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
        campaign.name,
        campaign.status,
        campaign.starts_on,
        campaign.ends_on,
        campaign.launched_at,
        campaign.created_at,
        COALESCE(population.population_count, 0) AS population_count,
        COALESCE(assignment.assigned_count, 0) AS assigned_count,
        COALESCE(contact.contacted_count, 0) AS contacted_count,
        COALESCE(assignment.completed_count, 0) AS completed_count,
        COALESCE(assignment.overdue_count, 0) AS overdue_count
      FROM local801.outreach_campaigns campaign
      LEFT JOIN population_counts population
        ON population.organization_id = campaign.organization_id AND population.campaign_id = campaign.id
      LEFT JOIN assignment_counts assignment
        ON assignment.organization_id = campaign.organization_id AND assignment.campaign_id = campaign.id
      LEFT JOIN contact_counts contact
        ON contact.organization_id = campaign.organization_id AND contact.campaign_id = campaign.id
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
    )
    SELECT *
    FROM base
    WHERE ($2::timestamptz IS NULL
      OR created_at < $2::timestamptz
      OR (created_at = $2::timestamptz AND campaign_handle < $3::text))
    ORDER BY created_at DESC, campaign_handle DESC
    LIMIT $4::integer
  `, [context.organizationId, position?.createdAt ?? null, position?.handle ?? null, pageSize + 1]);

  const dataRows = rows.filter((row) => row.campaign_handle && row.name && handlePattern.test(row.campaign_handle));
  const hasNext = dataRows.length > pageSize;
  const bounded = dataRows.slice(0, pageSize);
  const last = hasNext ? bounded.at(-1) : null;
  return {
    campaigns: bounded.map(campaignSummary),
    nextCursor: last ? encodeCampaignCursor(last) : null,
    pageSize,
  };
}

export async function getCampaignDetail(
  context: WorkspaceContext,
  campaignHandle: string,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignSummary | null> {
  requireAccess(context);
  if (!handlePattern.test(campaignHandle)) return null;
  const [row] = await query<CampaignRow>(`
    /* campaigns:detail-summary */
    WITH selected AS (
      SELECT campaign.id,
        encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
        campaign.name, campaign.status, campaign.starts_on, campaign.ends_on, campaign.launched_at, campaign.created_at
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), population_count AS (
      SELECT count(*)::int AS value
      FROM local801.outreach_campaign_population population, selected
      WHERE population.organization_id = $1::uuid AND population.campaign_id = selected.id
    ), assignment_counts AS (
      SELECT count(DISTINCT assignment.person_id)::int AS assigned_count,
        count(DISTINCT assignment.person_id) FILTER (WHERE assignment.status = 'completed')::int AS completed_count,
        count(DISTINCT assignment.person_id) FILTER (WHERE assignment.status = 'open' AND assignment.due_at < now())::int AS overdue_count
      FROM local801.engagement_assignments assignment, selected
      WHERE assignment.organization_id = $1::uuid
        AND assignment.campaign_id = selected.id
        AND assignment.archived_at IS NULL
    ), contact_count AS (
      SELECT count(DISTINCT event.person_id)::int AS value
      FROM local801.engagement_events event, selected
      WHERE event.organization_id = $1::uuid
        AND event.campaign_id = selected.id
        AND event.voided_at IS NULL
    )
    SELECT selected.campaign_handle, selected.name, selected.status, selected.starts_on, selected.ends_on,
      selected.launched_at, selected.created_at,
      COALESCE(population.value, 0) AS population_count,
      COALESCE(assignment.assigned_count, 0) AS assigned_count,
      COALESCE(contact.value, 0) AS contacted_count,
      COALESCE(assignment.completed_count, 0) AS completed_count,
      COALESCE(assignment.overdue_count, 0) AS overdue_count
    FROM selected
    CROSS JOIN population_count population
    CROSS JOIN assignment_counts assignment
    CROSS JOIN contact_count contact
  `, [context.organizationId, campaignHandle]);
  return row && row.campaign_handle && row.name ? campaignSummary(row) : null;
}

type PopulationRow = {
  person_handle: string | null;
  first_name: string;
  last_name: string;
  department: string | null;
  assignment_status: string | null;
  assignee_name: string | null;
  assignment_due_at: string | Date | null;
  contacted: boolean;
  completed: boolean;
  overdue: boolean;
  total_count: number | string;
};

export async function getCampaignPopulationPage(
  context: WorkspaceContext,
  campaignHandle: string,
  input: { cursor?: unknown; pageSize?: unknown; assignment?: unknown; workflow?: unknown } = {},
  query: DatabaseQuery = queryLocal801,
) {
  requireAccess(context);
  if (!handlePattern.test(campaignHandle)) throw new Error("Campaign not found.");
  const requested = Number(input.pageSize);
  const pageSize = [25, 50, 100].includes(requested) ? requested : 50;
  const filters = normalizeCampaignPopulationFilters(input);
  const position = populationCursor(input.cursor);
  const rows = await query<PopulationRow>(`
    /* campaigns:population-keyset-page */
    WITH selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), population AS (
      SELECT
        encode(public.digest($1::text || ':' || person.id::text, 'sha256'), 'hex') AS person_handle,
        person.first_name,
        person.last_name,
        person.department,
        assignment.status AS assignment_status,
        assignee.display_name AS assignee_name,
        assignment.due_at AS assignment_due_at,
        COALESCE(contact.contacted, false) AS contacted,
        COALESCE(assignment.status = 'completed', false) AS completed,
        COALESCE(assignment.status = 'open' AND assignment.due_at < now(), false) AS overdue,
        count(*) OVER () AS total_count
      FROM local801.outreach_campaign_population member
      JOIN selected_campaign campaign ON campaign.id = member.campaign_id
      JOIN local801.people person
        ON person.id = member.person_id
       AND person.organization_id = member.organization_id
       AND person.archived_at IS NULL
      LEFT JOIN LATERAL (
        SELECT active_assignment.id, active_assignment.status,
          active_assignment.primary_user_id, active_assignment.due_at
        FROM local801.engagement_assignments active_assignment
        WHERE active_assignment.organization_id = $1::uuid
          AND active_assignment.campaign_id = campaign.id
          AND active_assignment.person_id = member.person_id
          AND active_assignment.archived_at IS NULL
        ORDER BY active_assignment.created_at DESC, active_assignment.id DESC
        LIMIT 1
      ) assignment ON true
      LEFT JOIN LATERAL (
        SELECT true AS contacted
        FROM local801.engagement_events event
        WHERE event.organization_id = $1::uuid AND event.campaign_id = campaign.id
          AND event.person_id = member.person_id AND event.voided_at IS NULL
        LIMIT 1
      ) contact ON true
      LEFT JOIN local801.users assignee
        ON assignee.id = assignment.primary_user_id
       AND assignee.organization_id = $1::uuid
       AND assignee.deactivated_at IS NULL
      WHERE member.organization_id = $1::uuid
        AND ($3::text = 'all' OR ($3::text = 'assigned' AND assignment.id IS NOT NULL)
          OR ($3::text = 'unassigned' AND assignment.id IS NULL))
        AND ($4::text = 'all' OR ($4::text = 'not_contacted' AND NOT COALESCE(contact.contacted, false))
          OR ($4::text = 'contacted' AND COALESCE(contact.contacted, false))
          OR ($4::text = 'completed' AND assignment.status = 'completed')
          OR ($4::text = 'overdue' AND assignment.status = 'open' AND assignment.due_at < now()))
    ), page_rows AS (
      SELECT *
      FROM population
      WHERE ($5::text IS NULL
        OR last_name > $5::text
        OR (last_name = $5::text AND first_name > $6::text)
        OR (last_name = $5::text AND first_name = $6::text AND person_handle > $7::text))
      ORDER BY last_name ASC, first_name ASC, person_handle ASC
      LIMIT $8::integer
    )
    SELECT * FROM page_rows
    ORDER BY last_name ASC, first_name ASC, person_handle ASC
  `, [context.organizationId, campaignHandle, filters.assignment, filters.workflow,
    position?.lastName ?? null, position?.firstName ?? null, position?.handle ?? null, pageSize + 1]);

  const dataRows = rows.filter((row) => row.person_handle && handlePattern.test(row.person_handle));
  const hasNext = dataRows.length > pageSize;
  const bounded = dataRows.slice(0, pageSize);
  const last = hasNext ? bounded.at(-1) : null;
  const people: CampaignPopulationPerson[] = bounded.map((row) => ({
    personHandle: row.person_handle!,
    first_name: row.first_name,
    last_name: row.last_name,
    department: row.department,
    assignment_status: row.assignment_status,
    assignee_name: row.assignee_name,
    assignment_due_at: timestamp(row.assignment_due_at),
    contacted: row.contacted,
    completed: row.completed,
    overdue: row.overdue,
  }));
  return {
    people,
    total: number(rows[0]?.total_count ?? 0),
    hasNext,
    nextCursor: last ? encodePopulationCursor(last) : null,
    pageSize,
    filters,
  };
}

export function normalizeCampaignPopulationFilters(input: { assignment?: unknown; workflow?: unknown }): CampaignPopulationFilters {
  const assignment = input.assignment === "assigned" || input.assignment === "unassigned" ? input.assignment : "all";
  const workflow = ["not_contacted", "contacted", "completed", "overdue"].includes(String(input.workflow))
    ? input.workflow as CampaignPopulationFilters["workflow"] : "all";
  return { assignment, workflow };
}

export async function getCampaignOrganizerProgress(
  context: WorkspaceContext,
  campaignHandle: string,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignOrganizerProgress[]> {
  requireAccess(context);
  if (!handlePattern.test(campaignHandle)) return [];
  const rows = await query<{
    assignee_handle: string;
    assignee_name: string;
    assigned_count: number | string;
    open_count: number | string;
    completed_count: number | string;
    overdue_count: number | string;
  }>(`
    /* campaigns:organizer-progress */
    WITH selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND encode(public.digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), latest AS (
      SELECT DISTINCT ON (assignment.person_id)
        assignment.person_id, assignment.primary_user_id, assignment.status, assignment.due_at
      FROM local801.engagement_assignments assignment CROSS JOIN selected_campaign campaign
      WHERE assignment.organization_id = $1::uuid AND assignment.campaign_id = campaign.id
        AND assignment.archived_at IS NULL AND assignment.primary_user_id IS NOT NULL
      ORDER BY assignment.person_id, assignment.created_at DESC, assignment.id DESC
    )
    SELECT encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') AS assignee_handle,
      app_user.display_name AS assignee_name,
      count(*)::int AS assigned_count,
      count(*) FILTER (WHERE latest.status = 'open')::int AS open_count,
      count(*) FILTER (WHERE latest.status = 'completed')::int AS completed_count,
      count(*) FILTER (WHERE latest.status = 'open' AND latest.due_at < now())::int AS overdue_count
    FROM latest
    JOIN local801.users app_user ON app_user.organization_id = $1::uuid
      AND app_user.id = latest.primary_user_id AND app_user.deactivated_at IS NULL
    GROUP BY app_user.id, app_user.display_name
    ORDER BY assigned_count DESC, assignee_handle ASC
    LIMIT 100
  `, [context.organizationId, campaignHandle]);
  return rows.filter((row) => handlePattern.test(row.assignee_handle)).map((row) => ({
    assigneeHandle: row.assignee_handle,
    assigneeName: row.assignee_name,
    assigned: number(row.assigned_count),
    open: number(row.open_count),
    completed: number(row.completed_count),
    overdue: number(row.overdue_count),
  }));
}

export const __testing = { campaignCursor, populationCursor, normalizeCampaignPopulationFilters };
