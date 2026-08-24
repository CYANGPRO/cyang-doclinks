import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CampaignMutationError,
  __testing,
  archiveCampaign,
  createCampaign,
  getCampaignManagementOptions,
  updateCampaign,
  updateCampaignAssignment,
} from "../src/lib/campaign-management.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const personId = "44444444-4444-4444-8444-444444444444";
const assignmentId = "55555555-5555-4555-8555-555555555555";
const assigneeId = "66666666-6666-4666-8666-666666666666";
const campaignHandle = __testing.opaqueHandle("campaign", organizationId, campaignId);
const personHandle = "a".repeat(64);
const assigneeHandle = "b".repeat(64);
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
      uuid: () => campaignId,
      now: () => new Date("2026-08-15T01:00:00.000Z"),
      ...overrides,
    },
  };
}

function campaignResolution(overrides = {}) {
  return {
    id: campaignId,
    name: "Synthetic Campaign",
    status: "draft",
    starts_on: "2026-08-20",
    ends_on: "2026-09-20",
    launched_at: null,
    ...overrides,
  };
}

function participantResolution(overrides = {}) {
  return {
    person_id: personId,
    campaign_id: campaignId,
    campaign_status: "active",
    assignment_id: assignmentId,
    assignment_status: "open",
    primary_user_id: assigneeId,
    due_at: "2026-08-20T12:00:00.000Z",
    ...overrides,
  };
}

test("campaign management normalizes names, dates, due dates, transitions, and opaque handles", () => {
  assert.equal(__testing.normalizeText("  Synthetic   Campaign  ", "Campaign", 160), "Synthetic Campaign");
  assert.equal(__testing.normalizeStatus("active"), "active");
  assert.equal(__testing.normalizeDate("2026-08-20", "Start"), "2026-08-20");
  assert.equal(__testing.normalizeDueAt("2026-08-16T01:00:00.000Z", new Date("2026-08-15T01:00:00.000Z")), "2026-08-16T01:00:00.000Z");
  assert.equal(__testing.requireHandle(campaignHandle, "Campaign"), campaignHandle);
  assert.match(campaignHandle, /^[0-9a-f]{64}$/);
  assert.throws(() => __testing.validateDateRange("2026-09-01", "2026-08-01"), /before the start/i);
  assert.throws(() => __testing.validateTransition("active", "draft"), /cannot return to draft/i);
  assert.throws(() => __testing.normalizeDueAt("2026-08-14T01:00:00.000Z", new Date("2026-08-15T01:00:00.000Z")), /future/i);
  assert.throws(() => __testing.requireHandle("raw-uuid", "Campaign"), /not available/i);
});

test("campaign management options expose organizer handles without raw user ids", async () => {
  let sqlText = "";
  const result = await getCampaignManagementOptions(context(), async (sql, parameters) => {
    sqlText = sql;
    assert.deepEqual(parameters, [organizationId]);
    return [{ handle: assigneeHandle, display_name: "Synthetic CAT Lead", role_codes: "cat_lead" }];
  });
  assert.deepEqual(result, { assignees: [{ handle: assigneeHandle, label: "Synthetic CAT Lead", detail: "cat_lead" }] });
  assert.match(sqlText, /app_user\.organization_id = \$1::uuid/);
  assert.match(sqlText, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.equal(JSON.stringify(result).includes(assigneeId), false);
});

test("create campaign is organization scoped, role rechecked in SQL, and atomic with audit", async () => {
  const state = deps();
  const result = await createCampaign(context(), {
    name: " Synthetic Campaign ",
    status: "active",
    startsOn: "2026-08-20",
    endsOn: "2026-09-20",
  }, state.values);
  assert.equal(result.created, true);
  assert.equal(result.handle, campaignHandle);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 2);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /INSERT INTO local801\.outreach_campaigns/);
  assert.match(statement.sql, /app_user\.organization_id = \$1::uuid/);
  assert.match(statement.sql, /role\.code = \$4::text/);
  assert.match(statement.sql, /role\.code IN \('system_owner','local_admin','cat_admin'\)/);
  assert.match(statement.sql, /CASE WHEN \$6::text = 'active' THEN now\(\)/);
  assert.deepEqual(statement.parameters.slice(0, 4), [organizationId, campaignId, userId, "cat_admin"]);
  assert.deepEqual(statement.parameters.slice(4), ["Synthetic Campaign", "active", "2026-08-20", "2026-09-20"]);
  assert.equal(state.audits[0].eventType, "record.create");
  assert.equal(state.audits[0].subjectType, "outreach_campaign");
  assert.equal("name" in state.audits[0].payload, false);
});

