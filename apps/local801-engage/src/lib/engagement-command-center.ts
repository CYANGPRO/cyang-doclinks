import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type CommandCenterPeriod = "30d" | "90d" | "180d" | "all";
export type CommandCenterEmployeeGroup = "all" | "new-hires";
export type CommandCenterBreakdown = "department" | "work-location";
export type CommandCenterMembershipStatus = "member" | "nonmember" | "unknown";

export type CommandCenterFilters = {
  period: CommandCenterPeriod;
  department: string | null;
  workLocation: string | null;
  membershipStatus: CommandCenterMembershipStatus | null;
  employeeGroup: CommandCenterEmployeeGroup;
  breakdown: CommandCenterBreakdown;
};

export type CommandCenterFilterOptions = {
  departments: string[];
  workLocations: string[];
};

export type CommandCenterOverview = {
  representedCount: number;
  assignedCount: number;
  unassignedCount: number;
  everEngagedCount: number;
  neverEngagedCount: number;
  recentEngagedCount: number;
  stale90Count: number;
  coverageRate: number;
  recentCoverageRate: number;
  assignmentRate: number;
};

export type CommandCenterFollowups = {
  outstandingCount: number;
  overdueCount: number;
  dueSoonCount: number;
  completedCount: number;
  averageCloseDays: number | null;
};

export type CommandCenterNewHires = {
  hireCount: number;
  engagedWithin7Count: number;
  engagedWithin14Count: number;
  engagedWithin30Count: number;
  missed14DayTargetCount: number;
  within7Rate: number;
  within14Rate: number;
  within30Rate: number;
};

export type EngagementDepthRow = {
  label: "0 in period" | "1 in period" | "2–3 in period" | "4+ in period";
  employeeCount: number;
  employeeRate: number;
};

export type CoverageGapRow = {
  label: string;
  representedCount: number;
  everEngagedCount: number;
  recentEngagedCount: number;
  neverEngagedCount: number;
  coverageRate: number;
  recentCoverageRate: number;
};

export type OrganizerCoverageRow = {
  handle: string;
  label: string;
  assignedCount: number;
  reachedInPeriodCount: number;
  coverageRate: number;
  engagementEventCount: number;
  outstandingFollowupCount: number;
  overdueFollowupCount: number;
};

export type EmployeeActionReadinessOverview = {
  actionSignalCount: number;
  willingEmployeeCount: number;
  consideringEmployeeCount: number;
  completedEmployeeCount: number;
  declinesAllCount: number;
  specificDeclineEmployeeCount: number;
  noActionSignalCount: number;
  willingActionCount: number;
  completedActionCount: number;
  readinessCaptureRate: number;
  willingEmployeeRate: number;
};

export type EmployeeActionReadinessRow = {
  handle: string;
  label: string;
  engagementLevel: number;
  willingCount: number;
  consideringCount: number;
  declinedCount: number;
  completedCount: number;
  customResponses: Array<{ value: string; label: string; count: number }>;
};

export type EmployeeActionDepthRow = {
  label: "0 willing actions" | "1 willing action" | "2–3 willing actions" | "4+ willing actions";
  employeeCount: number;
  employeeRate: number;
};

export type EngagementCommandCenterReport = {
  filters: CommandCenterFilters;
  filterOptions: CommandCenterFilterOptions;
  overview: CommandCenterOverview;
  followups: CommandCenterFollowups;
  newHires: CommandCenterNewHires;
  depth: EngagementDepthRow[];
  departments: CoverageGapRow[];
  workLocations: CoverageGapRow[];
  organizers: OrganizerCoverageRow[];
  actionReadiness: EmployeeActionReadinessOverview;
  actionReadinessByAction: EmployeeActionReadinessRow[];
  actionReadinessDepth: EmployeeActionDepthRow[];
};

type OverviewRow = {
  represented_count: unknown;
  assigned_count: unknown;
  ever_engaged_count: unknown;
  recent_engaged_count: unknown;
  stale_90_count: unknown;
};

type FollowupRow = {
  outstanding_count: unknown;
  overdue_count: unknown;
  due_soon_count: unknown;
  completed_count: unknown;
  average_close_days: unknown;
};

