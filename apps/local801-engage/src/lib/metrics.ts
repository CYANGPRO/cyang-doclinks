import "server-only";

import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

type MetricValue = number | string;

export type DashboardMetrics = {
  represented: MetricValue;
  members: MetricValue;
  membershipPercentage: string;
  openAssignments: MetricValue;
  newHiresThisMonth: MetricValue;
  additionsThisMonth: MetricValue;
  dropsThisMonth: MetricValue;
  overdueFollowups: MetricValue;
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
    newHiresThisMonth: "—",
    additionsThisMonth: "—",
    dropsThisMonth: "—",
    overdueFollowups: "—",
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
  // constrained here (assignment scope) and selected for display by dashboardForRole.
  try {
    const [row] = await query<{
      organization_exists: boolean;
      represented: number | string;
      members: number | string;
      open_assignments: number | string;
      new_hires_this_month: number | string;
      additions_this_month: number | string;
      drops_this_month: number | string;
      overdue_followups: number | string;
      imports_in_review: number | string;
      active_campaigns: number | string;
      open_cat_actions: number | string;
    }>(
      `
        WITH target_organization AS (SELECT $1::uuid AS id)
        SELECT
          EXISTS (SELECT 1 FROM target_organization) AS organization_exists,
          (SELECT count(*) FROM reporting.current_membership m JOIN target_organization o ON o.id = m.organization_id WHERE m.membership_status IN ('member', 'nonmember')) AS represented,
          (SELECT count(*) FROM reporting.current_membership m JOIN target_organization o ON o.id = m.organization_id WHERE m.membership_status = 'member') AS members,
          (SELECT count(*) FROM local801.engagement_assignments a JOIN target_organization o ON o.id = a.organization_id
            WHERE a.status = 'open' AND a.archived_at IS NULL
              AND ($3::boolean OR a.primary_user_id = $2 OR a.backup_user_id = $2)) AS open_assignments,
          (SELECT count(*) FROM reporting.new_hires h JOIN target_organization o ON o.id = h.organization_id WHERE h.hire_date >= date_trunc('month', current_date)) AS new_hires_this_month,
          (SELECT count(*) FROM local801.membership_events e JOIN target_organization o ON o.id = e.organization_id WHERE e.event_type = 'addition' AND e.effective_date >= date_trunc('month', current_date)) AS additions_this_month,
          (SELECT count(*) FROM local801.membership_events e JOIN target_organization o ON o.id = e.organization_id WHERE e.event_type = 'drop' AND e.effective_date >= date_trunc('month', current_date)) AS drops_this_month,
          (SELECT count(*) FROM local801.engagement_followups f JOIN target_organization o ON o.id = f.organization_id
            WHERE f.status = 'open' AND f.due_at < now()
              AND ($3::boolean OR f.assigned_to = $2)) AS overdue_followups,
          (SELECT count(*) FROM local801.import_batches b JOIN target_organization o ON o.id = b.organization_id WHERE b.state = 'under_review') AS imports_in_review,
          (SELECT count(*) FROM local801.outreach_campaigns c JOIN target_organization o ON o.id = c.organization_id WHERE c.status = 'active' AND c.archived_at IS NULL) AS active_campaigns,
          (SELECT count(*) FROM local801.cat_actions c JOIN target_organization o ON o.id = c.organization_id WHERE c.status = 'active' AND c.archived_at IS NULL) AS open_cat_actions
      `,
      [context.organizationId, context.userId, !["cat_lead", "cat_member"].includes(context.role)],
    );

    if (!row?.organization_exists) return unavailableMetrics();
    const represented = rowToNumber(row.represented);
    const members = rowToNumber(row.members);

    return {
      represented,
      members,
      membershipPercentage: represented > 0 ? `${((members / represented) * 100).toFixed(1)}%` : "0.0%",
      openAssignments: rowToNumber(row.open_assignments),
      newHiresThisMonth: rowToNumber(row.new_hires_this_month),
      additionsThisMonth: rowToNumber(row.additions_this_month),
      dropsThisMonth: rowToNumber(row.drops_this_month),
      overdueFollowups: rowToNumber(row.overdue_followups),
      importsInReview: rowToNumber(row.imports_in_review),
      activeCampaigns: rowToNumber(row.active_campaigns),
      openCatActions: rowToNumber(row.open_cat_actions),
      reportingDate: new Date().toISOString().slice(0, 10),
      sourceSnapshot: process.env.VERCEL_ENV === "production" ? "Protected Local 801 database" : "Neon synthetic preview",
      source: "database",
    };
  } catch {
    return unavailableMetrics();
  }
}
