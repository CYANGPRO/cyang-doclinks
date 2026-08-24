import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type MembershipOverview = {
  representedCount: number;
  memberCount: number;
  nonmemberCount: number;
  otherCount: number;
  membershipRate: number;
  refreshedAt: string | null;
};

export type MembershipChangePoint = {
  month: string;
  additions: number;
  drops: number;
  netChange: number;
};

export type MembershipBreakdown = {
  label: string;
  representedCount: number;
  memberCount: number;
  nonmemberCount: number;
  otherCount: number;
  membershipRate: number;
};

export type MembershipDataQuality = {
  missingNames: number;
  missingWorkEmail: number;
};

export type MembershipReport = {
  overview: MembershipOverview;
  monthlyChanges: MembershipChangePoint[];
  classifications: MembershipBreakdown[];
  departments: MembershipBreakdown[];
  workLocations: MembershipBreakdown[];
  jobStatuses: MembershipBreakdown[];
  dataQuality: MembershipDataQuality;
};

export type NewHireOverview = {
  newHireCount: number;
  currentMemberCount: number;
  conversionRate: number;
  engagedCount: number;
  notYetEngagedCount: number;
  engagementRate: number;
};

export type NewHireTrendPoint = {
  month: string;
  newHires: number;
  currentMembers: number;
  conversionRate: number;
};

export type NewHireBreakdown = {
  label: string;
  newHireCount: number;
};

export type NewHireReport = {
  overview: NewHireOverview;
  monthly: NewHireTrendPoint[];
  departments: NewHireBreakdown[];
  workLocations: NewHireBreakdown[];
  jobStatuses: NewHireBreakdown[];
};

export type EngagementOverview = {
  eventCount: number;
  activeOrganizerCount: number;
  followupCount: number;
  openFollowupCount: number;
};

export type EngagementTrendPoint = {
  date: string;
  eventCount: number;
};

export type EngagementBreakdown = {
  label: string;
  eventCount: number;
};

export type FollowupStatusBreakdown = {
  label: string;
  followupCount: number;
};

export type CampaignCoverage = {
  label: string;
  assignedCount: number;
  contactedCount: number;
  coverageRate: number;
};

export type EngagementReport = {
  overview: EngagementOverview;
  daily: EngagementTrendPoint[];
  contactMethods: EngagementBreakdown[];
  outcomes: EngagementBreakdown[];
  departments: EngagementBreakdown[];
  workLocations: EngagementBreakdown[];
  organizers: EngagementBreakdown[];
  followupStatuses: FollowupStatusBreakdown[];
  campaignCoverage: CampaignCoverage[];
};

type OverviewRow = {
  represented_count: unknown;
  member_count: unknown;
  nonmember_count: unknown;
  other_count: unknown;
  refreshed_at: string | Date | null;
};

type ChangeRow = {
  month: string | Date;
  additions: unknown;
  drops: unknown;
  net_change: unknown;
};

type BreakdownRow = {
  label: string;
  represented_count: unknown;
  member_count: unknown;
  nonmember_count: unknown;
  other_count: unknown;
};

type DataQualityRow = {
  missing_names: unknown;
  missing_work_email: unknown;
};

type NewHireOverviewRow = {
  new_hires: unknown;
  current_members: unknown;
};

type NewHireEngagementRow = {
  new_hires: unknown;
  engaged_count: unknown;
};

type NewHireTrendRow = {
  hire_month: string | Date;
  new_hires: unknown;
  current_members: unknown;
};

type NewHireBreakdownRow = {
  label: string;
  new_hires: unknown;
};

type EngagementOverviewRow = {
  event_count: unknown;
  active_organizers: unknown;
};

type FollowupOverviewRow = {
  followup_count: unknown;
  open_followups: unknown;
};

type EngagementTrendRow = {
  engagement_date: string | Date;
  event_count: unknown;
};

type EngagementBreakdownRow = {
  label: string;
  event_count: unknown;
};

type FollowupStatusRow = {
  label: string;
  followup_count: unknown;
};

