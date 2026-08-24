import "server-only";

import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

type MetricValue = number | string;

export type DashboardMetrics = {
  represented: MetricValue;
  members: MetricValue;
  membershipPercentage: string;
  openAssignments: MetricValue;
  assignedAttention90: MetricValue;
  newHiresThisMonth: MetricValue;
  newHiresAwaitingFirstEngagement14: MetricValue;
  additionsThisMonth: MetricValue;
  dropsThisMonth: MetricValue;
  recentMembershipChanges7Days: MetricValue;
  overdueFollowups: MetricValue;
  followupsDueToday: MetricValue;
  upcomingFollowups: MetricValue;
  importsInReview: MetricValue;
  activeCampaigns: MetricValue;
  openCatActions: MetricValue;
  reportingDate: string;
  sourceSnapshot: string;
  source: "database" | "unavailable";
};

function rowToNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" || typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function unavailableMetrics(): DashboardMetrics {
  return {
    represented: "—",
    members: "—",
    membershipPercentage: "—",
    openAssignments: "—",
    assignedAttention90: "—",
    newHiresThisMonth: "—",
    newHiresAwaitingFirstEngagement14: "—",
    additionsThisMonth: "—",
    dropsThisMonth: "—",
    recentMembershipChanges7Days: "—",
    overdueFollowups: "—",
    followupsDueToday: "—",
    upcomingFollowups: "—",
    importsInReview: "—",
    activeCampaigns: "—",
    openCatActions: "—",
    reportingDate: new Date().toISOString().slice(0, 10),
    sourceSnapshot: "Database unavailable",
    source: "unavailable",
  };
}

