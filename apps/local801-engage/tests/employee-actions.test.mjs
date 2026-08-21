import assert from "node:assert/strict";
import test from "node:test";
import {
  __testing,
  createEmployeeActionDefinition,
  getEmployeeActionProfile,
  listEmployeeActionDefinitions,
  recordEmployeeActionPosture,
  recordEmployeeActionResponse,
} from "../src/lib/employee-actions.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const actionId = "44444444-4444-4444-8444-444444444444";
const secondActionId = "66666666-6666-4666-8666-666666666666";
const engagementEventId = "55555555-5555-4555-8555-555555555555";
const actionHandle = __testing.actionHandle(organizationId, actionId);
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});

function profileQuery({ allowed = true, declinesAll = false } = {}) {
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("employee-actions:person-scope")) return [{ allowed, declines_all_actions: declinesAll }];
    if (sql.includes("employee-actions:current-posture")) return [{
      declines_all_actions: declinesAll,
      decline_all_seq: declinesAll ? 9 : null,
      reopen_seq: declinesAll ? null : 10,
      updated_at: "2026-08-14T12:00:00Z",
    }];
    if (sql.includes("employee-actions:current-profile")) return [
      {
        id: actionId,
        label: "Attend a meeting",
        engagement_level: 1,
        scope: "organization",
        response_status: "willing",
        first_recorded_at: "2026-08-01T12:00:00Z",
        last_updated_at: "2026-08-14T12:00:00Z",
        response_history_count: 2,
      },
      {
        id: secondActionId,
        label: "Talk with a coworker",
        engagement_level: 2,
        scope: "campaign",
        response_status: "considering",
        first_recorded_at: "2026-08-10T12:00:00Z",
        last_updated_at: "2026-08-10T12:00:00Z",
        response_history_count: 1,
      },
    ];
    throw new Error("Unexpected employee-actions query");
  };
  return { calls, query };
}

test("action definitions are dynamic, bounded, and expose non-capability handles instead of internal IDs", async () => {
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    return [
      { id: actionId, label: "Attend a meeting", engagement_level: 1, scope: "organization" },
      { id: secondActionId, label: "Sign the petition", engagement_level: 2, scope: "campaign" },
    ];
  };
  const rows = await listEmployeeActionDefinitions(context("cat_member"), query);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].handle, __testing.actionHandle(organizationId, actionId));
  assert.equal(rows[1].handle, __testing.actionHandle(organizationId, secondActionId));
  assert.notEqual(rows[0].handle, actionId);
  assert.equal(rows[0].label, "Attend a meeting");
  assert.equal(rows[1].scope, "campaign");
  assert.deepEqual(calls[0].parameters, [organizationId]);
  assert.match(calls[0].sql, /FROM local801\.employee_actions/);
  assert.match(calls[0].sql, /organization_id = \$1::uuid/);
  assert.match(calls[0].sql, /LIMIT 100/);
});

test("employee action profile is a persistent running list without person contact details or internal action IDs", async () => {
  const { calls, query } = profileQuery();
  const profile = await getEmployeeActionProfile(context("cat_member"), personId, query);
  assert.equal(calls.length, 3);
  assert.equal(profile.posture, "open_to_actions");
  assert.equal(profile.actions.length, 2);
  assert.equal(profile.actions[0].response, "willing");
  assert.equal(profile.actions[0].responseHistoryCount, 2);
  assert.equal(profile.actions[1].response, "considering");
  assert.equal(profile.actions[0].handle, actionHandle);
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(serialized, new RegExp(personId, "i"));
  assert.doesNotMatch(serialized, new RegExp(actionId, "i"));
  assert.doesNotMatch(serialized, /personId|email|phone|address|note|contactValue/i);
  assert.match(calls[0].sql, /assignment\.primary_user_id = \$4::uuid OR assignment\.backup_user_id = \$4::uuid/);
  assert.match(calls[2].sql, /local801\.employee_action_responses history/);
});

test("roles without recordEngagement cannot read person-level action willingness", async () => {
  let calls = 0;
  await assert.rejects(
    getEmployeeActionProfile(context("membership_data_manager"), personId, async () => { calls += 1; return []; }),
    /not authorized/i,
  );
  assert.equal(calls, 0);
});

test("recording willingness after decline-all automatically reopens by append-only response sequence", async () => {
  const calls = [];
  const statements = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("employee-actions:person-scope")) return [{ allowed: true, declines_all_actions: true }];
    if (sql.includes("employee-actions:resolve-handle")) return [{ id: actionId }];
    if (sql.includes("employee-actions:validate-engagement-event")) return [{ valid: true }];
    throw new Error("Unexpected write query");
  };
  const result = await recordEmployeeActionResponse(context("cat_member"), {
    personId,
    actionHandle,
    response: "willing",
    engagementEventId,
  }, {
    query,
    runTransaction: async (items) => statements.push(...items),
    prepareAudit: async (event) => ({ sql: "/* audit */ SELECT 1", parameters: [event.payload.response, event.payload.autoReopened] }),
  });

  assert.deepEqual(result, { recorded: true, response: "willing", autoReopened: true });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO local801\.employee_action_responses/);
  assert.match(statements[0].sql, /response_status/);
  assert.equal(statements[0].parameters[3], "willing");
  assert.match(statements[0].sql, /COALESCE\(event\.occurred_at, now\(\)\)/);
  assert.match(statements[1].sql, /audit/);
  assert.doesNotMatch(statements[0].sql, /DELETE FROM|UPDATE local801\.employee_action_all_declines/i);
});

