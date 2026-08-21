import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FollowupUpdateError,
  __testing as managementTesting,
  updateOutreachFollowup,
} from "../src/lib/follow-up-management.ts";
import { __testing as queueTesting } from "../src/lib/follow-ups.ts";

const route = readFileSync(new URL("../src/app/api/outreach/[handle]/followups/[followupHandle]/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/follow-ups/page.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/components/FollowupEditForm.tsx", import.meta.url), "utf8");
const queueService = readFileSync(new URL("../src/lib/follow-ups.ts", import.meta.url), "utf8");
const management = readFileSync(new URL("../src/lib/follow-up-management.ts", import.meta.url), "utf8");

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationSlug: "local-801",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "lead@example.test",
  role: "cat_lead",
};

const HANDLE = "a".repeat(64);
const FOLLOWUP_HANDLE = "b".repeat(64);
const USER_HANDLE = "c".repeat(64);
const FOLLOWUP_ID = "33333333-3333-4333-8333-333333333333";
const PERSON_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";

test("future due normalization accepts a bounded future date and rejects past dates", () => {
  const now = new Date("2026-08-14T21:00:00.000Z");
  assert.equal(managementTesting.normalizeDueAt("2026-08-15T21:00:00.000Z", now), "2026-08-15T21:00:00.000Z");
  assert.throws(
    () => managementTesting.normalizeDueAt("2026-08-14T20:59:59.000Z", now),
    (error) => error instanceof FollowupUpdateError && error.code === "INVALID_DUE_AT",
  );
});

test("opaque handle validation rejects malformed browser identifiers", () => {
  assert.equal(managementTesting.requireHandle(HANDLE, "Employee"), HANDLE);
  assert.throws(
    () => managementTesting.requireHandle("not-a-handle", "Employee"),
    (error) => error instanceof FollowupUpdateError && error.code === "INVALID_HANDLE",
  );
});

test("queue assignee option normalization drops malformed and duplicate values", () => {
  assert.deepEqual(queueTesting.normalizeAssigneeOptions([
    { handle: USER_HANDLE, label: "Synthetic CAT Lead" },
    { handle: USER_HANDLE.toUpperCase(), label: "Duplicate" },
    { handle: "bad", label: "Bad" },
    { handle: "d".repeat(64), label: "  Synthetic CAT Member  " },
  ]), [
    { handle: USER_HANDLE, label: "Synthetic CAT Lead" },
    { handle: "d".repeat(64), label: "Synthetic CAT Member" },
  ]);
});