export async function getDashboardMetrics(
  context: WorkspaceContext,
  query: DatabaseQuery = queryLocal801,
): Promise<DashboardMetrics> {
  // Trust contract: callers must pass a WorkspaceContext resolved from the validated
  // preview session. Every authenticated role may open Home; role-specific fields are
  // constrained here (assignment/follow-up scope) and selected for display by dashboardForRole.
  try {
    const [row] = await query<{
      organization_exists: boolean;
      represented: number | string;
      members: number | string;
      open_assignments: number | string;
      assigned_attention_90: number | string;
      new_hires_this_month: number | string;
      new_hires_awaiting_first_engagement_14: number | string;
      additions_this_month: number | string;
      drops_this_month: number | string;
      recent_membership_changes_7_days: number | string;
      overdue_followups: number | string;
      followups_due_today: number | string;
      upcoming_followups: number | string;
      imports_in_review: number | string;
      active_campaigns: number | string;
      open_cat_actions: number | string;
    }>(
      `
        /* dashboard:summary */
        WITH target_organization AS (
          SELECT id
          FROM local801.organizations
          WHERE id = $1::uuid AND archived_at IS NULL
        ),
        chicago_tomorrow AS (
          SELECT (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day') AT TIME ZONE 'America/Chicago' AS starts_at
        ),
        membership_counts AS (
          SELECT
            count(*) FILTER (WHERE membership_status IN ('member', 'nonmember')) AS represented,
            count(*) FILTER (WHERE membership_status = 'member') AS members
          FROM reporting.current_membership
          WHERE organization_id = $1::uuid
        ),
        assignment_counts AS (
          SELECT
            count(*) AS open_assignments,
            count(DISTINCT assignment.person_id) FILTER (WHERE NOT EXISTS (
              SELECT 1
              FROM local801.engagement_events event
              WHERE event.organization_id = assignment.organization_id
                AND event.person_id = assignment.person_id
                AND event.voided_at IS NULL
                AND event.occurred_at >= now() - interval '90 days'
            )) AS assigned_attention_90
          FROM local801.engagement_assignments assignment
          WHERE assignment.organization_id = $1::uuid
            AND assignment.status = 'open'
            AND assignment.archived_at IS NULL
            AND ($3::boolean OR assignment.primary_user_id = $2 OR assignment.backup_user_id = $2)
        ),
        new_hire_counts AS (
          SELECT count(*) AS new_hires_this_month
          FROM reporting.new_hires
          WHERE organization_id = $1::uuid
            AND hire_date >= date_trunc('month', current_date)
        ),
        new_hire_engagement_counts AS (
          SELECT count(*) AS new_hires_awaiting_first_engagement_14
          FROM reporting.new_hire_engagement
          WHERE organization_id = $1::uuid
            AND hire_date >= current_date - interval '90 days'
            AND hire_date <= current_date - interval '14 days'
            AND engagement_count = 0
        ),
        membership_change_counts AS (
          SELECT
            count(*) FILTER (WHERE event_type = 'addition' AND effective_date >= date_trunc('month', current_date)) AS additions_this_month,
            count(*) FILTER (WHERE event_type = 'drop' AND effective_date >= date_trunc('month', current_date)) AS drops_this_month,
            count(*) FILTER (WHERE effective_date >= current_date - interval '7 days') AS recent_membership_changes_7_days
          FROM local801.membership_events
          WHERE organization_id = $1::uuid
        ),
        followup_counts AS (
          SELECT
            count(*) FILTER (WHERE followup.due_at < now()) AS overdue_followups,
            count(*) FILTER (WHERE followup.due_at >= now() AND followup.due_at < tomorrow.starts_at) AS followups_due_today,
            count(*) FILTER (WHERE followup.due_at >= tomorrow.starts_at) AS upcoming_followups
          FROM local801.engagement_followups followup
          CROSS JOIN chicago_tomorrow tomorrow
          WHERE followup.organization_id = $1::uuid
            AND followup.status = 'open'
            AND followup.completed_at IS NULL
            AND (
              $3::boolean
              OR (
                followup.assigned_to = $2
                AND EXISTS (
                  SELECT 1
                  FROM local801.engagement_assignments assignment
                  WHERE assignment.organization_id = followup.organization_id
                    AND assignment.person_id = followup.person_id
                    AND assignment.archived_at IS NULL
                    AND assignment.status = 'open'
                    AND (assignment.primary_user_id = $2 OR assignment.backup_user_id = $2)
                )
              )
            )
        ),
        workspace_counts AS (
          SELECT
            (SELECT count(*) FROM local801.import_batches WHERE organization_id = $1::uuid AND state = 'under_review') AS imports_in_review,
            (SELECT count(*) FROM local801.outreach_campaigns WHERE organization_id = $1::uuid AND status = 'active' AND archived_at IS NULL) AS active_campaigns,
            (SELECT count(*) FROM local801.cat_actions WHERE organization_id = $1::uuid AND status = 'active' AND archived_at IS NULL) AS open_cat_actions
        )
        SELECT
          EXISTS (SELECT 1 FROM target_organization) AS organization_exists,
          membership_counts.represented,
          membership_counts.members,
          assignment_counts.open_assignments,
          assignment_counts.assigned_attention_90,
          new_hire_counts.new_hires_this_month,
          new_hire_engagement_counts.new_hires_awaiting_first_engagement_14,
          membership_change_counts.additions_this_month,
          membership_change_counts.drops_this_month,
          membership_change_counts.recent_membership_changes_7_days,
          followup_counts.overdue_followups,
          followup_counts.followups_due_today,
          followup_counts.upcoming_followups,
          workspace_counts.imports_in_review,
          workspace_counts.active_campaigns,
          workspace_counts.open_cat_actions
        FROM membership_counts
        CROSS JOIN assignment_counts
        CROSS JOIN new_hire_counts
        CROSS JOIN new_hire_engagement_counts
        CROSS JOIN membership_change_counts
        CROSS JOIN followup_counts
        CROSS JOIN workspace_counts
      `,
      [context.organizationId, context.userId, context.role !== "cat_member"],
    );

    if (!row?.organization_exists) return unavailableMetrics();
    const represented = rowToNumber(row.represented);
    const members = rowToNumber(row.members);

    return {
      represented,
      members,
      membershipPercentage: represented > 0 ? `${((members / represented) * 100).toFixed(1)}%` : "0.0%",
      openAssignments: rowToNumber(row.open_assignments),
      assignedAttention90: rowToNumber(row.assigned_attention_90),
      newHiresThisMonth: rowToNumber(row.new_hires_this_month),
      newHiresAwaitingFirstEngagement14: rowToNumber(row.new_hires_awaiting_first_engagement_14),
      additionsThisMonth: rowToNumber(row.additions_this_month),
      dropsThisMonth: rowToNumber(row.drops_this_month),
      recentMembershipChanges7Days: rowToNumber(row.recent_membership_changes_7_days),
      overdueFollowups: rowToNumber(row.overdue_followups),
      followupsDueToday: rowToNumber(row.followups_due_today),
      upcomingFollowups: rowToNumber(row.upcoming_followups),
      importsInReview: rowToNumber(row.imports_in_review),
      activeCampaigns: rowToNumber(row.active_campaigns),
      openCatActions: rowToNumber(row.open_cat_actions),
      reportingDate: new Date().toISOString().slice(0, 10),
      sourceSnapshot: process.env.VERCEL_ENV === "production" ? "Protected Local 801 database" : "Neon Preview database",
      source: "database",
    };
  } catch {
    return unavailableMetrics();
  }
}
