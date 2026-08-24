import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CatActionInputError,
  __testing,
  getCatActionDetail,
  getCatActionsPage,
  getCatActionTasksPage,
  normalizeCatActionPortfolioInput,
  normalizeCatActionTaskInput,
} from "../src/lib/cat-actions.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const context = (role = "cat_admin") => ({ organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role });
const actionHandle = "a".repeat(64);

function handle(index) {
  return index.toString(16).padStart(64, "0");
}

function portfolioRow(index, overrides = {}) {
  return {
    action_handle: handle(index),
    name: `Synthetic Action ${String(index).padStart(2, "0")}`,
    status: index % 2 ? "active" : "draft",
    status_rank: index % 2 ? 0 : 1,
    name_sort: `synthetic action ${String(index).padStart(2, "0")}`,
    contract_cycle_name: "2026 Synthetic Cycle",
    task_count: "4",
    open_task_count: "2",
    completed_task_count: "2",
    overdue_task_count: index === 1 ? "1" : "0",
    assigned_user_count: "2",
    next_due_at: "2026-08-20T18:00:00.000Z",
    total_count: "26",
    active_action_count: "13",
    total_open_tasks: "52",
    total_completed_tasks: "52",
    total_overdue_tasks: "3",
    ...overrides,
  };
}

function taskRow(index, overrides = {}) {
  return {
    task_handle: handle(index),
    title: `Synthetic Task ${String(index).padStart(2, "0")}`,
    status: index === 1 ? "open" : "complete",
    assignee_name: index === 2 ? null : "Synthetic CAT Lead",
    assignee_deactivated_at: index === 3 ? "2026-08-01T00:00:00.000Z" : null,
    due_at: index === 1 ? "2020-01-01T00:00:00.000Z" : "2026-08-30T00:00:00.000Z",
    created_at: `2026-08-${String(Math.min(index, 28)).padStart(2, "0")}T12:00:00.000Z`,
    total_count: "26",
    open_count: "8",
    complete_count: "18",
    overdue_count: "2",
    unassigned_count: "1",
    ...overrides,
  };
}

test("CAT action filters are bounded and malformed cursors are ignored", () => {
  assert.deepEqual(normalizeCatActionPortfolioInput({
    term: "  Contract   Action  ",
    status: "active",
    pageSize: "999",
    cursor: "invalid",
  }), {
    term: "Contract Action",
    status: "active",
    pageSize: 25,
    cursor: null,
  });
  assert.deepEqual(normalizeCatActionTaskInput({
    term: "  Lead  ",
    status: "complete",
    pageSize: "50",
    cursor: "invalid",
  }), {
    term: "Lead",
    status: "complete",
    pageSize: 50,
    cursor: null,
  });
});

test("CAT action portfolio is organization scoped, excludes archived records, omits strategy, and keyset paginates", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => portfolioRow(index + 1));
  let sqlText = "";
  let parameters = [];
  const result = await getCatActionsPage(context(), {
    term: "Action%_",
    status: "active",
    pageSize: "25",
  }, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return rows;
  });

  assert.equal(result.actions.length, 25);
  assert.equal(result.total, 26);
  assert.deepEqual(result.summary, { activeActions: 13, openTasks: 52, completedTasks: 52, overdueTasks: 3 });
  assert.equal(result.actions[0].handle, handle(1));
  assert.equal("id" in result.actions[0], false);
  assert.equal("strategy_hash" in result.actions[0], false);
  assert.equal(typeof result.nextCursor, "string");
  assert.deepEqual(__testing.decodeActionCursor(result.nextCursor), {
    rank: Number(rows[24].status_rank),
    name: rows[24].name_sort,
    handle: rows[24].action_handle,
  });
  assert.equal(parameters[0], organizationId);
  assert.equal(parameters[1], "active");
  assert.equal(parameters[2], "%Action\\%\\_%");
  assert.equal(parameters[6], 26);
  assert.match(sqlText, /action\.organization_id = \$1::uuid/);
  assert.match(sqlText, /action\.archived_at IS NULL/);
  assert.match(sqlText, /action\.status <> 'archived'/);
  assert.match(sqlText, /public\.digest\('cat-action:'/);
  assert.match(sqlText, /LIMIT \$7::integer/);
  assert.doesNotMatch(sqlText, /OFFSET/i);
  assert.doesNotMatch(sqlText, /cat_action_strategy|strategy_hash/i);
  assert.doesNotMatch(sqlText, /INSERT INTO|UPDATE local801|DELETE FROM/i);
});

