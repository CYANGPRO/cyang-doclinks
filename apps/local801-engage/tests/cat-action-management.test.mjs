import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CatActionMutationError,
  __testing,
  archiveCatAction,
  createCatAction,
  createCatActionTask,
  getCatActionManagementOptions,
  updateCatAction,
  updateCatActionTask,
} from "../src/lib/cat-action-management.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const actionId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const actionHandle = __testing.opaqueHandle("cat-action", organizationId, actionId);
const taskHandle = __testing.opaqueHandle("cat-action-task", organizationId, taskId);
const context = (role = "cat_admin") => ({ organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role });

function deps(overrides = {}) {
  const transactions = [];
  const audits = [];
  return {
    transactions,
    audits,
    values: {
      runTransaction: async (statements) => { transactions.push(statements); },
      prepareAudit: async (event) => {
        audits.push(event);
        return { sql: "/* audit */ SELECT 1", parameters: [] };
      },
      uuid: () => actionId,
      now: () => new Date("2026-08-15T01:00:00.000Z"),
      ...overrides,
    },
  };
}

test("CAT action management normalizes bounded text, statuses, due dates, and opaque handles", () => {
  assert.equal(__testing.normalizeText("  Synthetic   Action  ", "Action", 50), "Synthetic Action");
  assert.equal(__testing.normalizeActionStatus("active"), "active");
  assert.equal(__testing.normalizeTaskStatus("complete"), "complete");
  assert.equal(__testing.requireHandle(actionHandle, "Action"), actionHandle);
  assert.equal(__testing.normalizeDueAt("2026-08-16T01:00:00.000Z", new Date("2026-08-15T01:00:00.000Z"), true), "2026-08-16T01:00:00.000Z");
  assert.throws(() => __testing.normalizeDueAt("2026-08-14T01:00:00.000Z", new Date("2026-08-15T01:00:00.000Z"), true), /future/i);
  assert.throws(() => __testing.requireHandle("raw-uuid", "Action"), /not available/i);
});

test("management options expose opaque cycle/user handles and never raw ids", async () => {
  const calls = [];
  const result = await getCatActionManagementOptions(context(), async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("cycle-options")) return [{
      handle: "a".repeat(64), name: "Synthetic Cycle", status: "planning", starts_on: "2026-07-01", ends_on: "2027-06-30",
    }];
    if (sql.includes("assignee-options")) return [{
      handle: "b".repeat(64), display_name: "Synthetic CAT Lead", role_codes: "cat_lead",
    }];
    throw new Error("unexpected query");
  });
  assert.deepEqual(result, {
    contractCycles: [{ handle: "a".repeat(64), label: "Synthetic Cycle", detail: "planning" }],
    assignees: [{ handle: "b".repeat(64), label: "Synthetic CAT Lead", detail: "cat_lead" }],
  });
  assert.equal(calls.every((call) => call.parameters[0] === organizationId), true);
  assert.equal(JSON.stringify(result).includes(userId), false);
});

test("create CAT action is organization scoped, role rechecked in SQL, and atomic with audit", async () => {
  const state = deps();
  const result = await createCatAction(context(), { name: " Synthetic Action ", status: "active" }, state.values);
  assert.equal(result.created, true);
  assert.equal(result.handle, actionHandle);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 2);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /INSERT INTO local801\.cat_actions/);
  assert.match(statement.sql, /app_user\.organization_id = \$1::uuid/);
  assert.match(statement.sql, /role\.code = \$4::text/);
  assert.match(statement.sql, /role\.code IN \('system_owner','local_admin','cat_admin'\)/);
  assert.deepEqual(statement.parameters.slice(0, 4), [organizationId, actionId, userId, "cat_admin"]);
  assert.equal(statement.parameters[5], "Synthetic Action");
  assert.equal(statement.parameters[6], "active");
  assert.equal(state.audits[0].eventType, "record.create");
  assert.equal(state.audits[0].subjectType, "cat_action");
  assert.equal("name" in state.audits[0].payload, false);
});

test("update CAT action resolves opaque scope and writes only allowed operational fields plus audit", async () => {
  const state = deps({
    query: async (sql, parameters) => {
      assert.equal(parameters[0], organizationId);
      if (sql.includes("resolve-action")) return [{ id: actionId, name: "Old Action", status: "draft", contract_cycle_id: null }];
      throw new Error(`unexpected: ${sql}`);
    },
  });
  await updateCatAction(context(), { actionHandle, name: "New Action", status: "active" }, state.values);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /UPDATE local801\.cat_actions action/);
  assert.match(statement.sql, /action\.organization_id = \$1::uuid/);
  assert.match(statement.sql, /action\.archived_at IS NULL/);
  assert.doesNotMatch(statement.sql, /cat_action_strategy|strategy_hash/i);
  assert.equal(state.audits[0].eventType, "record.update");
  assert.deepEqual(state.audits[0].payload, {
    nameChanged: true,
    statusChanged: true,
    contractCycleChanged: false,
    status: "active",
  });
});

