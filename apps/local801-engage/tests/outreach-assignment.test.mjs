import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OutreachAssignmentError,
  __testing,
  assignOutreachOrganizer,
  deleteMemberOutreach,
  getOutreachAssignmentOptions,
} from "../src/lib/outreach-assignment.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const assigneeId = "44444444-4444-4444-8444-444444444444";
const assignmentId = "55555555-5555-4555-8555-555555555555";
const oldAssignmentId = "66666666-6666-4666-8666-666666666666";
const personHandle = createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
const assigneeHandle = __testing.userHandle(organizationId, assigneeId);

function context(role = "cat_lead") {
  return { organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role };
}

function dependencies(overrides = {}) {
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
      uuid: () => assignmentId,
      ...overrides,
    },
  };
}

test("outreach assignment options include every active CAT-or-higher account", async () => {
  let captured = null;
  const options = await getOutreachAssignmentOptions(context(), async (sql, parameters) => {
    captured = { sql, parameters };
    return [{ id: assigneeId, display_name: "Synthetic CAT" }];
  });
  assert.deepEqual(options, [{ handle: assigneeHandle, label: "Synthetic CAT", current: false }]);
  assert.deepEqual(captured.parameters, [organizationId]);
  assert.match(captured.sql, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
});

test("CAT members and every role above them can assign outreach while data-only roles cannot", async () => {
  for (const role of ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"]) {
    await getOutreachAssignmentOptions(context(role), async () => []);
  }
  for (const role of ["membership_data_manager", "report_viewer"]) {
    await assert.rejects(
      getOutreachAssignmentOptions(context(role), async () => { throw new Error("SQL must not run"); }),
      (error) => error instanceof OutreachAssignmentError && error.code === "FORBIDDEN" && error.status === 403,
    );
  }
});

test("assigning outreach atomically replaces only the direct assignment and writes an audit", async () => {
  const state = dependencies({
    query: async (sql) => {
      if (sql.includes("outreach-assignment:resolve-person")) return [{ id: personId }];
      if (sql.includes("outreach-assignment:resolve-assignee")) return [{ id: assigneeId, display_name: "Synthetic CAT" }];
      if (sql.includes("outreach-assignment:current-direct")) return [{ id: oldAssignmentId, primary_user_id: userId }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  const result = await assignOutreachOrganizer(context(), { personHandle, assigneeHandle }, state.values);
  assert.deepEqual(result, { assigned: true, unchanged: false });
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 3);
  const [lock, replace] = state.transactions[0];
  assert.match(lock.sql, /pg_advisory_xact_lock/);
  assert.match(replace.sql, /assignment\.campaign_id IS NULL/);
  assert.match(replace.sql, /assignment\.assignment_type = 'direct'/);
  assert.match(replace.sql, /SET status = 'closed', archived_at = now\(\)/);
  assert.match(replace.sql, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.match(replace.sql, /NULL, person\.id, assignee\.id, NULL, 'direct', 'open'/);
  assert.deepEqual(replace.parameters, [organizationId, assignmentId, userId, "cat_lead", personHandle, assigneeHandle]);
  assert.deepEqual(state.audits[0].payload, {
    source: "member_outreach",
    assignmentType: "direct",
    relationship: "primary",
    replaced: true,
  });
});

test("selecting the current direct organizer is idempotent", async () => {
  const state = dependencies({
    query: async (sql) => {
      if (sql.includes("resolve-person")) return [{ id: personId }];
      if (sql.includes("resolve-assignee")) return [{ id: assigneeId, display_name: "Synthetic CAT" }];
      if (sql.includes("current-direct")) return [{ id: oldAssignmentId, primary_user_id: assigneeId }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  const result = await assignOutreachOrganizer(context(), { personHandle, assigneeHandle }, state.values);
  assert.deepEqual(result, { assigned: true, unchanged: true });
  assert.equal(state.transactions.length, 0);
  assert.equal(state.audits.length, 0);
});

test("duplicate active direct assignments fail closed before mutation", async () => {
  const state = dependencies({
    query: async (sql) => {
      if (sql.includes("resolve-person")) return [{ id: personId }];
      if (sql.includes("resolve-assignee")) return [{ id: assigneeId, display_name: "Synthetic CAT" }];
      if (sql.includes("current-direct")) return [
        { id: oldAssignmentId, primary_user_id: userId },
        { id: assignmentId, primary_user_id: userId },
      ];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  await assert.rejects(
    assignOutreachOrganizer(context(), { personHandle, assigneeHandle }, state.values),
    (error) => error instanceof OutreachAssignmentError && error.code === "ASSIGNMENT_CONFLICT" && error.status === 409,
  );
  assert.equal(state.transactions.length, 0);
});

test("deleting member outreach archives only the active direct assignment and retains history", async () => {
  const state = dependencies({
    query: async (sql) => {
      if (sql.includes("outreach-assignment:resolve-person")) return [{ id: personId }];
      if (sql.includes("outreach-assignment:current-direct-for-delete")) return [{ id: oldAssignmentId, primary_user_id: assigneeId }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  const result = await deleteMemberOutreach(context(), { personHandle }, state.values);
  assert.deepEqual(result, { deleted: true });
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 3);
  const [lock, archive] = state.transactions[0];
  assert.match(lock.sql, /pg_advisory_xact_lock/);
  assert.match(archive.sql, /SET status = 'closed', archived_at = now\(\)/);
  assert.match(archive.sql, /assignment\.campaign_id IS NULL/);
  assert.match(archive.sql, /assignment\.assignment_type = 'direct'/);
  assert.match(archive.sql, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.doesNotMatch(archive.sql, /engagement_events|engagement_followups|outreach_campaign_population/);
  assert.deepEqual(archive.parameters, [organizationId, oldAssignmentId, userId, "cat_lead", personHandle]);
  assert.equal(state.audits[0].eventType, "record.archive");
  assert.equal(state.audits[0].subjectType, "engagement_assignment");
  assert.deepEqual(state.audits[0].payload, {
    source: "member_outreach",
    assignmentType: "direct",
    removedFromActiveOutreach: true,
    campaignAssignmentsRetained: true,
    followupsRetained: true,
    engagementHistoryRetained: true,
  });
});

test("member outreach assignment removal is available to CAT members and every role above", async () => {
  for (const role of ["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"]) {
    const state = dependencies({
      query: async (sql) => {
        if (sql.includes("resolve-person")) return [{ id: personId }];
        if (sql.includes("current-direct-for-delete")) return [{ id: oldAssignmentId }];
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });
    await deleteMemberOutreach(context(role), { personHandle }, state.values);
  }
  for (const role of ["membership_data_manager", "report_viewer"]) {
    await assert.rejects(
      deleteMemberOutreach(context(role), { personHandle }, { query: async () => { throw new Error("SQL must not run"); } }),
      (error) => error instanceof OutreachAssignmentError && error.code === "FORBIDDEN" && error.status === 403,
    );
  }
});

test("member outreach delete fails closed when no single direct assignment is available", async () => {
  for (const rows of [[], [{ id: oldAssignmentId }, { id: assignmentId }]]) {
    const state = dependencies({
      query: async (sql) => {
        if (sql.includes("resolve-person")) return [{ id: personId }];
        if (sql.includes("current-direct-for-delete")) return rows;
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });
    await assert.rejects(
      deleteMemberOutreach(context(), { personHandle }, state.values),
      (error) => error instanceof OutreachAssignmentError && ["NOT_FOUND", "ASSIGNMENT_CONFLICT"].includes(error.code),
    );
    assert.equal(state.transactions.length, 0);
    assert.equal(state.audits.length, 0);
  }
});

test("outreach assignment endpoint and member control retain request-security guardrails", () => {
  const route = readFileSync(new URL("../src/app/api/outreach/[handle]/assignment/route.ts", import.meta.url), "utf8");
  const control = readFileSync(new URL("../src/components/OutreachAssignmentControl.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/outreach/[handle]/page.tsx", import.meta.url), "utf8");
  const access = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
  assert.match(route, /operationalRuntimeEnabled\(\)/);
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /requirePreviewUser\("assignOutreach"\)/);
  assert.match(route, /enforceWorkspaceRateLimit\(context, "mutation"\)/);
  assert.match(route, /MAX_JSON_BYTES = 2_048/);
  assert.match(control, /method: "POST"/);
  assert.match(control, /method: "DELETE"/);
  assert.match(control, /Delete from member outreach/);
  assert.match(control, /Campaign assignments, follow-ups, conversations, and audit history will be retained/);
  assert.match(control, /Choose a CAT member or higher/);
  assert.match(control, /router\.refresh\(\)/);
  assert.match(page, /<OutreachAssignmentControl/);
  assert.match(page, /canDelete=\{workspace\.activeDirectAssignmentCount > 0\}/);
  assert.match(page, /can\(user\.role, "assignOutreach"\)/);
  assert.match(access, /assignOutreach: \["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"\]/);
});
