import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getEngagementReport, getMembershipReport, getNewHireReport, __testing } from "../src/lib/reports.ts";
import { reportValueLabel } from "../src/lib/report-labels.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: `${role}@example.test`,
  role,
});

function reportQueryRecorder() {
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("reports:membership-overview")) return [{ represented_count: "8", member_count: "5", nonmember_count: "2", other_count: "1", refreshed_at: "2026-08-14T12:00:00.000Z" }];
    if (sql.includes("reports:membership-monthly-changes")) return [{ month: "2026-08-01", additions: "2", drops: "1", net_change: "1" }];
    if (sql.includes("reports:membership-by-classification")) return [{ label: "Management Analyst 4", represented_count: "2", member_count: "1", nonmember_count: "1", other_count: "0" }];
    if (sql.includes("reports:membership-by-department")) return [{ label: "Health Licensing", represented_count: "2", member_count: "2", nonmember_count: "0", other_count: "0" }];
    if (sql.includes("reports:membership-by-work-location")) return [{ label: "Downtown", represented_count: "2", member_count: "2", nonmember_count: "0", other_count: "0" }];
    if (sql.includes("reports:membership-data-quality")) return [{ missing_names: "0", missing_work_email: "0" }];
    if (sql.includes("reports:new-hires-overview")) return [{ new_hires: "2", current_members: "2" }];
    if (sql.includes("reports:new-hires-engagement")) return [{ new_hires: "2", engaged_count: "0" }];
    if (sql.includes("reports:new-hires-monthly")) return [{ hire_month: "2026-08-01", new_hires: "2", current_members: "2" }];
    if (sql.includes("reports:new-hires-by-department")) return [{ label: "Customer Support", new_hires: "1" }, { label: "Environmental Review", new_hires: "1" }];
    if (sql.includes("reports:new-hires-by-work-location")) return [{ label: "East Office", new_hires: "1" }, { label: "West Office", new_hires: "1" }];
    if (sql.includes("reports:engagement-overview")) return [{ event_count: "1", active_organizers: "1" }];
    if (sql.includes("reports:engagement-followup-overview")) return [{ followup_count: "1", open_followups: "1" }];
    if (sql.includes("reports:engagement-over-time")) return [{ engagement_date: "2026-08-13", event_count: "1" }];
    if (sql.includes("reports:engagement-contact-methods")) return [{ label: "email", event_count: "1" }];
    if (sql.includes("reports:engagement-outcomes")) return [{ label: "contacted", event_count: "1" }];
    if (sql.includes("reports:engagement-by-department")) return [{ label: "Health Licensing", event_count: "1" }];
    if (sql.includes("reports:engagement-by-work-location")) return [{ label: "Downtown", event_count: "1" }];
    if (sql.includes("reports:engagement-by-organizer")) return [{ label: "Synthetic CAT Lead", event_count: "1" }];
    if (sql.includes("reports:engagement-followup-status")) return [{ label: "open", followup_count: "1" }];
    if (sql.includes("reports:engagement-campaign-coverage")) return [{ label: "Synthetic Member Outreach", assigned_count: "4", contacted_count: "1" }];
    throw new Error("Unexpected report query");
  };
  return { calls, query };
}

test("aggregate membership report remains available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = reportQueryRecorder();
    const report = await getMembershipReport(context(role), query);
    assert.equal(calls.length, 6);
    assert.equal(report.overview.representedCount, 8);
    assert.equal(report.overview.membershipRate, 62.5);
    assert.equal(report.classifications[0].label, "Management Analyst 4");
  }
});

test("aggregate new-hire report is available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = reportQueryRecorder();
    const report = await getNewHireReport(context(role), query);
    assert.equal(calls.length, 5);
    assert.equal(report.overview.newHireCount, 2);
    assert.equal(report.overview.currentMemberCount, 2);
    assert.equal(report.overview.conversionRate, 100);
    assert.equal(report.overview.engagedCount, 0);
    assert.equal(report.overview.notYetEngagedCount, 2);
  }
});

test("aggregate engagement report is available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = reportQueryRecorder();
    const report = await getEngagementReport(context(role), query);
    assert.equal(calls.length, 10);
    assert.deepEqual(report.overview, { eventCount: 1, activeOrganizerCount: 1, followupCount: 1, openFollowupCount: 1 });
    assert.equal(report.campaignCoverage[0].coverageRate, 25);
  }
});

test("roles without viewReports fail before any report SQL runs", async () => {
  for (const fn of [getMembershipReport, getNewHireReport, getEngagementReport]) {
    let calls = 0;
    await assert.rejects(fn(context("cat_member"), async () => { calls += 1; return []; }), /Forbidden/);
    assert.equal(calls, 0);
  }
});

test("every new-hire query is organization scoped, reporting-view based, and aggregate-only", async () => {
  const { calls, query } = reportQueryRecorder();
  await getNewHireReport(context("report_viewer"), query);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.deepEqual(call.parameters, [organizationId]);
    assert.match(call.sql, /organization_id = \$1::uuid/);
    assert.match(call.sql, /reporting\./);
    assert.doesNotMatch(call.sql, /SELECT[^;]*person_id|first_name|last_name|contact_value|identifier_value/is);
  }
});

test("new-hire trend and breakdown queries are bounded", async () => {
  const { calls, query } = reportQueryRecorder();
  await getNewHireReport(context(), query);
  assert.match(calls.find((call) => call.sql.includes("reports:new-hires-monthly")).sql, /LIMIT 12/);
  assert.match(calls.find((call) => call.sql.includes("reports:new-hires-by-department")).sql, /LIMIT 50/);
  assert.match(calls.find((call) => call.sql.includes("reports:new-hires-by-work-location")).sql, /LIMIT 50/);
  assert.equal(calls.some((call) => call.sql.includes("job-status")), false);
});