test("reschedule-only update is atomic and audited", async () => {
  const queries = [];
  const transactions = [];
  const query = async (sql, parameters = []) => {
    queries.push({ sql, parameters });
    if (sql.includes("resolve-open-followup")) {
      return [{
        id: FOLLOWUP_ID,
        person_id: PERSON_ID,
        assigned_to: context.userId,
        due_at: "2026-08-14T19:00:00.000Z",
      }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  await updateOutreachFollowup(context, {
    personHandle: HANDLE,
    followupHandle: FOLLOWUP_HANDLE,
    dueAt: "2026-08-15T17:00:00.000Z",
  }, {
    query,
    now: () => new Date("2026-08-14T21:00:00.000Z"),
    runTransaction: async (statements) => { transactions.push(statements); },
    prepareAudit: async () => ({ sql: "/* audit */ SELECT 1", parameters: [] }),
  });
  assert.equal(queries.length, 1);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  assert.match(transactions[0][0].sql, /status = 'open'/);
  assert.match(transactions[0][0].sql, /actor_assignment\.status = 'open'/);
  assert.equal(transactions[0][0].parameters[7], true);
  assert.equal(transactions[0][0].parameters[8], false);
});

test("CAT Lead reassignment resolves only an organizer in current open employee assignments", async () => {
  const queries = [];
  const transactions = [];
  const query = async (sql, parameters = []) => {
    queries.push({ sql, parameters });
    if (sql.includes("resolve-open-followup")) {
      return [{
        id: FOLLOWUP_ID,
        person_id: PERSON_ID,
        assigned_to: context.userId,
        due_at: "2026-08-15T17:00:00.000Z",
      }];
    }
    if (sql.includes("resolve-assignee")) {
      return [{ id: USER_ID, display_name: "Synthetic CAT Member" }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const result = await updateOutreachFollowup(context, {
    personHandle: HANDLE,
    followupHandle: FOLLOWUP_HANDLE,
    assigneeHandle: USER_HANDLE,
  }, {
    query,
    runTransaction: async (statements) => { transactions.push(statements); },
    prepareAudit: async () => ({ sql: "/* audit */ SELECT 1", parameters: [] }),
  });
  assert.equal(result.reassigned, true);
  assert.equal(result.assigneeLabel, "Synthetic CAT Member");
  assert.match(queries[1].sql, /\$4::text = 'cat_lead'/);
  assert.match(queries[1].sql, /assignment\.status = 'open'/);
  assert.match(queries[1].sql, /primary_user_id = candidate\.id/);
  assert.equal(transactions[0][0].parameters[8], true);
});

test("CAT Member server policy only permits self as a reassignment target", () => {
  assert.match(management, /\$4::text = 'cat_member' AND candidate\.id = \$5::uuid/);
  assert.match(management, /\$5::text = 'cat_member' AND candidate\.id = \$4::uuid/);
});

test("non-admin actors can only edit a follow-up currently assigned to them and inside open assignment scope", () => {
  assert.match(management, /item\.assigned_to = \$2::uuid[\s\S]*assignment\.status = 'open'/);
  assert.match(management, /item\.assigned_to = actor\.id[\s\S]*actor_assignment\.status = 'open'/);
});

test("administrative roles can reassign to active authorized organizers organization-wide", () => {
  assert.match(management, /\$4::text IN \('system_owner','local_admin','cat_admin'\)/);
  assert.match(management, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
});

test("completed follow-ups are excluded from mutation at resolve and atomic update", () => {
  const occurrences = management.match(/item\.status = 'open'/g) ?? [];
  const completedChecks = management.match(/item\.completed_at IS NULL/g) ?? [];
  assert.ok(occurrences.length >= 2);
  assert.ok(completedChecks.length >= 2);
});

test("queue supplies role-scoped opaque organizer options without exposing user UUIDs", () => {
  assert.match(queueService, /AS assigned_to_handle/);
  assert.match(queueService, /jsonb_build_object\([\s\S]*'handle'[\s\S]*digest\('user:'/);
  assert.match(queueService, /\$4::text = 'cat_lead'[\s\S]*target_assignment\.status = 'open'/);
  assert.match(queueService, /\$4::text = 'cat_member' AND app_user\.id = \$2::uuid/);
  assert.doesNotMatch(page, /assignedToId|personId|followupId|userId/);
});

test("existing route keeps PUT completion and adds protected PATCH editing", () => {
  assert.match(route, /export async function PUT/);
  assert.match(route, /completeOutreachFollowup/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /updateOutreachFollowup/);
  assert.match(route, /hasExactSameOrigin/);
  assert.match(route, /requirePreviewUser\("recordEngagement"\)/);
  assert.match(route, /MAX_JSON_BYTES = 4_096/);
  assert.match(route, /VERCEL_ENV === "production"/);
});

test("edit client only sends changed fields and uses PATCH", () => {
  assert.match(component, /method: "PATCH"/);
  assert.match(component, /payload\.dueAt = parsed\.toISOString/);
  assert.match(component, /payload\.assigneeHandle = assigneeHandle/);
  assert.match(component, /Object\.keys\(payload\)\.length === 0/);
  assert.match(component, /router\.refresh\(\)/);
});

test("Follow-ups page renders edit controls only for open items", () => {
  assert.match(page, /item\.status === "open" \? <FollowupEditForm/);
  assert.match(page, /Completed follow-ups are read-only in this view/);
  assert.match(page, /Changes are audited/);
});

test("reassignment and due-date change are recorded in a durable audit event", () => {
  assert.match(management, /eventType: "record\.update"/);
  assert.match(management, /subjectType: "engagement_followup"/);
  assert.match(management, /dueAtChanged/);
  assert.match(management, /reassigned: assigneeChanged/);
  assert.match(management, /runTransaction\(\[updateStatement, audit\]\)/);
});

test("no-op update is rejected before transaction", async () => {
  const query = async (sql) => {
    if (sql.includes("resolve-open-followup")) {
      return [{
        id: FOLLOWUP_ID,
        person_id: PERSON_ID,
        assigned_to: context.userId,
        due_at: "2026-08-15T17:00:00.000Z",
      }];
    }
    if (sql.includes("resolve-assignee")) {
      return [{ id: context.userId, display_name: "Synthetic CAT Lead" }];
    }
    throw new Error("unexpected");
  };
  await assert.rejects(
    updateOutreachFollowup(context, {
      personHandle: HANDLE,
      followupHandle: FOLLOWUP_HANDLE,
      dueAt: "2026-08-15T17:00:00.000Z",
      assigneeHandle: USER_HANDLE,
    }, {
      query,
      now: () => new Date("2026-08-14T21:00:00.000Z"),
      runTransaction: async () => { throw new Error("should not run"); },
    }),
    (error) => error instanceof FollowupUpdateError && error.code === "NO_CHANGES",
  );
});