test("CAT action archive requires closed status and is atomic with record.archive audit", async () => {
  const openState = deps({ query: async () => [{ id: actionId, name: "Open", status: "active", contract_cycle_id: null }] });
  await assert.rejects(
    archiveCatAction(context(), actionHandle, openState.values),
    (error) => error instanceof CatActionMutationError && error.code === "ACTION_NOT_CLOSED",
  );
  assert.equal(openState.transactions.length, 0);

  const closedState = deps({ query: async () => [{ id: actionId, name: "Closed", status: "closed", contract_cycle_id: null }] });
  await archiveCatAction(context(), actionHandle, closedState.values);
  assert.match(closedState.transactions[0][0].sql, /SET status = 'archived', archived_at = now\(\)/);
  assert.match(closedState.transactions[0][0].sql, /action\.status = 'closed'/);
  assert.equal(closedState.audits[0].eventType, "record.archive");
});

test("create CAT task rejects closed actions and otherwise inserts an open task atomically", async () => {
  const closedState = deps({ query: async () => [{ id: actionId, name: "Closed", status: "closed", contract_cycle_id: null }] });
  await assert.rejects(
    createCatActionTask(context(), { actionHandle, title: "Do work" }, closedState.values),
    (error) => error instanceof CatActionMutationError && error.code === "ACTION_CLOSED",
  );

  const state = deps({
    uuid: () => taskId,
    query: async (sql) => {
      if (sql.includes("resolve-action")) return [{ id: actionId, name: "Active", status: "active", contract_cycle_id: null }];
      throw new Error(`unexpected: ${sql}`);
    },
  });
  const result = await createCatActionTask(context(), {
    actionHandle,
    title: " Synthetic Task ",
    dueAt: "2026-08-16T01:00:00.000Z",
  }, state.values);
  assert.equal(result.handle, taskHandle);
  assert.match(state.transactions[0][0].sql, /INSERT INTO local801\.cat_action_tasks/);
  assert.match(state.transactions[0][0].sql, /action\.status IN \('draft','active'\)/);
  assert.equal(state.transactions[0][0].parameters[6], "Synthetic Task");
  assert.equal(state.audits[0].subjectType, "cat_action_task");
});

test("update CAT task can complete operational work but cannot mutate tasks under a closed action", async () => {
  const task = {
    id: taskId,
    action_id: actionId,
    action_status: "active",
    title: "Synthetic Task",
    status: "open",
    assigned_to: null,
    due_at: "2026-08-20T01:00:00.000Z",
  };
  const state = deps({ query: async () => [task] });
  await updateCatActionTask(context(), { actionHandle, taskHandle, status: "complete" }, state.values);
  assert.match(state.transactions[0][0].sql, /UPDATE local801\.cat_action_tasks task/);
  assert.match(state.transactions[0][0].sql, /action\.status IN \('draft','active'\)/);
  assert.equal(state.transactions[0][0].parameters[5], "complete");
  assert.equal(state.audits[0].payload.statusChanged, true);
  assert.equal(state.audits[0].payload.status, "complete");

  const closedState = deps({ query: async () => [{ ...task, action_status: "closed" }] });
  await assert.rejects(
    updateCatActionTask(context(), { actionHandle, taskHandle, status: "complete" }, closedState.values),
    (error) => error instanceof CatActionMutationError && error.code === "ACTION_CLOSED",
  );
  assert.equal(closedState.transactions.length, 0);
});

test("all CAT action mutations deny non-management roles before SQL", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    const denied = { query: async () => { calls += 1; return []; } };
    await assert.rejects(createCatAction(context(role), { name: "No" }, denied), /not authorized/i);
    await assert.rejects(updateCatAction(context(role), { actionHandle, name: "No" }, denied), /not authorized/i);
    await assert.rejects(archiveCatAction(context(role), actionHandle, denied), /not authorized/i);
    await assert.rejects(createCatActionTask(context(role), { actionHandle, title: "No" }, denied), /not authorized/i);
    await assert.rejects(updateCatActionTask(context(role), { actionHandle, taskHandle, status: "complete" }, denied), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("CAT action mutation HTTP routes are Preview-only, same-origin, permission checked, bounded, and strategy-free", async () => {
  const helper = await readFile(new URL("../src/lib/cat-action-mutation-http.ts", import.meta.url), "utf8");
  const createRoute = await readFile(new URL("../src/app/api/cat-actions/route.ts", import.meta.url), "utf8");
  const actionRoute = await readFile(new URL("../src/app/api/cat-actions/[actionHandle]/route.ts", import.meta.url), "utf8");
  const taskCreateRoute = await readFile(new URL("../src/app/api/cat-actions/[actionHandle]/tasks/route.ts", import.meta.url), "utf8");
  const taskRoute = await readFile(new URL("../src/app/api/cat-actions/[actionHandle]/tasks/[taskHandle]/route.ts", import.meta.url), "utf8");
  assert.match(helper, /VERCEL_ENV === "production"/);
  assert.match(helper, /LOCAL801_PREVIEW_AUTH_ENABLED === "1"/);
  assert.match(helper, /hasExactSameOrigin\(request\)/);
  assert.match(helper, /requirePreviewUser\("manageCatActions"\)/);
  assert.match(helper, /MAX_JSON_BYTES = 8_192/);
  assert.match(createRoute, /createCatAction/);
  assert.match(actionRoute, /updateCatAction/);
  assert.match(actionRoute, /archiveCatAction/);
  assert.match(taskCreateRoute, /createCatActionTask/);
  assert.match(taskRoute, /updateCatActionTask/);
  assert.doesNotMatch(`${helper}\n${createRoute}\n${actionRoute}\n${taskCreateRoute}\n${taskRoute}`, /cat_action_strategy|strategy_hash/i);
});