test("update campaign enforces lifecycle transitions and audits operational changes", async () => {
  const state = deps({
    query: async (sql, parameters) => {
      assert.equal(parameters[0], organizationId);
      assert.equal(parameters[1], campaignHandle);
      if (sql.includes("resolve-campaign")) return [campaignResolution()];
      throw new Error(`unexpected: ${sql}`);
    },
  });
  await updateCampaign(context(), {
    campaignHandle,
    name: "Updated Campaign",
    status: "active",
    startsOn: "2026-08-21",
  }, state.values);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /UPDATE local801\.outreach_campaigns campaign/);
  assert.match(statement.sql, /campaign\.organization_id = \$1::uuid/);
  assert.match(statement.sql, /campaign\.status = \$13::text/);
  assert.match(statement.sql, /launched_at = CASE/);
  assert.doesNotMatch(statement.sql, /campaign_instructions/);
  assert.equal(state.audits[0].eventType, "record.update");
  assert.deepEqual(state.audits[0].payload, {
    nameChanged: true,
    statusChanged: true,
    status: "active",
    startDateChanged: true,
    endDateChanged: false,
  });

  const activeState = deps({ query: async () => [campaignResolution({ status: "active" })] });
  await assert.rejects(
    updateCampaign(context(), { campaignHandle, status: "draft" }, activeState.values),
    (error) => error instanceof CampaignMutationError && error.code === "INVALID_STATUS_TRANSITION",
  );
  assert.equal(activeState.transactions.length, 0);

  const closedState = deps({ query: async () => [campaignResolution({ status: "closed" })] });
  await assert.rejects(
    updateCampaign(context(), { campaignHandle, name: "No" }, closedState.values),
    (error) => error instanceof CampaignMutationError && error.code === "CAMPAIGN_CLOSED",
  );
});

test("campaign archive requires closed status and atomically removes open assignments from active queues", async () => {
  const openState = deps({ query: async () => [campaignResolution({ status: "active" })] });
  await assert.rejects(
    archiveCampaign(context(), campaignHandle, openState.values),
    (error) => error instanceof CampaignMutationError && error.code === "CAMPAIGN_NOT_CLOSED",
  );
  assert.equal(openState.transactions.length, 0);

  const state = deps({ query: async () => [campaignResolution({ status: "closed" })] });
  await archiveCampaign(context(), campaignHandle, state.values);
  assert.equal(state.transactions[0].length, 3);
  assert.match(state.transactions[0][0].sql, /SET status = 'archived', archived_at = now\(\)/);
  assert.match(state.transactions[0][1].sql, /UPDATE local801\.engagement_assignments assignment/);
  assert.match(state.transactions[0][1].sql, /assignment\.status <> 'completed'/);
  assert.equal(state.audits[0].eventType, "record.archive");
  assert.equal(state.audits[0].payload.openAssignmentsArchived, true);
});

test("campaign assignment creates organizer ownership only for an existing campaign population member", async () => {
  const newAssignmentId = "77777777-7777-4777-8777-777777777777";
  const state = deps({
    uuid: () => newAssignmentId,
    query: async (sql, parameters) => {
      assert.equal(parameters[0], organizationId);
      if (sql.includes("resolve-participant")) return [participantResolution({ assignment_id: null, assignment_status: null, primary_user_id: null, due_at: null })];
      if (sql.includes("resolve-assignee")) return [{ id: assigneeId }];
      throw new Error(`unexpected: ${sql}`);
    },
  });
  const result = await updateCampaignAssignment(context(), {
    campaignHandle,
    personHandle,
    assigneeHandle,
    dueAt: "2026-08-18T12:00:00.000Z",
  }, state.values);
  assert.equal(result.created, true);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /INSERT INTO local801\.engagement_assignments/);
  assert.match(statement.sql, /JOIN local801\.outreach_campaign_population population/);
  assert.match(statement.sql, /population\.person_id = \$8::uuid/);
  assert.match(statement.sql, /campaign\.status IN \('draft','active'\)/);
  assert.deepEqual(statement.parameters.slice(0, 4), [organizationId, campaignId, userId, "cat_admin"]);
  assert.equal(statement.parameters[4], newAssignmentId);
  assert.equal(statement.parameters[5], assigneeId);
  assert.equal(statement.parameters[7], personId);
  assert.equal(state.audits[0].subjectType, "engagement_assignment");
  assert.equal(state.audits[0].payload.campaignAssignment, true);
});