type CampaignCoverageRow = {
  label: string;
  assigned_count: unknown;
  contacted_count: unknown;
};

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function signedCount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function dateOnly(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function breakdown(row: BreakdownRow): MembershipBreakdown {
  const representedCount = count(row.represented_count);
  const memberCount = count(row.member_count);
  return {
    label: row.label,
    representedCount,
    memberCount,
    nonmemberCount: count(row.nonmember_count),
    otherCount: count(row.other_count),
    membershipRate: rate(memberCount, representedCount),
  };
}

export async function getMembershipReport(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<MembershipReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const [overviewRows, changeRows, classificationRows, departmentRows, workLocationRows, jobStatusRows, qualityRows] = await Promise.all([
    query<OverviewRow>(`
      /* reports:membership-overview */
      SELECT
        count(*) AS represented_count,
        count(*) FILTER (WHERE membership_status = 'member') AS member_count,
        count(*) FILTER (WHERE membership_status = 'nonmember') AS nonmember_count,
        count(*) FILTER (WHERE membership_status NOT IN ('member', 'nonmember')) AS other_count,
        max(refreshed_at) AS refreshed_at
      FROM reporting.current_membership
      WHERE organization_id = $1::uuid
    `, [context.organizationId]),
    query<ChangeRow>(`
      /* reports:membership-monthly-changes */
      SELECT month, additions, drops, net_change
      FROM reporting.membership_retention
      WHERE organization_id = $1::uuid
        AND (additions <> 0 OR drops <> 0)
      ORDER BY month DESC
      LIMIT 12
    `, [context.organizationId]),
    query<BreakdownRow>(`
      /* reports:membership-by-classification */
      SELECT
        COALESCE(NULLIF(trim(classification), ''), 'Unspecified') AS label,
        count(*) AS represented_count,
        count(*) FILTER (WHERE membership_status = 'member') AS member_count,
        count(*) FILTER (WHERE membership_status = 'nonmember') AS nonmember_count,
        count(*) FILTER (WHERE membership_status NOT IN ('member', 'nonmember')) AS other_count
      FROM reporting.current_membership
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(classification), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<BreakdownRow>(`
      /* reports:membership-by-department */
      SELECT
        COALESCE(NULLIF(trim(department), ''), 'Unspecified') AS label,
        sum(people_count) AS represented_count,
        sum(people_count) FILTER (WHERE membership_status = 'member') AS member_count,
        sum(people_count) FILTER (WHERE membership_status = 'nonmember') AS nonmember_count,
        sum(people_count) FILTER (WHERE membership_status NOT IN ('member', 'nonmember')) AS other_count
      FROM reporting.membership_by_department
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(department), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<BreakdownRow>(`
      /* reports:membership-by-work-location */
      SELECT
        COALESCE(NULLIF(trim(work_location), ''), 'Unspecified') AS label,
        sum(people_count) AS represented_count,
        sum(people_count) FILTER (WHERE membership_status = 'member') AS member_count,
        sum(people_count) FILTER (WHERE membership_status = 'nonmember') AS nonmember_count,
        sum(people_count) FILTER (WHERE membership_status NOT IN ('member', 'nonmember')) AS other_count
      FROM reporting.membership_by_work_location
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(work_location), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<BreakdownRow>(`
      /* reports:membership-by-job-status */
      SELECT
        COALESCE(NULLIF(trim(job_status), ''), 'Unspecified') AS label,
        sum(people_count) AS represented_count,
        sum(people_count) FILTER (WHERE membership_status = 'member') AS member_count,
        sum(people_count) FILTER (WHERE membership_status = 'nonmember') AS nonmember_count,
        sum(people_count) FILTER (WHERE membership_status NOT IN ('member', 'nonmember')) AS other_count
      FROM reporting.membership_by_job_status
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(job_status), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<DataQualityRow>(`
      /* reports:membership-data-quality */
      SELECT missing_names, missing_work_email
      FROM reporting.data_quality_summary
      WHERE organization_id = $1::uuid
      LIMIT 1
    `, [context.organizationId]),
  ]);

  const overviewRow = overviewRows[0];
  const representedCount = count(overviewRow?.represented_count);
  const memberCount = count(overviewRow?.member_count);

  return {
    overview: {
      representedCount,
      memberCount,
      nonmemberCount: count(overviewRow?.nonmember_count),
      otherCount: count(overviewRow?.other_count),
      membershipRate: rate(memberCount, representedCount),
      refreshedAt: timestamp(overviewRow?.refreshed_at ?? null),
    },
    monthlyChanges: changeRows
      .map((row) => ({
        month: dateOnly(row.month),
        additions: count(row.additions),
        drops: count(row.drops),
        netChange: signedCount(row.net_change),
      }))
      .reverse(),
    classifications: classificationRows.map(breakdown),
    departments: departmentRows.map(breakdown),
    workLocations: workLocationRows.map(breakdown),
    jobStatuses: jobStatusRows.map(breakdown),
    dataQuality: {
      missingNames: count(qualityRows[0]?.missing_names),
      missingWorkEmail: count(qualityRows[0]?.missing_work_email),
    },
  };
}

export async function getNewHireReport(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<NewHireReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const [overviewRows, engagementRows, monthlyRows, departmentRows, workLocationRows, jobStatusRows] = await Promise.all([
    query<NewHireOverviewRow>(`
      /* reports:new-hires-overview */
      SELECT
        COALESCE(sum(new_hires), 0) AS new_hires,
        COALESCE(sum(current_members), 0) AS current_members
      FROM reporting.new_hire_conversion
      WHERE organization_id = $1::uuid
    `, [context.organizationId]),
    query<NewHireEngagementRow>(`
      /* reports:new-hires-engagement */
      SELECT
        count(*) AS new_hires,
        count(*) FILTER (WHERE engagement_count > 0) AS engaged_count
      FROM reporting.new_hire_engagement
      WHERE organization_id = $1::uuid
    `, [context.organizationId]),
    query<NewHireTrendRow>(`
      /* reports:new-hires-monthly */
      SELECT hire_month, new_hires, current_members
      FROM reporting.new_hire_conversion
      WHERE organization_id = $1::uuid
      ORDER BY hire_month DESC
      LIMIT 12
    `, [context.organizationId]),
    query<NewHireBreakdownRow>(`
      /* reports:new-hires-by-department */
      SELECT
        COALESCE(NULLIF(trim(department), ''), 'Unspecified') AS label,
        count(*) AS new_hires
      FROM reporting.new_hires
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(department), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<NewHireBreakdownRow>(`
      /* reports:new-hires-by-work-location */
      SELECT
        COALESCE(NULLIF(trim(work_location), ''), 'Unspecified') AS label,
        count(*) AS new_hires
      FROM reporting.new_hires
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(work_location), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<NewHireBreakdownRow>(`
      /* reports:new-hires-by-job-status */
      SELECT
        COALESCE(NULLIF(trim(job_status), ''), 'Unspecified') AS label,
        count(*) AS new_hires
      FROM reporting.new_hires
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(job_status), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
  ]);

  const newHireCount = count(overviewRows[0]?.new_hires);
  const currentMemberCount = count(overviewRows[0]?.current_members);
  const engagementDenominator = count(engagementRows[0]?.new_hires);
  const engagedCount = Math.min(count(engagementRows[0]?.engaged_count), engagementDenominator);
  const notYetEngagedCount = Math.max(0, engagementDenominator - engagedCount);

  return {
    overview: {
      newHireCount,
      currentMemberCount,
      conversionRate: rate(currentMemberCount, newHireCount),
      engagedCount,
      notYetEngagedCount,
      engagementRate: rate(engagedCount, engagementDenominator),
    },
    monthly: monthlyRows
      .map((row) => {
        const newHires = count(row.new_hires);
        const currentMembers = count(row.current_members);
        return {
          month: dateOnly(row.hire_month),
          newHires,
          currentMembers,
          conversionRate: rate(currentMembers, newHires),
        };
      })
      .reverse(),
    departments: departmentRows.map((row) => ({ label: row.label, newHireCount: count(row.new_hires) })),
    workLocations: workLocationRows.map((row) => ({ label: row.label, newHireCount: count(row.new_hires) })),
    jobStatuses: jobStatusRows.map((row) => ({ label: row.label, newHireCount: count(row.new_hires) })),
  };
}


export async function getEngagementReport(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<EngagementReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const [
    overviewRows,
    followupOverviewRows,
    dailyRows,
    contactMethodRows,
    outcomeRows,
    departmentRows,
    workLocationRows,
    organizerRows,
    followupStatusRows,
    campaignCoverageRows,
  ] = await Promise.all([
    query<EngagementOverviewRow>(`
      /* reports:engagement-overview */
      SELECT
        COALESCE(sum(event_count), 0) AS event_count,
        count(*) AS active_organizers
      FROM reporting.engagement_by_organizer
      WHERE organization_id = $1::uuid
    `, [context.organizationId]),
    query<FollowupOverviewRow>(`
      /* reports:engagement-followup-overview */
      SELECT
        COALESCE(sum(followup_count), 0) AS followup_count,
        COALESCE(sum(followup_count) FILTER (WHERE lower(status) = 'open'), 0) AS open_followups
      FROM reporting.followups
      WHERE organization_id = $1::uuid
    `, [context.organizationId]),
    query<EngagementTrendRow>(`
      /* reports:engagement-over-time */
      SELECT engagement_date, event_count
      FROM reporting.engagement_over_time
      WHERE organization_id = $1::uuid
      ORDER BY engagement_date DESC
      LIMIT 30
    `, [context.organizationId]),
    query<EngagementBreakdownRow>(`
      /* reports:engagement-contact-methods */
      SELECT
        COALESCE(NULLIF(trim(contact_method), ''), 'Unspecified') AS label,
        sum(event_count) AS event_count
      FROM reporting.contact_methods
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(contact_method), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<EngagementBreakdownRow>(`
      /* reports:engagement-outcomes */
      SELECT
        COALESCE(NULLIF(trim(outcome), ''), 'Unspecified') AS label,
        count(*) AS event_count
      FROM local801.engagement_events
      WHERE organization_id = $1::uuid
        AND voided_at IS NULL
      GROUP BY COALESCE(NULLIF(trim(outcome), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<EngagementBreakdownRow>(`
      /* reports:engagement-by-department */
      SELECT
        COALESCE(NULLIF(trim(department), ''), 'Unspecified') AS label,
        sum(event_count) AS event_count
      FROM reporting.engagement_by_department
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(department), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<EngagementBreakdownRow>(`
      /* reports:engagement-by-work-location */
      SELECT
        COALESCE(NULLIF(trim(work_location), ''), 'Unspecified') AS label,
        sum(event_count) AS event_count
      FROM reporting.engagement_by_work_location
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(work_location), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<EngagementBreakdownRow>(`
      /* reports:engagement-by-organizer */
      SELECT
        COALESCE(NULLIF(trim(u.display_name), ''), 'Unknown organizer') AS label,
        sum(e.event_count) AS event_count
      FROM reporting.engagement_by_organizer e
      LEFT JOIN local801.users u
        ON u.id = e.organizer_user_id
       AND u.organization_id = e.organization_id
      WHERE e.organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(u.display_name), ''), 'Unknown organizer')
      ORDER BY label ASC
      LIMIT 50
    `, [context.organizationId]),
    query<FollowupStatusRow>(`
      /* reports:engagement-followup-status */
      SELECT
        COALESCE(NULLIF(trim(status), ''), 'Unspecified') AS label,
        sum(followup_count) AS followup_count
      FROM reporting.followups
      WHERE organization_id = $1::uuid
      GROUP BY COALESCE(NULLIF(trim(status), ''), 'Unspecified')
      ORDER BY label ASC
      LIMIT 20
    `, [context.organizationId]),
    query<CampaignCoverageRow>(`
      /* reports:engagement-campaign-coverage */
      SELECT
        c.name AS label,
        ec.assigned_count,
        ec.contacted_count
      FROM reporting.engagement_coverage ec
      JOIN local801.outreach_campaigns c
        ON c.id = ec.campaign_id
       AND c.organization_id = ec.organization_id
      WHERE ec.organization_id = $1::uuid
      ORDER BY c.name ASC
      LIMIT 50
    `, [context.organizationId]),
  ]);

  const followupCount = count(followupOverviewRows[0]?.followup_count);
  const openFollowupCount = Math.min(count(followupOverviewRows[0]?.open_followups), followupCount);
  const mapEngagementBreakdown = (row: EngagementBreakdownRow): EngagementBreakdown => ({
    label: row.label,
    eventCount: count(row.event_count),
  });

  return {
    overview: {
      eventCount: count(overviewRows[0]?.event_count),
      activeOrganizerCount: count(overviewRows[0]?.active_organizers),
      followupCount,
      openFollowupCount,
    },
    daily: dailyRows
      .map((row) => ({ date: dateOnly(row.engagement_date), eventCount: count(row.event_count) }))
      .reverse(),
    contactMethods: contactMethodRows.map(mapEngagementBreakdown),
    outcomes: outcomeRows.map(mapEngagementBreakdown),
    departments: departmentRows.map(mapEngagementBreakdown),
    workLocations: workLocationRows.map(mapEngagementBreakdown),
    organizers: organizerRows.map(mapEngagementBreakdown),
    followupStatuses: followupStatusRows.map((row) => ({
      label: row.label,
      followupCount: count(row.followup_count),
    })),
    campaignCoverage: campaignCoverageRows.map((row) => {
      const assignedCount = count(row.assigned_count);
      const contactedCount = Math.min(count(row.contacted_count), assignedCount);
      return {
        label: row.label,
        assignedCount,
        contactedCount,
        coverageRate: rate(contactedCount, assignedCount),
      };
    }),
  };
}

export const __testing = { count, rate, signedCount };
