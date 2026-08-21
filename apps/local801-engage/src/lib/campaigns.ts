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
        count(DISTINCT person_id) FILTER (WHERE status = 'completed')::int AS completed_count
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
        encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
        campaign.name,
        campaign.status,
        campaign.starts_on,
        campaign.ends_on,
        campaign.launched_at,
        campaign.created_at,
        COALESCE(population.population_count, 0) AS population_count,
        COALESCE(assignment.assigned_count, 0) AS assigned_count,
        COALESCE(contact.contacted_count, 0) AS contacted_count,
        COALESCE(assignment.completed_count, 0) AS completed_count
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
        encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') AS campaign_handle,
        campaign.name, campaign.status, campaign.starts_on, campaign.ends_on, campaign.launched_at, campaign.created_at
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), population_count AS (
      SELECT count(*)::int AS value
      FROM local801.outreach_campaign_population population, selected
      WHERE population.organization_id = $1::uuid AND population.campaign_id = selected.id
    ), assignment_counts AS (
      SELECT count(DISTINCT assignment.person_id)::int AS assigned_count,
        count(DISTINCT assignment.person_id) FILTER (WHERE assignment.status = 'completed')::int AS completed_count
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
      COALESCE(assignment.completed_count, 0) AS completed_count
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
  total_count: number | string;
};

export async function getCampaignPopulationPage(
  context: WorkspaceContext,
  campaignHandle: string,
  input: { cursor?: unknown; pageSize?: unknown } = {},
  query: DatabaseQuery = queryLocal801,
) {
  requireAccess(context);
  if (!handlePattern.test(campaignHandle)) throw new Error("Campaign not found.");
  const requested = Number(input.pageSize);
  const pageSize = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const position = populationCursor(input.cursor);
  const rows = await query<PopulationRow>(`
    /* campaigns:population-keyset-page */
    WITH selected_campaign AS (
      SELECT campaign.id
      FROM local801.outreach_campaigns campaign
      WHERE campaign.organization_id = $1::uuid
        AND campaign.archived_at IS NULL
        AND campaign.status <> 'archived'
        AND encode(digest('campaign:' || campaign.organization_id::text || ':' || campaign.id::text, 'sha256'), 'hex') = $2::text
      LIMIT 1
    ), latest_assignments AS (
      SELECT DISTINCT ON (assignment.person_id)
        assignment.person_id,
        assignment.status,
        assignment.primary_user_id,
        assignment.due_at
      FROM local801.engagement_assignments assignment, selected_campaign campaign
      WHERE assignment.organization_id = $1::uuid
        AND assignment.campaign_id = campaign.id
        AND assignment.archived_at IS NULL
      ORDER BY assignment.person_id, assignment.created_at DESC, assignment.id DESC
    ), population AS (
      SELECT
        encode(digest($1::text || ':' || person.id::text, 'sha256'), 'hex') AS person_handle,
        person.first_name,
        person.last_name,
        person.department,
        assignment.status AS assignment_status,
        assignee.display_name AS assignee_name,
        assignment.due_at AS assignment_due_at,
        count(*) OVER () AS total_count
      FROM local801.outreach_campaign_population member
      JOIN selected_campaign campaign ON campaign.id = member.campaign_id
      JOIN local801.people person
        ON person.id = member.person_id
       AND person.organization_id = member.organization_id
       AND person.archived_at IS NULL
      LEFT JOIN latest_assignments assignment ON assignment.person_id = member.person_id
      LEFT JOIN local801.users assignee
        ON assignee.id = assignment.primary_user_id
       AND assignee.organization_id = $1::uuid
       AND assignee.deactivated_at IS NULL
      WHERE member.organization_id = $1::uuid
    ), page_rows AS (
      SELECT *
      FROM population
      WHERE ($3::text IS NULL
        OR last_name > $3::text
        OR (last_name = $3::text AND first_name > $4::text)
        OR (last_name = $3::text AND first_name = $4::text AND person_handle > $5::text))
      ORDER BY last_name ASC, first_name ASC, person_handle ASC
      LIMIT $6::integer
    )
    SELECT * FROM page_rows
    ORDER BY last_name ASC, first_name ASC, person_handle ASC
  `, [context.organizationId, campaignHandle, position?.lastName ?? null, position?.firstName ?? null, position?.handle ?? null, pageSize + 1]);

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
  }));
  return {
    people,
    total: number(rows[0]?.total_count ?? 0),
    hasNext,
    nextCursor: last ? encodePopulationCursor(last) : null,
    pageSize,
  };
}

export const __testing = { campaignCursor, populationCursor };