test("campaign assignment can reassign/reschedule or explicitly unassign an open assignment", async () => {
  const state = deps({
    query: async (sql) => {
      if (sql.includes("resolve-participant")) return [participantResolution()];
      if (sql.includes("resolve-assignee")) return [{ id: "88888888-8888-4888-8888-888888888888" }];
      throw new Error(`unexpected: ${sql}`);
    },
  });
  await updateCampaignAssignment(context(), {
    campaignHandle,
    personHandle,
    assigneeHandle,
    dueAt: "2026-08-22T12:00:00.000Z",
  }, state.values);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /UPDATE local801\.engagement_assignments assignment/);
  assert.match(statement.sql, /assignment\.campaign_id = \$7::uuid/);
  assert.match(statement.sql, /assignment\.person_id = \$10::uuid/);
  assert.equal(state.audits[0].payload.reassigned, true);
  assert.equal(state.audits[0].payload.dueAtChanged, true);

  const unassignState = deps({ query: async (sql) => sql.includes("resolve-participant") ? [participantResolution()] : [] });
  const result = await updateCampaignAssignment(context(), { campaignHandle, personHandle, assigneeHandle: null }, unassignState.values);
  assert.equal(result.unassigned, true);
  assert.match(unassignState.transactions[0][0].sql, /SET archived_at = now\(\)/);
  assert.match(unassignState.transactions[0][0].sql, /assignment\.status = 'open'/);
  assert.equal(unassignState.audits[0].eventType, "record.archive");
});

test("completed assignments and closed campaigns are immutable through campaign assignment management", async () => {
  const completed = deps({ query: async () => [participantResolution({ assignment_status: "completed" })] });
  await assert.rejects(
    updateCampaignAssignment(context(), { campaignHandle, personHandle, dueAt: "2026-08-22T12:00:00.000Z" }, completed.values),
    (error) => error instanceof CampaignMutationError && error.code === "ASSIGNMENT_COMPLETE",
  );
  assert.equal(completed.transactions.length, 0);

  const closed = deps({ query: async () => [participantResolution({ campaign_status: "closed" })] });
  await assert.rejects(
    updateCampaignAssignment(context(), { campaignHandle, personHandle, dueAt: "2026-08-22T12:00:00.000Z" }, closed.values),
    (error) => error instanceof CampaignMutationError && error.code === "CAMPAIGN_CLOSED",
  );
  assert.equal(closed.transactions.length, 0);
});

test("all campaign mutations deny non-management roles before SQL", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    const denied = { query: async () => { calls += 1; return []; } };
    await assert.rejects(createCampaign(context(role), { name: "No" }, denied), /not authorized/i);
    await assert.rejects(updateCampaign(context(role), { campaignHandle, name: "No" }, denied), /not authorized/i);
    await assert.rejects(archiveCampaign(context(role), campaignHandle, denied), /not authorized/i);
    await assert.rejects(updateCampaignAssignment(context(role), { campaignHandle, personHandle, assigneeHandle }, denied), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("campaign mutation HTTP routes support gated Production and Preview while remaining same-origin, permission checked, bounded, and scoped", async () => {
  const helper = await readFile(new URL("../src/lib/campaign-mutation-http.ts", import.meta.url), "utf8");
  const createRoute = await readFile(new URL("../src/app/api/campaigns/route.ts", import.meta.url), "utf8");
  const campaignRoute = await readFile(new URL("../src/app/api/campaigns/[campaignHandle]/route.ts", import.meta.url), "utf8");
  const assignmentRoute = await readFile(new URL("../src/app/api/campaigns/[campaignHandle]/participants/[personHandle]/assignment/route.ts", import.meta.url), "utf8");
  const combined = `${helper}\n${createRoute}\n${campaignRoute}\n${assignmentRoute}`;
  assert.match(helper, /operationalRuntimeEnabled\(\)/);
  assert.match(helper, /hasExactSameOrigin\(request\)/);
  assert.match(helper, /requirePreviewUser\("manageCampaigns"\)/);
  assert.match(helper, /MAX_JSON_BYTES = 8_192/);
  assert.match(createRoute, /createCampaign/);
  assert.match(campaignRoute, /updateCampaign/);
  assert.match(campaignRoute, /archiveCampaign/);
  assert.match(assignmentRoute, /updateCampaignAssignment/);
  assert.doesNotMatch(combined, /campaign_instructions|DELETE FROM local801\.outreach_campaign_population/i);
});
