import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCampaignReport, __testing } from "../src/lib/campaign-reports.ts";

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
    if (sql.includes("reports:campaign-overview")) return [{ campaign_count: "1", active_campaign_count: "1", population_count: "4", assigned_count: "4", contacted_count: "1", completed_count: "0" }];
    if (sql.includes("reports:campaign-statuses")) return [{ status: "active", campaign_count: "1" }];
    if (sql.includes("reports:campaign-performance")) return [{ name: "Synthetic Member Outreach", status: "active", population_count: "4", assigned_count: "4", contacted_count: "1", completed_count: "0" }];
    throw new Error("Unexpected campaign report query");
  };
  return { calls, query };
}

test("campaign reporting is available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = recorder();
    const report = await getCampaignReport(context(role), query);
    assert.equal(calls.length, 3);
    assert.equal(report.overview.campaignCount, 1);
    assert.equal(report.overview.coverageRate, 25);
    assert.equal(report.campaigns[0].name, "Synthetic Member Outreach");
  }
});

test("CAT members fail before any campaign report SQL runs", async () => {
  let calls = 0;
  await assert.rejects(getCampaignReport(context("cat_member"), async () => { calls += 1; return []; }), /Forbidden/);
  assert.equal(calls, 0);
});

test("campaign report queries are organization scoped and aggregate-only", async () => {
  const { calls, query } = recorder();
  await getCampaignReport(context("report_viewer"), query);
  for (const call of calls) {
    assert.deepEqual(call.parameters, [organizationId]);
    assert.match(call.sql, /organization_id = \$1::uuid/);
    assert.doesNotMatch(call.sql, /first_name|last_name|contact_value|identifier_value|note_hash|person_id\s+AS/i);
  }
});

test("campaign report excludes archived campaigns and bounds detail/status outputs", async () => {
  const { calls, query } = recorder();
  await getCampaignReport(context(), query);
  const statuses = calls.find((call) => call.sql.includes("reports:campaign-statuses"));
  const performance = calls.find((call) => call.sql.includes("reports:campaign-performance"));
  for (const call of calls) assert.match(call.sql, /status <> 'archived'/);
  assert.match(statuses.sql, /LIMIT 20/);
  assert.match(performance.sql, /LIMIT 50/);
});

test("coverage and completion ratios are clamped to valid denominators", () => {
  const row = __testing.performance({ name: "A", status: "active", population_count: 4, assigned_count: 9, contacted_count: 8, completed_count: 7 });
  assert.equal(row.assignedCount, 4);
  assert.equal(row.contactedCount, 4);
  assert.equal(row.completedCount, 4);
  assert.equal(row.assignmentRate, 100);
  assert.equal(row.coverageRate, 100);
  assert.equal(row.completionRate, 100);
  assert.equal(__testing.rate(1, 4), 25);
});

test("campaign report model does not expose internal campaign or person IDs", async () => {
  const { query } = recorder();
  const report = await getCampaignReport(context(), query);
  assert.equal(JSON.stringify(report).includes("campaignId"), false);
  assert.equal(JSON.stringify(report).includes("personId"), false);
});

test("Reports page makes Campaigns a ready navigation tab and renders campaign reporting", () => {
  const source = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(source, /getCampaignReport/);
  assert.match(source, /"campaigns"/);
  assert.match(source, /Campaign overview/);
  assert.match(source, /Campaign performance/);
  assert.match(source, /Campaign status/);
  assert.match(source, /view === "campaigns"/);
  assert.doesNotMatch(source, /Campaigns · upcoming/);
});
