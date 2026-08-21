import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getEngagementCommandCenterReport,
  parseCommandCenterFilters,
  __testing,
} from "../src/lib/engagement-command-center.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: `${role}@example.test`,
  role,
});

function recorder() {
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("reports:command-center-department-options")) return [{ label: "Health Licensing" }, { label: "Field Operations" }];
    if (sql.includes("reports:command-center-location-options")) return [{ label: "Downtown" }, { label: "South Campus" }];
    if (sql.includes("reports:command-center-overview")) return [{ represented_count: 8, assigned_count: 4, ever_engaged_count: 1, recent_engaged_count: 1, stale_90_count: 0 }];
    if (sql.includes("reports:command-center-followups")) return [{ outstanding_count: 1, overdue_count: 1, due_soon_count: 0, completed_count: 0, average_close_days: null }];
    if (sql.includes("reports:command-center-new-hire-timeliness")) return [{ hire_count: 2, engaged_within_7_count: 0, engaged_within_14_count: 0, engaged_within_30_count: 0, missed_14_day_target_count: 0 }];
    if (sql.includes("reports:command-center-engagement-depth")) return [{ depth_bucket: "never", employee_count: 7 }, { depth_bucket: "one", employee_count: 1 }];
    if (sql.includes("reports:command-center-coverage-by-department")) return [
      { label: "Health Licensing", represented_count: 2, ever_engaged_count: 1, recent_engaged_count: 1 },
      { label: "Field Operations", represented_count: 1, ever_engaged_count: 0, recent_engaged_count: 0 },
    ];
    if (sql.includes("reports:command-center-coverage-by-work-location")) return [
      { label: "Downtown", represented_count: 2, ever_engaged_count: 1, recent_engaged_count: 1 },
      { label: "South Campus", represented_count: 1, ever_engaged_count: 0, recent_engaged_count: 0 },
    ];
    if (sql.includes("reports:command-center-organizer-coverage")) return [{
      label: "Synthetic CAT Lead",
      assigned_count: 4,
      reached_in_period_count: 1,
      engagement_event_count: 1,
      outstanding_followup_count: 1,
      overdue_followup_count: 1,
    }];
    if (sql.includes("reports:command-center-action-readiness-overview")) return [{
      action_signal_count: 3,
      willing_employee_count: 2,
      considering_employee_count: 1,
      completed_employee_count: 1,
      declines_all_count: 1,
      specific_decline_employee_count: 1,
      willing_action_count: 3,
      completed_action_count: 1,
    }];
    if (sql.includes("reports:command-center-action-readiness-by-action")) return [
      { label: "Attend a meeting", engagement_level: 1, willing_count: 2, considering_count: 0, declined_count: 1, completed_count: 1 },
      { label: "Talk with a coworker", engagement_level: 2, willing_count: 1, considering_count: 1, declined_count: 0, completed_count: 0 },
    ];
    if (sql.includes("reports:command-center-action-readiness-depth")) return [
      { willingness_bucket: "none", employee_count: 6 },
      { willingness_bucket: "one", employee_count: 1 },
      { willingness_bucket: "two_three", employee_count: 1 },
    ];
    throw new Error("Unexpected command-center query");
  };
  return { calls, query };
}

test("command center is available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = recorder();
    const report = await getEngagementCommandCenterReport(context(role), {}, query);
    assert.equal(calls.length, 12);
    assert.equal(report.overview.representedCount, 8);
    assert.equal(report.overview.assignedCount, 4);
    assert.equal(report.overview.everEngagedCount, 1);
    assert.equal(report.overview.coverageRate, 12.5);
    assert.equal(report.overview.assignmentRate, 50);
    assert.equal(report.actionReadiness.willingEmployeeCount, 2);
    assert.equal(report.actionReadiness.completedEmployeeCount, 1);
    assert.equal(report.actionReadiness.willingEmployeeRate, 25);
  }
});

test("CAT members fail before any command-center SQL runs", async () => {
  let calls = 0;
  await assert.rejects(getEngagementCommandCenterReport(context("cat_member"), {}, async () => { calls += 1; return []; }), /Forbidden/);
  assert.equal(calls, 0);
});

test("filters are allowlisted, bounded, and safe for URL-driven reporting", () => {
  assert.deepEqual(parseCommandCenterFilters({}), {
    period: "30d",
    department: null,
    workLocation: null,
    membershipStatus: null,
    employeeGroup: "all",
    breakdown: "department",
  });
  assert.deepEqual(parseCommandCenterFilters({
    period: "90d",
    department: " Health Licensing ",
    location: "Downtown",
    membership: "member",
    group: "new-hires",
    breakdown: "work-location",
  }), {
    period: "90d",
    department: "Health Licensing",
    workLocation: "Downtown",
    membershipStatus: "member",
    employeeGroup: "new-hires",
    breakdown: "work-location",
  });
  assert.equal(parseCommandCenterFilters({ department: "x".repeat(121) }).department, null);
  assert.equal(parseCommandCenterFilters({ location: "bad\nvalue" }).workLocation, null);
  assert.equal(parseCommandCenterFilters({ period: "365d", membership: "admin" }).period, "30d");
  assert.equal(parseCommandCenterFilters({ period: "365d", membership: "admin" }).membershipStatus, null);
});