type NewHireRow = {
  hire_count: unknown;
  engaged_within_7_count: unknown;
  engaged_within_14_count: unknown;
  engaged_within_30_count: unknown;
  missed_14_day_target_count: unknown;
};

type DepthRow = {
  depth_bucket: "never" | "one" | "two_three" | "four_plus";
  employee_count: unknown;
};

type CoverageRow = {
  label: string;
  represented_count: unknown;
  ever_engaged_count: unknown;
  recent_engaged_count: unknown;
};

type OrganizerRow = {
  user_id: string;
  organizer_handle: string;
  label: string;
  assigned_count: unknown;
  reached_in_period_count: unknown;
  engagement_event_count: unknown;
  outstanding_followup_count: unknown;
  overdue_followup_count: unknown;
};

type ActionReadinessOverviewRow = {
  action_signal_count: unknown;
  willing_employee_count: unknown;
  considering_employee_count: unknown;
  completed_employee_count: unknown;
  declines_all_count: unknown;
  specific_decline_employee_count: unknown;
  willing_action_count: unknown;
  completed_action_count: unknown;
};

type ActionReadinessByActionRow = {
  action_handle: string;
  label: string;
  engagement_level: unknown;
  willing_count: unknown;
  considering_count: unknown;
  declined_count: unknown;
  completed_count: unknown;
  custom_response_options: unknown;
  custom_response_counts: unknown;
};

type ActionReadinessDepthDatabaseRow = {
  willingness_bucket: "none" | "one" | "two_three" | "four_plus";
  employee_count: unknown;
};

type LabelRow = { label: string };

const PERIOD_DAYS: Record<Exclude<CommandCenterPeriod, "all">, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
};

function count(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 10) / 10 : null;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((Math.min(numerator, denominator) / denominator) * 1000) / 10 : 0;
}

function safeDimension(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function customResponseCounts(optionsValue: unknown, countsValue: unknown, maximum: number) {
  if (!Array.isArray(optionsValue)) return [];
  const counts = countsValue && typeof countsValue === "object" && !Array.isArray(countsValue)
    ? countsValue as Record<string, unknown>
    : {};
  return optionsValue.slice(0, 8).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const option = raw as Record<string, unknown>;
    const value = typeof option.value === "string" && /^custom:[0-9a-f]{32}$/.test(option.value) ? option.value : null;
    const label = typeof option.label === "string" ? option.label.trim().slice(0, 40) : "";
    if (!value || !label) return [];
    return [{ value, label, count: Math.min(count(counts[value]), maximum) }];
  });
}

export function parseCommandCenterFilters(input: Record<string, string | string[] | undefined>): CommandCenterFilters {
  const scalar = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const periodValue = scalar(input.period);
  const membershipValue = scalar(input.membership);
  const groupValue = scalar(input.group);
  const breakdownValue = scalar(input.breakdown);

  return {
    period: periodValue === "30d" || periodValue === "90d" || periodValue === "180d" || periodValue === "all" ? periodValue : "30d",
    department: safeDimension(scalar(input.department)),
    workLocation: safeDimension(scalar(input.location)),
    membershipStatus: membershipValue === "member" || membershipValue === "nonmember" || membershipValue === "unknown" ? membershipValue : null,
    employeeGroup: groupValue === "new-hires" ? "new-hires" : "all",
    breakdown: breakdownValue === "work-location" ? "work-location" : "department",
  };
}

function periodDays(period: CommandCenterPeriod) {
  return period === "all" ? null : PERIOD_DAYS[period];
}

function cohortCte() {
  return `
    WITH cohort AS (
      SELECT membership.person_id
      FROM reporting.current_membership membership
      WHERE membership.organization_id = $1::uuid
        AND ($2::text IS NULL OR COALESCE(NULLIF(trim(membership.department), ''), 'Unspecified') = $2::text)
        AND ($3::text IS NULL OR COALESCE(NULLIF(trim(membership.work_location), ''), 'Unspecified') = $3::text)
        AND ($4::text IS NULL OR membership.membership_status = $4::text)
        AND (
          $5::text = 'all'
          OR EXISTS (
            SELECT 1
            FROM reporting.new_hires hire
            WHERE hire.organization_id = membership.organization_id
              AND hire.person_id = membership.person_id
              AND ($6::integer IS NULL OR hire.hire_date >= current_date - $6::integer)
          )
        )
    )`;
}

