import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type CampaignReportOverview = {
  campaignCount: number;
  activeCampaignCount: number;
  populationCount: number;
  assignedCount: number;
  contactedCount: number;
  completedCount: number;
  coverageRate: number;
  assignmentRate: number;
  completionRate: number;
};

export type CampaignStatusBreakdown = {
  status: string;
  campaignCount: number;
};

export type CampaignPerformance = {
  name: string;
  status: string;
  populationCount: number;
  assignedCount: number;
  contactedCount: number;
  completedCount: number;
  coverageRate: number;
  assignmentRate: number;
  completionRate: number;
};

export type CampaignReport = {
  overview: CampaignReportOverview;
  statuses: CampaignStatusBreakdown[];
  campaigns: CampaignPerformance[];
};

type OverviewRow = {
  campaign_count: unknown;
  active_campaign_count: unknown;
  population_count: unknown;
  assigned_count: unknown;
  contacted_count: unknown;
  completed_count: unknown;
};

type StatusRow = { status: string; campaign_count: unknown };
type CampaignRow = {
  name: string;
  status: string;
  population_count: unknown;
  assigned_count: unknown;
  contacted_count: unknown;
  completed_count: unknown;
};

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

function performance(row: CampaignRow): CampaignPerformance {
  const populationCount = count(row.population_count);
  const assignedCount = Math.min(count(row.assigned_count), populationCount);
  const contactedCount = Math.min(count(row.contacted_count), populationCount);
  const completedCount = Math.min(count(row.completed_count), assignedCount);
  return {
    name: row.name,
    status: row.status,
    populationCount,
    assignedCount,
    contactedCount,
    completedCount,
    coverageRate: rate(contactedCount, populationCount),
    assignmentRate: rate(assignedCount, populationCount),
    completionRate: rate(completedCount, assignedCount),
  };
}

export async function getCampaignReport(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<CampaignReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const [overviewRows, statusRows, campaignRows] = await Promise.all([
    query<OverviewRow>(`
      /* reports:campaign-overview */
      WITH assignment_counts AS (
        SELECT
          campaign_id,
          count(DISTINCT person_id) FILTER (WHERE archived_at IS NULL) AS assigned_count,
          count(DISTINCT person_id) FILTER (WHERE archived_at IS NULL AND lower(status) = 'completed') AS completed_count
        FROM local801.engagement_assignments
        WHERE organization_id = $1::uuid
        GROUP BY campaign_id
      )
      SELECT
        count(*) AS campaign_count,
        count(*) FILTER (WHERE summary.status = 'active') AS active_campaign_count,
        COALESCE(sum(summary.population_count), 0) AS population_count,
        COALESCE(sum(assignment.assigned_count), 0) AS assigned_count,
        COALESCE(sum(coverage.contacted_count), 0) AS contacted_count,
        COALESCE(sum(assignment.completed_count), 0) AS completed_count
      FROM reporting.campaign_summary summary
      LEFT JOIN reporting.engagement_coverage coverage
        ON coverage.organization_id = summary.organization_id
       AND coverage.campaign_id = summary.campaign_id
      LEFT JOIN assignment_counts assignment ON assignment.campaign_id = summary.campaign_id
      WHERE summary.organization_id = $1::uuid
        AND summary.status <> 'archived'
    `, [context.organizationId]),
    query<StatusRow>(`
      /* reports:campaign-statuses */
      SELECT status, count(*) AS campaign_count
      FROM reporting.campaign_summary
      WHERE organization_id = $1::uuid
        AND status <> 'archived'
      GROUP BY status
      ORDER BY status ASC
      LIMIT 20
    `, [context.organizationId]),
    query<CampaignRow>(`
      /* reports:campaign-performance */
      WITH assignment_counts AS (
        SELECT
          campaign_id,
          count(DISTINCT person_id) FILTER (WHERE archived_at IS NULL) AS assigned_count,
          count(DISTINCT person_id) FILTER (WHERE archived_at IS NULL AND lower(status) = 'completed') AS completed_count
        FROM local801.engagement_assignments
        WHERE organization_id = $1::uuid
        GROUP BY campaign_id
      )
      SELECT
        summary.name,
        summary.status,
        summary.population_count,
        COALESCE(assignment.assigned_count, 0) AS assigned_count,
        COALESCE(coverage.contacted_count, 0) AS contacted_count,
        COALESCE(assignment.completed_count, 0) AS completed_count
      FROM reporting.campaign_summary summary
      LEFT JOIN reporting.engagement_coverage coverage
        ON coverage.organization_id = summary.organization_id
       AND coverage.campaign_id = summary.campaign_id
      LEFT JOIN assignment_counts assignment ON assignment.campaign_id = summary.campaign_id
      WHERE summary.organization_id = $1::uuid
        AND summary.status <> 'archived'
      ORDER BY summary.name ASC
      LIMIT 50
    `, [context.organizationId]),
  ]);

  const overview = overviewRows[0];
  const populationCount = count(overview?.population_count);
  const assignedCount = Math.min(count(overview?.assigned_count), populationCount);
  const contactedCount = Math.min(count(overview?.contacted_count), populationCount);
  const completedCount = Math.min(count(overview?.completed_count), assignedCount);

  return {
    overview: {
      campaignCount: count(overview?.campaign_count),
      activeCampaignCount: count(overview?.active_campaign_count),
      populationCount,
      assignedCount,
      contactedCount,
      completedCount,
      coverageRate: rate(contactedCount, populationCount),
      assignmentRate: rate(assignedCount, populationCount),
      completionRate: rate(completedCount, assignedCount),
    },
    statuses: statusRows.map((row) => ({ status: row.status, campaignCount: count(row.campaign_count) })),
    campaigns: campaignRows.map(performance),
  };
}

export const __testing = { count, rate, performance };
