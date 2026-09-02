import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCatActionReport, __testing } from "../src/lib/cat-action-reports.ts";

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
    if (sql.includes("reports:cat-actions-overview")) return [{
      action_count: "1",
      active_action_count: "1",
      task_count: "1",
      open_task_count: "1",
      completed_task_count: "0",
      overdue_task_count: "0",
      participant_count: "0",
    }];
    if (sql.includes("reports:cat-actions-statuses")) return [{ status: "active", action_count: "1" }];
    if (sql.includes("reports:cat-actions-task-statuses")) return [{ status: "open", task_count: "1" }];
    if (sql.includes("reports:cat-actions-performance")) return [{
      handle: "a".repeat(64),
      name: "Synthetic Contract Action",
      status: "active",
      task_count: "1",
      open_task_count: "1",
      completed_task_count: "0",
      overdue_task_count: "0",
      participant_count: "0",
    }];
    throw new Error("Unexpected CAT action report query");
  };
  return { calls, query };
}

test("CAT action reporting is available to every viewReports role", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "report_viewer"]) {
    const { calls, query } = reportQueryRecorder();
    const report = await getCatActionReport(context(role), query);
    assert.equal(calls.length, 4);
    assert.equal(report.overview.actionCount, 1);
    assert.equal(report.overview.activeActionCount, 1);
    assert.equal(report.overview.taskCount, 1);
    assert.equal(report.overview.openTaskCount, 1);
    assert.equal(report.overview.completionRate, 0);
  }
});

test("CAT members fail before any CAT action report SQL runs", async () => {
  let calls = 0;
  await assert.rejects(getCatActionReport(context("cat_member"), async () => { calls += 1; return []; }), /Forbidden/);
  assert.equal(calls, 0);
});

test("CAT action report queries are organization scoped and aggregate-only", async () => {
  const { calls, query } = reportQueryRecorder();
  await getCatActionReport(context("report_viewer"), query);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.deepEqual(call.parameters, [organizationId]);
    assert.match(call.sql, /organization_id = \$1::uuid/);
    assert.doesNotMatch(call.sql, /first_name|last_name|contact_value|identifier_value|note_hash|strategy_hash/i);
  }
});

test("CAT action report excludes archived actions and bounds outputs", async () => {
  const { calls, query } = reportQueryRecorder();
  await getCatActionReport(context(), query);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-overview")).sql, /status <> 'archived'/);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-overview")).sql, /archived_at IS NULL/);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-overview")).sql, /count\(DISTINCT task\.assigned_to\)/);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-statuses")).sql, /LIMIT 20/);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-task-statuses")).sql, /LIMIT 20/);
  assert.match(calls.find((call) => call.sql.includes("reports:cat-actions-performance")).sql, /LIMIT 50/);
});

test("CAT action counts and rates are clamped to valid denominators", async () => {
  const { query } = reportQueryRecorder();
  const custom = async (sql, params) => {
    if (sql.includes("reports:cat-actions-overview")) return [{
      action_count: 1,
      active_action_count: 1,
      task_count: 2,
      open_task_count: 9,
      completed_task_count: 8,
      overdue_task_count: 7,
      participant_count: 6,
    }];
    if (sql.includes("reports:cat-actions-performance")) return [{
      handle: "a".repeat(64),
      name: "Synthetic Contract Action",
      status: "active",
      task_count: 2,
      open_task_count: 9,
      completed_task_count: 8,
      overdue_task_count: 7,
      participant_count: 6,
    }];
    return query(sql, params);
  };
  const report = await getCatActionReport(context(), custom);
  assert.equal(report.overview.openTaskCount, 2);
  assert.equal(report.overview.completedTaskCount, 2);
  assert.equal(report.overview.overdueTaskCount, 2);
  assert.equal(report.overview.participantCount, 2);
  assert.equal(report.overview.completionRate, 100);
  assert.equal(report.actions[0].completionRate, 100);
});

test("CAT action report model does not expose internal IDs or assignee data", async () => {
  const { query } = reportQueryRecorder();
  const report = await getCatActionReport(context(), query);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /catActionId|cat_action_id|assignedTo|assigned_to|userId|personId/i);
  assert.deepEqual(report.actions[0], {
    handle: "a".repeat(64),
    name: "Synthetic Contract Action",
    status: "active",
    taskCount: 1,
    openTaskCount: 1,
    completedTaskCount: 0,
    overdueTaskCount: 0,
    participantCount: 0,
    completionRate: 0,
  });
});

test("numeric normalization remains finite", () => {
  assert.equal(__testing.count("7"), 7);
  assert.equal(__testing.count(-3), 0);
  assert.equal(__testing.count("nope"), 0);
  assert.equal(__testing.rate(1, 4), 25);
  assert.equal(__testing.rate(0, 0), 0);
});

test("Reports page makes CAT Actions a ready navigation tab and renders aggregate CAT action reporting", () => {
  const source = readFileSync(new URL("../src/app/reports/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\"cat-actions\"/);
  assert.match(source, /getCatActionReport/);
  assert.match(source, /CAT Action totals/);
  assert.match(source, /CAT Actions by status/);
  assert.match(source, /Tasks by status/);
  assert.match(source, /CAT Action performance/);
  assert.match(source, /viewReports/);
  assert.doesNotMatch(source, /catActionId|assignedTo|personId|strategyHash/i);
});