test("every command-center query is organization scoped and filtered queries are parameterized", async () => {
  const { calls, query } = recorder();
  await getEngagementCommandCenterReport(context(), {
    period: "90d",
    department: "Health Licensing",
    location: "Downtown",
    membership: "member",
    group: "new-hires",
  }, query);
  assert.equal(calls.length, 12);
  assert.deepEqual(calls[0].parameters, [organizationId]);
  assert.deepEqual(calls[1].parameters, [organizationId]);
  for (const call of calls.slice(2)) {
    assert.deepEqual(call.parameters, [organizationId, "Health Licensing", "Downtown", "member", "new-hires", 90]);
    assert.match(call.sql, /organization_id = \$1::uuid/);
  }
});

test("coverage is based on distinct represented employees rather than event volume", async () => {
  const { query } = recorder();
  const report = await getEngagementCommandCenterReport(context(), {}, query);
  assert.equal(report.overview.neverEngagedCount, 7);
  assert.equal(report.overview.unassignedCount, 4);
  assert.equal(report.overview.recentCoverageRate, 12.5);
  assert.deepEqual(report.depth, [
    { label: "0 in period", employeeCount: 7, employeeRate: 87.5 },
    { label: "1 in period", employeeCount: 1, employeeRate: 12.5 },
    { label: "2–3 in period", employeeCount: 0, employeeRate: 0 },
    { label: "4+ in period", employeeCount: 0, employeeRate: 0 },
  ]);
  assert.equal(report.organizers[0].coverageRate, 25);
  assert.equal(report.organizers[0].engagementEventCount, 1);
  assert.equal(report.actionReadiness.actionSignalCount, 3);
  assert.equal(report.actionReadiness.readinessCaptureRate, 100);
  assert.equal(report.actionReadiness.noActionSignalCount, 5);
  assert.equal(report.actionReadiness.willingActionCount, 3);
  assert.equal(report.actionReadiness.completedActionCount, 1);
  assert.equal(report.actionReadinessByAction[0].completedCount, 1);
  assert.deepEqual(report.actionReadinessDepth, [
    { label: "0 willing actions", employeeCount: 6, employeeRate: 75 },
    { label: "1 willing action", employeeCount: 1, employeeRate: 12.5 },
    { label: "2–3 willing actions", employeeCount: 1, employeeRate: 12.5 },
    { label: "4+ willing actions", employeeCount: 0, employeeRate: 0 },
  ]);
});

test("follow-up and new-hire metrics use defensible timestamp fields and clamp invalid counts", async () => {
  const { query } = recorder();
  const custom = async (sql, params) => {
    if (sql.includes("reports:command-center-followups")) return [{ outstanding_count: 2, overdue_count: 9, due_soon_count: 8, completed_count: 3, average_close_days: "2.666" }];
    if (sql.includes("reports:command-center-new-hire-timeliness")) return [{ hire_count: 2, engaged_within_7_count: 5, engaged_within_14_count: 7, engaged_within_30_count: 8, missed_14_day_target_count: 6 }];
    return query(sql, params);
  };
  const report = await getEngagementCommandCenterReport(context(), {}, custom);
  assert.equal(report.followups.overdueCount, 2);
  assert.equal(report.followups.dueSoonCount, 0);
  assert.equal(report.followups.averageCloseDays, 2.7);
  assert.equal(report.newHires.engagedWithin7Count, 2);
  assert.equal(report.newHires.engagedWithin14Count, 2);
  assert.equal(report.newHires.engagedWithin30Count, 2);
  assert.equal(report.newHires.missed14DayTargetCount, 2);
  assert.equal(report.newHires.within14Rate, 100);
});

test("command-center SQL explicitly measures stale engagement, post-hire contact, and overdue follow-ups", async () => {
  const { calls, query } = recorder();
  await getEngagementCommandCenterReport(context(), {}, query);
  const overview = calls.find((call) => call.sql.includes("reports:command-center-overview")).sql;
  const followups = calls.find((call) => call.sql.includes("reports:command-center-followups")).sql;
  const hires = calls.find((call) => call.sql.includes("reports:command-center-new-hire-timeliness")).sql;
  const organizers = calls.find((call) => call.sql.includes("reports:command-center-organizer-coverage")).sql;
  const actionReadiness = calls.find((call) => call.sql.includes("reports:command-center-action-readiness-overview")).sql;
  const actionByAction = calls.find((call) => call.sql.includes("reports:command-center-action-readiness-by-action")).sql;
  const actionDepth = calls.find((call) => call.sql.includes("reports:command-center-action-readiness-depth")).sql;
  assert.match(overview, /interval '90 days'/);
  assert.match(overview, /assignment\.archived_at IS NULL/);
  assert.match(followups, /completed_at IS NULL AND followup\.due_at < now\(\)/);
  assert.match(hires, /event\.occurred_at::date >= hire\.hire_date/);
  assert.match(hires, /current_date > hire_date \+ 14/);
  assert.match(hires, /first_engagement_at::date > hire_date \+ 14/);
  assert.match(organizers, /assignment\.primary_user_id/);
  assert.match(organizers, /count\(DISTINCT person_id\)/);
  assert.match(actionReadiness, /employee_action_person_readiness/);
  assert.match(actionReadiness, /declines_all_actions/);
  assert.match(actionReadiness, /willing_action_count/);
  assert.match(actionReadiness, /completed_action_count/);
  assert.match(actionByAction, /FROM local801\.employee_actions action/);
  assert.match(actionByAction, /response\.action_id/);
  assert.match(actionByAction, /response\.response_status/);
  assert.match(actionDepth, /count\(DISTINCT response\.action_id\)/);
  assert.match(actionDepth, /response\.response_status = 'willing'/);
});