test("completed is a supported current action state", async () => {
  const statements = [];
  const query = async (sql) => {
    if (sql.includes("employee-actions:person-scope")) return [{ allowed: true, declines_all_actions: false }];
    if (sql.includes("employee-actions:resolve-handle")) return [{ id: actionId }];
    throw new Error("Unexpected query");
  };
  const result = await recordEmployeeActionResponse(context("cat_lead"), {
    personId,
    actionHandle,
    response: "completed",
  }, {
    query,
    runTransaction: async (items) => statements.push(...items),
    prepareAudit: async () => ({ sql: "SELECT 1" }),
  });
  assert.equal(result.response, "completed");
  assert.equal(statements[0].parameters[3], "completed");
});

test("specific decline is unnecessary while employee currently declines all actions", async () => {
  let transactions = 0;
  const query = async (sql) => {
    if (sql.includes("employee-actions:person-scope")) return [{ allowed: true, declines_all_actions: true }];
    if (sql.includes("employee-actions:resolve-handle")) return [{ id: actionId }];
    throw new Error("Unexpected query");
  };
  await assert.rejects(recordEmployeeActionResponse(context("cat_member"), {
    personId,
    actionHandle,
    response: "declined",
  }, {
    query,
    runTransaction: async () => { transactions += 1; },
    prepareAudit: async () => ({ sql: "SELECT 1" }),
  }), /declines all actions/i);
  assert.equal(transactions, 0);
});

test("decline-all is an explicit append-only event and does not delete prior willingness", async () => {
  const statements = [];
  const query = async (sql) => {
    if (sql.includes("employee-actions:person-scope")) return [{ allowed: true, declines_all_actions: false }];
    throw new Error("Unexpected query");
  };
  const result = await recordEmployeeActionPosture(context("cat_member"), {
    personId,
    posture: "declines_all",
  }, {
    query,
    runTransaction: async (items) => statements.push(...items),
    prepareAudit: async (event) => ({ sql: "/* audit */ SELECT 1", parameters: [event.payload.posture] }),
  });
  assert.deepEqual(result, { recorded: true, posture: "declines_all" });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO local801\.employee_action_all_declines/);
  assert.doesNotMatch(statements[0].sql, /DELETE FROM|UPDATE local801\.employee_action_responses/i);
  await assert.rejects(recordEmployeeActionPosture(context("cat_member"), {
    personId,
    posture: "open_to_actions",
  }, { query }), /established by recording/i);
});

test("action definitions can be created only by CAT administration roles and are audited atomically", async () => {
  const statements = [];
  const query = async (sql, parameters) => {
    assert.match(sql, /validate-definition-scope/);
    assert.deepEqual(parameters, [organizationId, null, null]);
    return [{ campaign_valid: true, cat_action_valid: true }];
  };
  const result = await createEmployeeActionDefinition(context("cat_admin"), {
    label: "Attend a meeting",
    engagementLevel: 1,
  }, {
    query,
    runTransaction: async (items) => statements.push(...items),
    prepareAudit: async (event) => ({ sql: "/* audit */ SELECT 1", parameters: [event.eventType, event.payload.scopeType] }),
  });
  assert.match(result.handle, /^[0-9a-f]{64}$/);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO local801\.employee_actions/);
  assert.match(statements[0].sql, /scope_type/);
  assert.equal(statements[1].parameters[0], "config.change");

  await assert.rejects(createEmployeeActionDefinition(context("cat_member"), {
    label: "Action",
    engagementLevel: 1,
  }, { query }), /not authorized/i);
});

test("runtime contract matches the applied 0008 schema and does not use the superseded draft tables", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/lib/employee-actions.ts", import.meta.url), "utf8"));
  assert.match(source, /local801\.employee_actions/);
  assert.match(source, /local801\.employee_action_responses/);
  assert.match(source, /local801\.employee_action_all_declines/);
  assert.match(source, /reporting\.employee_action_current_posture/);
  assert.match(source, /reporting\.employee_action_current_responses/);
  assert.match(source, /response_status/);
  assert.match(source, /completed/);
  assert.doesNotMatch(source, /local801\.employee_action_definitions/);
  assert.doesNotMatch(source, /local801\.employee_action_posture_events/);
  assert.doesNotMatch(source, /local801\.employee_action_response_events/);
});
