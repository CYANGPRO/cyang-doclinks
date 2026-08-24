import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NewHireAssignmentError,
  __testing,
  assignNewHireOrganizer,
  getNewHireAssignmentOptions,
} from "../src/lib/new-hire-assignment.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const assigneeId = "44444444-4444-4444-8444-444444444444";
const assignmentId = "55555555-5555-4555-8555-555555555555";
const personHandle = createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
const assigneeHandle = __testing.userHandle(organizationId, assigneeId);
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});

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
      uuid: () => assignmentId,
      ...overrides,
    },
  };
}

test("New Hires assignment options expose CAT organizers through opaque handles", async () => {
  let sqlText = "";
  const options = await getNewHireAssignmentOptions(context(), async (sql, parameters) => {
    sqlText = sql;
    assert.deepEqual(parameters, [organizationId]);
    return [{ id: assigneeId, display_name: "Synthetic CAT Lead" }];
  });

  assert.deepEqual(options, [{ handle: assigneeHandle, label: "Synthetic CAT Lead", current: false }]);
  assert.match(sqlText, /role\.code IN \('cat_admin','cat_lead','cat_member'\)/);
  assert.doesNotMatch(sqlText, /membership_data_manager/);
  assert.equal(JSON.stringify(options).includes(assigneeId), false);
});

test("New Hires assignment is allowed for every role except CAT Member and Report Viewer", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"]) {
    let calls = 0;
    await getNewHireAssignmentOptions(context(role), async () => { calls += 1; return []; });
    assert.equal(calls, 1, `${role} should be allowed to load assignment options`);
  }

  for (const role of ["cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(
      getNewHireAssignmentOptions(context(role), async () => { calls += 1; return []; }),
      (error) => error instanceof NewHireAssignmentError && error.code === "FORBIDDEN" && error.status === 403,
    );
    assert.equal(calls, 0, `${role} must be denied before SQL`);
  }
});

test("assigning a new hire creates one direct primary assignment atomically with audit", async () => {
  const state = deps({
    query: async (sql, parameters) => {
      assert.equal(parameters[0], organizationId);
      if (sql.includes("new-hire-assignment:resolve-person")) {
        assert.equal(parameters[1], personHandle);
        return [{ id: personId }];
      }
      if (sql.includes("new-hire-assignment:resolve-assignee")) {
        assert.equal(parameters[1], assigneeHandle);
        return [{ id: assigneeId, display_name: "Synthetic CAT Lead" }];
      }
      if (sql.includes("new-hire-assignment:existing-open")) {
        assert.deepEqual(parameters, [organizationId, personId]);
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  const result = await assignNewHireOrganizer(context(), { personHandle, assigneeHandle }, state.values);
  assert.deepEqual(result, { assigned: true });
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 3);

  const [lock, insert] = state.transactions[0];
  assert.match(lock.sql, /pg_advisory_xact_lock/);
  assert.deepEqual(lock.parameters, [organizationId, personId]);
  assert.match(insert.sql, /INSERT INTO local801\.engagement_assignments/);
  assert.match(insert.sql, /NULL, person\.id, assignee\.id, NULL, 'direct', 'open', actor\.id/);
  assert.match(insert.sql, /role\.code IN \('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead'\)/);
  assert.match(insert.sql, /role\.code IN \('cat_admin','cat_lead','cat_member'\)/);
  assert.match(insert.sql, /NOT EXISTS[\s\S]*local801\.engagement_assignments current_assignment/);
  assert.deepEqual(insert.parameters, [organizationId, assignmentId, userId, "local_admin", personHandle, assigneeHandle]);

  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].eventType, "record.create");
  assert.equal(state.audits[0].subjectType, "engagement_assignment");
  assert.equal(state.audits[0].subjectId, assignmentId);
  assert.deepEqual(state.audits[0].payload, {
    source: "new_hires",
    assignmentType: "direct",
    relationship: "primary",
  });
});

test("an existing open assignment blocks a duplicate write", async () => {
  const state = deps({
    query: async (sql) => {
      if (sql.includes("resolve-person")) return [{ id: personId }];
      if (sql.includes("resolve-assignee")) return [{ id: assigneeId, display_name: "Synthetic CAT Lead" }];
      if (sql.includes("existing-open")) return [{ id: assignmentId }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  await assert.rejects(
    assignNewHireOrganizer(context(), { personHandle, assigneeHandle }, state.values),
    (error) => error instanceof NewHireAssignmentError && error.code === "ALREADY_ASSIGNED" && error.status === 409,
  );
  assert.equal(state.transactions.length, 0);
  assert.equal(state.audits.length, 0);
});

test("New Hires assignment endpoint and control retain permission and request-security guardrails", () => {
  const route = readFileSync(new URL("../src/app/api/new-hires/[handle]/assignment/route.ts", import.meta.url), "utf8");
  const control = readFileSync(new URL("../src/components/NewHireAssignmentControl.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/new-hires/page.tsx", import.meta.url), "utf8");
  const access = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");

  assert.match(route, /operationalRuntimeEnabled\(\)/);
  assert.match(route, /enforceWorkspaceRateLimit\(context, "mutation"\)/);
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /requirePreviewUser\("assignNewHires"\)/);
  assert.match(route, /MAX_JSON_BYTES = 2_048/);
  assert.match(route, /assignNewHireOrganizer/);
  assert.match(control, /method: "POST"/);
  assert.match(control, /Select CAT member/);
  assert.match(control, /router\.refresh\(\)/);
  assert.match(page, /const canAssignNewHires = can\(user\.role, "assignNewHires"\)/);
  assert.match(page, /permission="assignNewHires"/);
  assert.match(page, /hydrateEngagementFormOptionsFromProtectedPii/);
  assert.match(page, /!person\.assigned && canAssignNewHires/);
  assert.match(page, /<NewHireAssignmentControl/);
  assert.match(access, /assignNewHires: \["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"\]/);
  assert.doesNotMatch(access, /assignNewHires: \[[^\]]*cat_member/);
  assert.doesNotMatch(access, /assignNewHires: \[[^\]]*report_viewer/);
});