test("aggregate report model exposes no employee, assignment, follow-up, campaign, or organizer IDs", async () => {
  const { query } = recorder();
  const report = await getEngagementCommandCenterReport(context(), {}, query);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /personId|person_id|userId|user_id|assignmentId|assignment_id|followupId|followup_id|campaignId|campaign_id/i);
  assert.equal(report.organizers[0].label, "Synthetic CAT Lead");
});

test("breakdowns and filter option queries are bounded", async () => {
  const { calls, query } = recorder();
  await getEngagementCommandCenterReport(context(), {}, query);
  assert.match(calls.find((call) => call.sql.includes("department-options")).sql, /LIMIT 100/);
  assert.match(calls.find((call) => call.sql.includes("location-options")).sql, /LIMIT 100/);
  assert.match(calls.find((call) => call.sql.includes("coverage-by-department")).sql, /LIMIT 50/);
  assert.match(calls.find((call) => call.sql.includes("coverage-by-work-location")).sql, /LIMIT 50/);
  assert.match(calls.find((call) => call.sql.includes("organizer-coverage")).sql, /LIMIT 50/);
  assert.match(calls.find((call) => call.sql.includes("action-readiness-by-action")).sql, /LIMIT 50/);
});

test("normalization remains finite and denominator-safe", () => {
  assert.equal(__testing.count("7"), 7);
  assert.equal(__testing.count(-2), 0);
  assert.equal(__testing.rate(3, 8), 37.5);
  assert.equal(__testing.rate(12, 8), 100);
  assert.equal(__testing.rate(1, 0), 0);
  assert.equal(__testing.nullableNumber("2.666"), 2.7);
});

test("Reports page makes Overview the default and renders the dynamic engagement command center", () => {
  const page = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("../src/components/EngagementCommandCenter.tsx", import.meta.url), "utf8");
  assert.match(page, /"overview"/);
  assert.match(page, /getEngagementCommandCenterReport/);
  assert.match(page, /EngagementCommandCenter/);
  assert.match(page, /: "overview"/);
  assert.match(component, /Engagement filters/);
  assert.match(component, /Coverage journey/);
  assert.match(component, /Needs attention/);
  assert.match(component, /Engagement depth/);
  assert.match(component, /Coverage gaps/);
  assert.match(component, /Follow-up health/);
  assert.match(component, /New-hire contact timeliness/);
  assert.match(component, /CAT team coverage/);
  assert.match(component, /Employee action readiness/);
  assert.match(component, /Willingness by action/);
  assert.match(component, /Action willingness depth/);
  assert.match(component, /Declines all actions/);
  assert.match(component, /Completed an action/);
  assert.match(component, /Completed action selections/);
  assert.match(component, /method="get"/);
  assert.match(component, /name="period"/);
  assert.match(component, /name="department"/);
  assert.match(component, /name="location"/);
  assert.match(component, /name="membership"/);
  assert.match(component, /name="group"/);
});


test("Reports navigation makes the selected view explicit and keeps mobile tabs to one scrollable row", () => {
  const page = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Viewing <strong/);
  assert.match(page, /overflowX: "auto"/);
  assert.match(page, /flex: "0 0 auto"/);
  assert.match(page, /className=\{activeView === tab\.key \? "button" : "button secondary"\}/);
  assert.match(page, /aria-current=\{activeView === tab\.key \? "page" : undefined\}/);
});

test("Reports view routing keeps Overview and New hires on separate render paths", () => {
  const page = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(view === "overview"\) \{/);
  assert.match(page, /const report = await getEngagementCommandCenterReport\(context, params\)/);
  assert.match(page, /commandCenterReport = await hydrateCommandCenterReportFromProtectedPii\(context\.organizationId, report\)/);
  assert.match(page, /else if \(view === "new-hires"\) newHireReport = await getNewHireReport/);
  assert.match(page, /\{view === "overview" \? \(/);
  assert.match(page, /: view === "new-hires" \? \(/);
  assert.ok(page.indexOf('{view === "overview" ? (') < page.indexOf(': view === "new-hires" ? ('));
});