function baseParameters(context: WorkspaceContext, filters: CommandCenterFilters) {
  return [
    context.organizationId,
    filters.department,
    filters.workLocation,
    filters.membershipStatus,
    filters.employeeGroup,
    periodDays(filters.period),
  ] as const;
}

function mapCoverage(row: CoverageRow): CoverageGapRow {
  const representedCount = count(row.represented_count);
  const everEngagedCount = Math.min(count(row.ever_engaged_count), representedCount);
  const recentEngagedCount = Math.min(count(row.recent_engaged_count), representedCount);
  return {
    label: row.label,
    representedCount,
    everEngagedCount,
    recentEngagedCount,
    neverEngagedCount: Math.max(0, representedCount - everEngagedCount),
    coverageRate: rate(everEngagedCount, representedCount),
    recentCoverageRate: rate(recentEngagedCount, representedCount),
  };
}

export async function getEngagementCommandCenterReport(
  context: WorkspaceContext,
  rawFilters: Record<string, string | string[] | undefined> = {},
  query: DatabaseQuery = queryLocal801,
): Promise<EngagementCommandCenterReport> {
  if (!can(context.role, "viewReports")) throw new Error("Forbidden.");

  const filters = parseCommandCenterFilters(rawFilters);
  const parameters = baseParameters(context, filters);

  const [
    departmentOptionRows,
    locationOptionRows,
    overviewRows,
    followupRows,
    newHireRows,
    depthRows,
    departmentRows,
    locationRows,
    organizerRows,
    actionReadinessOverviewRows,
    actionReadinessByActionRows,
    actionReadinessDepthRows,
  ] = await Promise.all([
    query<LabelRow>(`
      /* reports:command-center-department-options */
      SELECT DISTINCT COALESCE(NULLIF(trim(department), ''), 'Unspecified') AS label
      FROM reporting.current_membership
      WHERE organization_id = $1::uuid
      ORDER BY label ASC
      LIMIT 100
    `, [context.organizationId]),
    query<LabelRow>(`
      /* reports:command-center-location-options */
      SELECT DISTINCT COALESCE(NULLIF(trim(work_location), ''), 'Unspecified') AS label
      FROM reporting.current_membership
      WHERE organization_id = $1::uuid
      ORDER BY label ASC
      LIMIT 100
    `, [context.organizationId]),
    query<OverviewRow>(`
      /* reports:command-center-overview */
      ${cohortCte()},
      engagement AS (
        SELECT
          event.person_id,
          max(event.occurred_at) AS last_engagement_at,
          count(*) FILTER (
            WHERE $6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer)
          ) AS recent_event_count
        FROM local801.engagement_events event
        JOIN cohort ON cohort.person_id = event.person_id
        WHERE event.organization_id = $1::uuid
          AND event.voided_at IS NULL
        GROUP BY event.person_id
      ),
      assignments AS (
        SELECT DISTINCT assignment.person_id
        FROM local801.engagement_assignments assignment
        JOIN cohort ON cohort.person_id = assignment.person_id
        WHERE assignment.organization_id = $1::uuid
          AND assignment.archived_at IS NULL
      )
      SELECT
        count(*) AS represented_count,
        count(*) FILTER (WHERE assignments.person_id IS NOT NULL) AS assigned_count,
        count(*) FILTER (WHERE engagement.person_id IS NOT NULL) AS ever_engaged_count,
        count(*) FILTER (WHERE engagement.recent_event_count > 0) AS recent_engaged_count,
        count(*) FILTER (
          WHERE engagement.last_engagement_at IS NOT NULL
            AND engagement.last_engagement_at < now() - interval '90 days'
        ) AS stale_90_count
      FROM cohort
      LEFT JOIN engagement ON engagement.person_id = cohort.person_id
      LEFT JOIN assignments ON assignments.person_id = cohort.person_id
    `, parameters),
    query<FollowupRow>(`
      /* reports:command-center-followups */
      ${cohortCte()}
      SELECT
        count(*) FILTER (WHERE followup.completed_at IS NULL) AS outstanding_count,
        count(*) FILTER (WHERE followup.completed_at IS NULL AND followup.due_at < now()) AS overdue_count,
        count(*) FILTER (
          WHERE followup.completed_at IS NULL
            AND followup.due_at >= now()
            AND followup.due_at < now() + interval '7 days'
        ) AS due_soon_count,
        count(*) FILTER (WHERE followup.completed_at IS NOT NULL) AS completed_count,
        avg(extract(epoch FROM (followup.completed_at - followup.created_at)) / 86400.0)
          FILTER (WHERE followup.completed_at IS NOT NULL AND followup.completed_at >= followup.created_at) AS average_close_days
      FROM local801.engagement_followups followup
      JOIN cohort ON cohort.person_id = followup.person_id
      WHERE followup.organization_id = $1::uuid
    `, parameters),
    query<NewHireRow>(`
      /* reports:command-center-new-hire-timeliness */
      ${cohortCte()},
      hires AS (
        SELECT hire.person_id, max(hire.hire_date) AS hire_date
        FROM reporting.new_hires hire
        JOIN cohort ON cohort.person_id = hire.person_id
        WHERE hire.organization_id = $1::uuid
          AND ($6::integer IS NULL OR hire.hire_date >= current_date - $6::integer)
        GROUP BY hire.person_id
      ),
      first_engagement AS (
        SELECT
          hire.person_id,
          hire.hire_date,
          min(event.occurred_at) FILTER (WHERE event.occurred_at::date >= hire.hire_date) AS first_engagement_at
        FROM hires hire
        LEFT JOIN local801.engagement_events event
          ON event.organization_id = $1::uuid
         AND event.person_id = hire.person_id
         AND event.voided_at IS NULL
        GROUP BY hire.person_id, hire.hire_date
      )
      SELECT
        count(*) AS hire_count,
        count(*) FILTER (WHERE first_engagement_at::date <= hire_date + 7) AS engaged_within_7_count,
        count(*) FILTER (WHERE first_engagement_at::date <= hire_date + 14) AS engaged_within_14_count,
        count(*) FILTER (WHERE first_engagement_at::date <= hire_date + 30) AS engaged_within_30_count,
        count(*) FILTER (
          WHERE (first_engagement_at IS NULL AND current_date > hire_date + 14)
             OR first_engagement_at::date > hire_date + 14
        ) AS missed_14_day_target_count
      FROM first_engagement
    `, parameters),
    query<DepthRow>(`
      /* reports:command-center-engagement-depth */
      ${cohortCte()},
      person_depth AS (
        SELECT
          cohort.person_id,
          count(event.id) FILTER (
            WHERE event.voided_at IS NULL
              AND ($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer))
          ) AS event_count
        FROM cohort
        LEFT JOIN local801.engagement_events event
          ON event.organization_id = $1::uuid
         AND event.person_id = cohort.person_id
        GROUP BY cohort.person_id
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN event_count = 0 THEN 'never'
            WHEN event_count = 1 THEN 'one'
            WHEN event_count BETWEEN 2 AND 3 THEN 'two_three'
            ELSE 'four_plus'
          END AS depth_bucket
        FROM person_depth
      )
      SELECT depth_bucket, count(*) AS employee_count
      FROM bucketed
      GROUP BY depth_bucket
      ORDER BY CASE depth_bucket WHEN 'never' THEN 1 WHEN 'one' THEN 2 WHEN 'two_three' THEN 3 ELSE 4 END
    `, parameters),
    query<CoverageRow>(`
      /* reports:command-center-coverage-by-department */
      ${cohortCte()},
      scoped AS (
        SELECT
          cohort.person_id,
          COALESCE(NULLIF(trim(membership.department), ''), 'Unspecified') AS label
        FROM cohort
        JOIN reporting.current_membership membership
          ON membership.organization_id = $1::uuid
         AND membership.person_id = cohort.person_id
      ),
      engagement AS (
        SELECT
          scoped.person_id,
          scoped.label,
          bool_or(true) AS ever_engaged,
          bool_or($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer)) AS recent_engaged
        FROM scoped
        JOIN local801.engagement_events event
          ON event.organization_id = $1::uuid
         AND event.person_id = scoped.person_id
         AND event.voided_at IS NULL
        GROUP BY scoped.person_id, scoped.label
      )
      SELECT
        scoped.label,
        count(*) AS represented_count,
        count(*) FILTER (WHERE engagement.ever_engaged) AS ever_engaged_count,
        count(*) FILTER (WHERE engagement.recent_engaged) AS recent_engaged_count
      FROM scoped
      LEFT JOIN engagement ON engagement.person_id = scoped.person_id AND engagement.label = scoped.label
      GROUP BY scoped.label
      ORDER BY represented_count DESC, scoped.label ASC
      LIMIT 50
    `, parameters),
    query<CoverageRow>(`
      /* reports:command-center-coverage-by-work-location */
      ${cohortCte()},
      scoped AS (
        SELECT
          cohort.person_id,
          COALESCE(NULLIF(trim(membership.work_location), ''), 'Unspecified') AS label
        FROM cohort
        JOIN reporting.current_membership membership
          ON membership.organization_id = $1::uuid
         AND membership.person_id = cohort.person_id
      ),
      engagement AS (
        SELECT
          scoped.person_id,
          scoped.label,
          bool_or(true) AS ever_engaged,
          bool_or($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer)) AS recent_engaged
        FROM scoped
        JOIN local801.engagement_events event
          ON event.organization_id = $1::uuid
         AND event.person_id = scoped.person_id
         AND event.voided_at IS NULL
        GROUP BY scoped.person_id, scoped.label
      )
      SELECT
        scoped.label,
        count(*) AS represented_count,
        count(*) FILTER (WHERE engagement.ever_engaged) AS ever_engaged_count,
        count(*) FILTER (WHERE engagement.recent_engaged) AS recent_engaged_count
      FROM scoped
      LEFT JOIN engagement ON engagement.person_id = scoped.person_id AND engagement.label = scoped.label
      GROUP BY scoped.label
      ORDER BY represented_count DESC, scoped.label ASC
      LIMIT 50
    `, parameters),
    query<OrganizerRow>(`
      /* reports:command-center-organizer-coverage */
      ${cohortCte()},
      organizer_assignments AS (
        SELECT assignment.primary_user_id AS organizer_user_id, assignment.person_id
        FROM local801.engagement_assignments assignment
        JOIN cohort ON cohort.person_id = assignment.person_id
        WHERE assignment.organization_id = $1::uuid
          AND assignment.archived_at IS NULL
          AND assignment.primary_user_id IS NOT NULL
      ),
      assigned_summary AS (
        SELECT
          organizer_user_id,
          count(DISTINCT person_id) AS assigned_count,
          count(DISTINCT person_id) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM local801.engagement_events event
              WHERE event.organization_id = $1::uuid
                AND event.person_id = organizer_assignments.person_id
                AND event.voided_at IS NULL
                AND ($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer))
            )
          ) AS reached_in_period_count
        FROM organizer_assignments
        GROUP BY organizer_user_id
      ),
      organizer_events AS (
        SELECT event.recorded_by AS organizer_user_id, count(*) AS engagement_event_count
        FROM local801.engagement_events event
        JOIN cohort ON cohort.person_id = event.person_id
        WHERE event.organization_id = $1::uuid
          AND event.voided_at IS NULL
          AND ($6::integer IS NULL OR event.occurred_at >= now() - make_interval(days => $6::integer))
        GROUP BY event.recorded_by
      ),
      organizer_followups AS (
        SELECT
          followup.assigned_to AS organizer_user_id,
          count(*) FILTER (WHERE followup.completed_at IS NULL) AS outstanding_followup_count,
          count(*) FILTER (WHERE followup.completed_at IS NULL AND followup.due_at < now()) AS overdue_followup_count
        FROM local801.engagement_followups followup
        JOIN cohort ON cohort.person_id = followup.person_id
        WHERE followup.organization_id = $1::uuid
          AND followup.assigned_to IS NOT NULL
        GROUP BY followup.assigned_to
      ),
      organizer_ids AS (
        SELECT organizer_user_id FROM assigned_summary
        UNION
        SELECT organizer_user_id FROM organizer_events
        UNION
        SELECT organizer_user_id FROM organizer_followups
      )
      SELECT
        organizer_ids.organizer_user_id::text AS user_id,
        encode(public.digest('user:' || $1::text || ':' || organizer_ids.organizer_user_id::text, 'sha256'), 'hex') AS organizer_handle,
        COALESCE(NULLIF(trim(user_record.display_name), ''), 'Unknown organizer') AS label,
        COALESCE(sum(assigned_summary.assigned_count), 0) AS assigned_count,
        COALESCE(sum(assigned_summary.reached_in_period_count), 0) AS reached_in_period_count,
        COALESCE(sum(organizer_events.engagement_event_count), 0) AS engagement_event_count,
        COALESCE(sum(organizer_followups.outstanding_followup_count), 0) AS outstanding_followup_count,
        COALESCE(sum(organizer_followups.overdue_followup_count), 0) AS overdue_followup_count
      FROM organizer_ids
      LEFT JOIN local801.users user_record
        ON user_record.id = organizer_ids.organizer_user_id
       AND user_record.organization_id = $1::uuid
      LEFT JOIN assigned_summary ON assigned_summary.organizer_user_id = organizer_ids.organizer_user_id
      LEFT JOIN organizer_events ON organizer_events.organizer_user_id = organizer_ids.organizer_user_id
      LEFT JOIN organizer_followups ON organizer_followups.organizer_user_id = organizer_ids.organizer_user_id
      GROUP BY organizer_ids.organizer_user_id, COALESCE(NULLIF(trim(user_record.display_name), ''), 'Unknown organizer')
      ORDER BY assigned_count DESC, label ASC
      LIMIT 50
    `, parameters),
    query<ActionReadinessOverviewRow>(`
      /* reports:command-center-action-readiness-overview */
      ${cohortCte()},
      person_readiness AS (
        SELECT
          cohort.person_id,
          COALESCE(readiness.declines_all_actions, false) AS declines_all_actions,
          COALESCE(readiness.willing_action_count, 0) AS willing_action_count,
          COALESCE(readiness.considering_action_count, 0) AS considering_action_count,
          COALESCE(readiness.declined_action_count, 0) AS declined_action_count,
          COALESCE(readiness.completed_action_count, 0) AS completed_action_count,
          COALESCE(readiness.custom_action_count, 0) AS custom_action_count
        FROM cohort
        LEFT JOIN reporting.employee_action_person_readiness readiness
          ON readiness.organization_id = $1::uuid
         AND readiness.person_id = cohort.person_id
      )
      SELECT
        count(*) FILTER (
          WHERE declines_all_actions
             OR willing_action_count > 0
             OR considering_action_count > 0
             OR declined_action_count > 0
             OR completed_action_count > 0
             OR custom_action_count > 0
        ) AS action_signal_count,
        count(*) FILTER (WHERE willing_action_count > 0) AS willing_employee_count,
        count(*) FILTER (WHERE willing_action_count = 0 AND considering_action_count > 0) AS considering_employee_count,
        count(*) FILTER (WHERE completed_action_count > 0) AS completed_employee_count,
        count(*) FILTER (WHERE declines_all_actions) AS declines_all_count,
        count(*) FILTER (WHERE declined_action_count > 0) AS specific_decline_employee_count,
        COALESCE(sum(willing_action_count), 0) AS willing_action_count,
        COALESCE(sum(completed_action_count), 0) AS completed_action_count
      FROM person_readiness
    `, parameters),
    query<ActionReadinessByActionRow>(`
      /* reports:command-center-action-readiness-by-action */
      ${cohortCte()},
      scoped_response AS (
        SELECT response.person_id, response.action_id, response.response_status
        FROM reporting.employee_action_current_responses response
        JOIN cohort ON cohort.person_id = response.person_id
        WHERE response.organization_id = $1::uuid
      ), custom_counts AS (
        SELECT action_id, jsonb_object_agg(response_status, response_count) AS response_counts
        FROM (
          SELECT action_id, response_status, count(DISTINCT person_id) AS response_count
          FROM scoped_response
          WHERE response_status LIKE 'custom:%'
          GROUP BY action_id, response_status
        ) counted
        GROUP BY action_id
      )
      SELECT
        encode(public.digest($1::text || ':' || action.id::text, 'sha256'), 'hex') AS action_handle,
        action.name AS label,
        action.engagement_level,
        count(DISTINCT scoped_response.person_id) FILTER (WHERE scoped_response.response_status = 'willing') AS willing_count,
        count(DISTINCT scoped_response.person_id) FILTER (WHERE scoped_response.response_status = 'considering') AS considering_count,
        count(DISTINCT scoped_response.person_id) FILTER (WHERE scoped_response.response_status = 'declined') AS declined_count,
        count(DISTINCT scoped_response.person_id) FILTER (WHERE scoped_response.response_status = 'completed') AS completed_count,
        action.custom_response_options,
        COALESCE(custom_counts.response_counts, '{}'::jsonb) AS custom_response_counts
      FROM local801.employee_actions action
      LEFT JOIN scoped_response
        ON scoped_response.action_id = action.id
      LEFT JOIN custom_counts ON custom_counts.action_id = action.id
      WHERE action.organization_id = $1::uuid
        AND action.archived_at IS NULL
      GROUP BY action.id, action.name, action.engagement_level, action.custom_response_options, custom_counts.response_counts
      ORDER BY action.engagement_level ASC, action.name ASC
      LIMIT 50
    `, parameters),
    query<ActionReadinessDepthDatabaseRow>(`
      /* reports:command-center-action-readiness-depth */
      ${cohortCte()},
      willingness_depth AS (
        SELECT
          cohort.person_id,
          count(DISTINCT response.action_id) FILTER (WHERE response.response_status = 'willing') AS willing_count
        FROM cohort
        LEFT JOIN reporting.employee_action_current_responses response
          ON response.organization_id = $1::uuid
         AND response.person_id = cohort.person_id
        GROUP BY cohort.person_id
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN willing_count = 0 THEN 'none'
            WHEN willing_count = 1 THEN 'one'
            WHEN willing_count BETWEEN 2 AND 3 THEN 'two_three'
            ELSE 'four_plus'
          END AS willingness_bucket
        FROM willingness_depth
      )
      SELECT willingness_bucket, count(*) AS employee_count
      FROM bucketed
      GROUP BY willingness_bucket
      ORDER BY CASE willingness_bucket WHEN 'none' THEN 1 WHEN 'one' THEN 2 WHEN 'two_three' THEN 3 ELSE 4 END
    `, parameters),
  ]);

  const overviewRow = overviewRows[0];
  const representedCount = count(overviewRow?.represented_count);
  const assignedCount = Math.min(count(overviewRow?.assigned_count), representedCount);
  const everEngagedCount = Math.min(count(overviewRow?.ever_engaged_count), representedCount);
  const recentEngagedCount = Math.min(count(overviewRow?.recent_engaged_count), representedCount);
  const stale90Count = Math.min(count(overviewRow?.stale_90_count), everEngagedCount);

  const followupRow = followupRows[0];
  const outstandingCount = count(followupRow?.outstanding_count);
  const overdueCount = Math.min(count(followupRow?.overdue_count), outstandingCount);
  const dueSoonCount = Math.min(count(followupRow?.due_soon_count), Math.max(0, outstandingCount - overdueCount));

  const newHireRow = newHireRows[0];
  const hireCount = count(newHireRow?.hire_count);
  const engagedWithin7Count = Math.min(count(newHireRow?.engaged_within_7_count), hireCount);
  const engagedWithin14Count = Math.min(count(newHireRow?.engaged_within_14_count), hireCount);
  const engagedWithin30Count = Math.min(count(newHireRow?.engaged_within_30_count), hireCount);

  const depthCounts = new Map(depthRows.map((row) => [row.depth_bucket, count(row.employee_count)]));
  const depthDefinitions: Array<[DepthRow["depth_bucket"], EngagementDepthRow["label"]]> = [
    ["never", "0 in period"],
    ["one", "1 in period"],
    ["two_three", "2–3 in period"],
    ["four_plus", "4+ in period"],
  ];

  const actionReadinessRow = actionReadinessOverviewRows[0];
  const actionSignalCount = Math.min(count(actionReadinessRow?.action_signal_count), representedCount);
  const willingEmployeeCount = Math.min(count(actionReadinessRow?.willing_employee_count), representedCount);
  const consideringEmployeeCount = Math.min(count(actionReadinessRow?.considering_employee_count), Math.max(0, representedCount - willingEmployeeCount));
  const completedEmployeeCount = Math.min(count(actionReadinessRow?.completed_employee_count), representedCount);
  const declinesAllCount = Math.min(count(actionReadinessRow?.declines_all_count), representedCount);
  const specificDeclineEmployeeCount = Math.min(count(actionReadinessRow?.specific_decline_employee_count), representedCount);
  const actionDepthCounts = new Map(actionReadinessDepthRows.map((row) => [row.willingness_bucket, count(row.employee_count)]));
  const actionDepthDefinitions: Array<[ActionReadinessDepthDatabaseRow["willingness_bucket"], EmployeeActionDepthRow["label"]]> = [
    ["none", "0 willing actions"],
    ["one", "1 willing action"],
    ["two_three", "2–3 willing actions"],
    ["four_plus", "4+ willing actions"],
  ];

  return {
    filters,
    filterOptions: {
      departments: departmentOptionRows.map((row) => row.label),
      workLocations: locationOptionRows.map((row) => row.label),
    },
    overview: {
      representedCount,
      assignedCount,
      unassignedCount: Math.max(0, representedCount - assignedCount),
      everEngagedCount,
      neverEngagedCount: Math.max(0, representedCount - everEngagedCount),
      recentEngagedCount,
      stale90Count,
      coverageRate: rate(everEngagedCount, representedCount),
      recentCoverageRate: rate(recentEngagedCount, representedCount),
      assignmentRate: rate(assignedCount, representedCount),
    },
    followups: {
      outstandingCount,
      overdueCount,
      dueSoonCount,
      completedCount: count(followupRow?.completed_count),
      averageCloseDays: nullableNumber(followupRow?.average_close_days),
    },
    newHires: {
      hireCount,
      engagedWithin7Count,
      engagedWithin14Count,
      engagedWithin30Count,
      missed14DayTargetCount: Math.min(count(newHireRow?.missed_14_day_target_count), hireCount),
      within7Rate: rate(engagedWithin7Count, hireCount),
      within14Rate: rate(engagedWithin14Count, hireCount),
      within30Rate: rate(engagedWithin30Count, hireCount),
    },
    depth: depthDefinitions.map(([bucket, label]) => {
      const employeeCount = depthCounts.get(bucket) ?? 0;
      return { label, employeeCount, employeeRate: rate(employeeCount, representedCount) };
    }),
    departments: departmentRows.map(mapCoverage),
    workLocations: locationRows.map(mapCoverage),
    organizers: organizerRows.map((row) => {
      const assigned = count(row.assigned_count);
      const reached = Math.min(count(row.reached_in_period_count), assigned);
      return {
        handle: row.organizer_handle,
        label: row.label,
        assignedCount: assigned,
        reachedInPeriodCount: reached,
        coverageRate: rate(reached, assigned),
        engagementEventCount: count(row.engagement_event_count),
        outstandingFollowupCount: count(row.outstanding_followup_count),
        overdueFollowupCount: count(row.overdue_followup_count),
      };
    }),
    actionReadiness: {
      actionSignalCount,
      willingEmployeeCount,
      consideringEmployeeCount,
      completedEmployeeCount,
      declinesAllCount,
      specificDeclineEmployeeCount,
      noActionSignalCount: Math.max(0, representedCount - actionSignalCount),
      willingActionCount: count(actionReadinessRow?.willing_action_count),
      completedActionCount: count(actionReadinessRow?.completed_action_count),
      readinessCaptureRate: rate(actionSignalCount, everEngagedCount),
      willingEmployeeRate: rate(willingEmployeeCount, representedCount),
    },
    actionReadinessByAction: actionReadinessByActionRows.map((row) => ({
      handle: row.action_handle,
      label: row.label,
      engagementLevel: Math.min(5, Math.max(1, Math.trunc(count(row.engagement_level) || 1))),
      willingCount: Math.min(count(row.willing_count), representedCount),
      consideringCount: Math.min(count(row.considering_count), representedCount),
      declinedCount: Math.min(count(row.declined_count), representedCount),
      completedCount: Math.min(count(row.completed_count), representedCount),
      customResponses: customResponseCounts(row.custom_response_options, row.custom_response_counts, representedCount),
    })),
    actionReadinessDepth: actionDepthDefinitions.map(([bucket, label]) => {
      const employeeCount = Math.min(actionDepthCounts.get(bucket) ?? 0, representedCount);
      return { label, employeeCount, employeeRate: rate(employeeCount, representedCount) };
    }),
  };
}

export const __testing = { count, nullableNumber, rate, safeDimension, customResponseCounts };