test("new-hire monthly cohorts return chronologically with bounded conversion rates", async () => {
  const { query } = reportQueryRecorder();
  const custom = async (sql, params) => {
    if (sql.includes("reports:new-hires-monthly")) {
      return [
        { hire_month: "2026-08-01", new_hires: 2, current_members: 1 },
        { hire_month: "2026-07-01", new_hires: 1, current_members: 1 },
      ];
    }
    return query(sql, params);
  };
  const report = await getNewHireReport(context(), custom);
  assert.deepEqual(report.monthly.map((row) => row.month), ["2026-07-01", "2026-08-01"]);
  assert.deepEqual(report.monthly.map((row) => row.conversionRate), [100, 50]);
});

test("new-hire engagement count cannot exceed its denominator", async () => {
  const { query } = reportQueryRecorder();
  const custom = async (sql, params) => sql.includes("reports:new-hires-engagement")
    ? [{ new_hires: 2, engaged_count: 5 }]
    : query(sql, params);
  const report = await getNewHireReport(context(), custom);
  assert.equal(report.overview.engagedCount, 2);
  assert.equal(report.overview.notYetEngagedCount, 0);
  assert.equal(report.overview.engagementRate, 100);
});


test("every engagement query is organization scoped and returns aggregate dimensions only", async () => {
  const { calls, query } = reportQueryRecorder();
  const report = await getEngagementReport(context("report_viewer"), query);
  assert.equal(calls.length, 10);
  for (const call of calls) {
    assert.deepEqual(call.parameters, [organizationId]);
    assert.match(call.sql, /organization_id = \$1::uuid/);
    if (!call.sql.includes("reports:engagement-outcomes")) assert.match(call.sql, /reporting\./);
    else assert.match(call.sql, /FROM local801\.engagement_events/);
    assert.doesNotMatch(call.sql, /AS\s+(person_id|organizer_user_id|campaign_id)\b/i);
  }
  assert.deepEqual(report.organizers, [{ label: "Synthetic CAT Lead", eventCount: 1 }]);
  assert.equal("organizerUserId" in report.organizers[0], false);
  assert.equal("campaignId" in report.campaignCoverage[0], false);
});

test("engagement trend and breakdown queries are bounded", async () => {
  const { calls, query } = reportQueryRecorder();
  await getEngagementReport(context(), query);
  assert.match(calls.find((call) => call.sql.includes("reports:engagement-over-time")).sql, /LIMIT 30/);
  for (const marker of ["engagement-contact-methods", "engagement-outcomes", "engagement-by-department", "engagement-by-work-location", "engagement-by-organizer", "engagement-campaign-coverage"]) {
    assert.match(calls.find((call) => call.sql.includes(`reports:${marker}`)).sql, /LIMIT 50/);
  }
  assert.match(calls.find((call) => call.sql.includes("reports:engagement-followup-status")).sql, /LIMIT 20/);
});

test("engagement coverage and open follow-up counts are safely bounded", async () => {
  const { query } = reportQueryRecorder();
  const custom = async (sql, params) => {
    if (sql.includes("reports:engagement-followup-overview")) return [{ followup_count: 2, open_followups: 9 }];
    if (sql.includes("reports:engagement-campaign-coverage")) return [{ label: "Campaign", assigned_count: 2, contacted_count: 7 }];
    return query(sql, params);
  };
  const report = await getEngagementReport(context(), custom);
  assert.equal(report.overview.openFollowupCount, 2);
  assert.deepEqual(report.campaignCoverage[0], { label: "Campaign", assignedCount: 2, contactedCount: 2, coverageRate: 100 });
});

test("numeric normalization remains finite", () => {
  assert.equal(__testing.count("7"), 7);
  assert.equal(__testing.count(-3), 0);
  assert.equal(__testing.count("nope"), 0);
  assert.equal(__testing.signedCount("-2"), -2);
  assert.equal(__testing.rate(5, 8), 62.5);
  assert.equal(__testing.rate(0, 0), 0);
});

test("Outreach activity labels use readable spelling and capitalization", () => {
  assert.equal(reportValueLabel("in_person"), "In person");
  assert.equal(reportValueLabel("left_message"), "Left message");
  assert.equal(reportValueLabel("contacted"), "Contacted");
  assert.equal(reportValueLabel("in_progress"), "In progress");
  assert.equal(reportValueLabel("  due-today  "), "Due today");
  assert.equal(reportValueLabel(""), "Unspecified");

  const source = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Contact methods[\s\S]*reportValueLabel/);
  assert.match(source, /Contact outcomes[\s\S]*reportValueLabel/);
  assert.match(source, /statusLabel\(row\.label\)/);
});

test("Reports page provides real navigation for ready reports and New Hires dashboard content", () => {
  const source = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(source, /tab\.key === "data-quality" \? "\/reports\/data-quality" : `\/reports\?view=\$\{tab\.key\}`/);
  assert.match(source, /aria-current/);
  assert.match(source, /New-hire membership and contact totals/);
  assert.match(source, /Outreach activity/);
  assert.match(source, /Recorded contacts by day/);
  assert.match(source, /Contact methods/);
  assert.match(source, /Contact outcomes/);
  assert.match(source, /Activity by organizer/);
  assert.match(source, /Campaign contact coverage/);
  assert.match(source, /getEngagementReport/);
  assert.match(source, /New hires by hire month/);
  assert.match(source, /New hires by department/);
  assert.match(source, /New hires by work location/);
  assert.doesNotMatch(source, /job status|jobStatuses/i);
  assert.match(source, /getNewHireReport/);
  assert.match(source, /viewReports/);
  assert.doesNotMatch(source, /personId|firstName|lastName|identifierValue|employeeId/i);
});