test("CAT action detail resolves only an opaque organization-scoped handle and never loads strategy", async () => {
  let sqlText = "";
  let parameters = [];
  const result = await getCatActionDetail(context(), actionHandle, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return [{
      action_handle: actionHandle,
      name: "Synthetic Contract Action",
      status: "active",
      created_at: "2026-08-01T12:00:00.000Z",
      cycle_name: "2026 Synthetic Cycle",
      cycle_status: "planning",
      cycle_starts_on: "2026-07-01",
      cycle_ends_on: "2027-06-30",
      task_count: "4",
      open_task_count: "2",
      completed_task_count: "2",
      overdue_task_count: "1",
      assigned_user_count: "2",
      next_due_at: "2026-08-20T18:00:00.000Z",
    }];
  });

  assert.equal(result.name, "Synthetic Contract Action");
  assert.equal(result.completionRate, 50);
  assert.deepEqual(result.contractCycle, {
    name: "2026 Synthetic Cycle",
    status: "planning",
    startsOn: "2026-07-01",
    endsOn: "2027-06-30",
  });
  assert.deepEqual(parameters, [organizationId, actionHandle]);
  assert.match(sqlText, /action\.organization_id = \$1::uuid/);
  assert.match(sqlText, /public\.digest\('cat-action:'/);
  assert.doesNotMatch(sqlText, /cat_action_strategy|strategy_hash/i);

  let calls = 0;
  await assert.rejects(
    getCatActionDetail(context(), "raw-uuid-or-bad-handle", async () => { calls += 1; return []; }),
    (error) => error instanceof CatActionInputError,
  );
  assert.equal(calls, 0);
});

test("CAT action task detail exposes only opaque task handles and display labels with bounded keyset pagination", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => taskRow(index + 1));
  let sqlText = "";
  let parameters = [];
  const result = await getCatActionTasksPage(context(), actionHandle, {
    term: "Task%_",
    status: "open",
    pageSize: "25",
  }, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return rows;
  });

  assert.equal(result.tasks.length, 25);
  assert.deepEqual(result.summary, { open: 8, complete: 18, overdue: 2, unassigned: 1 });
  assert.equal(result.tasks[0].handle, handle(1));
  assert.equal(result.tasks[0].overdue, true);
  assert.equal(result.tasks[1].assigneeName, null);
  assert.equal(result.tasks[2].assigneeActive, false);
  assert.equal("task_handle" in result.tasks[0], false);
  assert.equal("assigned_to" in result.tasks[0], false);
  assert.equal(parameters[0], organizationId);
  assert.equal(parameters[1], actionHandle);
  assert.equal(parameters[2], "open");
  assert.equal(parameters[3], "%Task\\%\\_%");
  assert.equal(parameters[6], 26);
  assert.match(sqlText, /task\.organization_id = \$1::uuid/);
  assert.match(sqlText, /public\.digest\('cat-action-task:'/);
  assert.match(sqlText, /created_at < \$5::timestamptz/);
  assert.match(sqlText, /LIMIT \$7::integer/);
  assert.doesNotMatch(sqlText, /OFFSET/i);
  assert.doesNotMatch(sqlText, /cat_action_strategy|strategy_hash/i);
  assert.equal(typeof result.nextCursor, "string");
  assert.deepEqual(__testing.decodeTaskCursor(result.nextCursor), {
    createdAt: rows[24].created_at,
    handle: rows[24].task_handle,
  });
});

test("CAT action services deny roles without manageCatActions before querying SQL", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(getCatActionsPage(context(role), {}, async () => { calls += 1; return []; }), /forbidden/i);
    await assert.rejects(getCatActionDetail(context(role), actionHandle, async () => { calls += 1; return []; }), /forbidden/i);
    await assert.rejects(getCatActionTasksPage(context(role), actionHandle, {}, async () => { calls += 1; return []; }), /forbidden/i);
    assert.equal(calls, 0);
  }
});

test("CAT Actions pages use database-backed portfolio, opaque task detail, and audited management controls", async () => {
  const portfolio = await readFile(new URL("../src/app/cat-actions/page.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/app/cat-actions/[actionHandle]/page.tsx", import.meta.url), "utf8");
  assert.match(portfolio, /getCatActionsPage\(context/);
  assert.match(portfolio, /CatActionCreateForm/);
  assert.match(portfolio, /permission="manageCatActions"/);
  assert.match(portfolio, /\/cat-actions\/\$\{action\.handle\}/);
  assert.doesNotMatch(portfolio, /Backend wiring pending/);
  assert.doesNotMatch(portfolio, /strategy_hash|cat_action_strategy/i);
  assert.match(detail, /getCatActionDetail\(context, actionHandle\)/);
  assert.match(detail, /getCatActionTasksPage\(context, actionHandle/);
  assert.match(detail, /CatActionEditForm/);
  assert.match(detail, /CatActionTaskCreateForm/);
  assert.match(detail, /CatActionTaskEditForm/);
  assert.match(detail, /CatActionArchiveButton/);
  assert.doesNotMatch(detail, /strategy_hash|cat_action_strategy/i);
  assert.doesNotMatch(`${portfolio}\n${detail}`, /INSERT INTO|UPDATE local801|DELETE FROM/i);
});
