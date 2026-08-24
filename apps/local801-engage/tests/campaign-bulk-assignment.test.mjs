import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __testing,
  applyCampaignBulkAssignment,
  normalizeCampaignAssignmentCriteria,
  previewCampaignBulkAssignment,
} from "../src/lib/campaign-bulk-assignment.ts";
import { CampaignMutationError } from "../src/lib/campaign-management.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const assigneeId = "44444444-4444-4444-8444-444444444444";
const campaignHandle = "a".repeat(64);
const assigneeHandle = "b".repeat(64);
const revision = "c".repeat(64);
const tokenSecret = "stage18-synthetic-confirmation-secret-only";
const now = Date.parse("2026-08-18T12:00:00.000Z");
const context = (role = "cat_admin") => ({
  organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role,
});
const criteria = {
  membershipStatus: "member",
  department: "Synthetic",
  classification: "",
  workLocation: "Downtown",
  workflowState: "not_contacted",
};

function row(overrides = {}) {
  return [{ campaign_id: campaignId, assignee_id: assigneeId, revision,
    matched_count: "15000", assign_count: "12000", assigned_count: "3000", ...overrides }];
}

async function preview(overrides = {}) {
  return previewCampaignBulkAssignment(context(), campaignHandle, { assigneeHandle, criteria }, {
    query: async () => row(), tokenSecret, now: () => now, ...overrides,
  });
}

test("bulk assignment criteria are bounded and limited to factual workflow filters", () => {
  assert.deepEqual(normalizeCampaignAssignmentCriteria({}), {
    membershipStatus: null, department: "", classification: "", workLocation: "", workflowState: "all",
  });
  assert.throws(() => normalizeCampaignAssignmentCriteria({ workflowState: "high_priority" }), /Workflow status is invalid/);
  assert.throws(() => normalizeCampaignAssignmentCriteria({ membershipStatus: "likely" }), /Membership status is invalid/);
});

test("bulk assignment preview resolves one explicit eligible organizer and returns counts rather than participant handles", async () => {
  let sqlText = "";
  let parameters = [];
  const result = await preview({ query: async (sql, values) => { sqlText = sql; parameters = values; return row(); } });
  assert.equal(result.matched, 15000);
  assert.equal(result.wouldAssign, 12000);
  assert.equal(result.alreadyAssigned, 3000);
  assert.equal("people" in result, false);
  assert.equal("handles" in result, false);
  assert.match(sqlText, /campaign-bulk-assignment:preview/);
  assert.match(sqlText, /selected_assignee/);
  assert.match(sqlText, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.match(sqlText, /LEFT JOIN LATERAL/);
  assert.match(sqlText, /active_assignment\.person_id = member\.person_id/);
  assert.match(sqlText, /ORDER BY active_assignment\.created_at DESC, active_assignment\.id DESC/);
  assert.doesNotMatch(sqlText, /LIMIT\s+20000|OFFSET/i);
  assert.deepEqual(parameters.slice(0, 3), [organizationId, campaignHandle, assigneeHandle]);
  const confirmation = __testing.verify(result.confirmationToken, tokenSecret);
  assert.equal(confirmation.assigneeHandle, assigneeHandle);
  assert.equal(confirmation.wouldAssign, 12000);
});

test("bulk assignment classification criteria match the complete classification", async () => {
  let sqlText = "";
  let parameters = [];
  await previewCampaignBulkAssignment(context(), campaignHandle, {
    assigneeHandle,
    criteria: { ...criteria, classification: "  accounting   officer  " },
  }, {
    query: async (sql, values) => { sqlText = sql; parameters = values; return row(); },
    tokenSecret,
    now: () => now,
  });

  assert.match(sqlText, /lower\(btrim\(person\.classification\)\) = lower\(btrim\(\$6::text\)\)/);
  assert.doesNotMatch(sqlText, /person\.classification ILIKE \$6::text/);
  assert.equal(parameters[5], "accounting officer");
});

test("bulk assignment confirms under a campaign lock, inserts the unassigned set once, verifies counts, and audits atomically", async () => {
  const initial = await preview();
  const calls = [];
  const audits = [];
  const result = await applyCampaignBulkAssignment(context(), campaignHandle, {
    assigneeHandle,
    criteria,
    confirmationToken: initial.confirmationToken,
  }, {
    query: async () => [], tokenSecret, now: () => now + 1,
    transaction: async (callback) => callback(async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (sql.includes("lock-campaign")) return [{ campaign_id: campaignId, assignee_id: assigneeId }];
      if (sql.includes("preview")) return row();
      if (sql.includes("apply")) return [{ changed_count: "12000" }];
      throw new Error("Unexpected SQL");
    }),
    audit: async (event, query) => { audits.push({ event, query }); return { id: "audit" }; },
  });
  assert.deepEqual(result, { assigned: 12000 });
  assert.match(calls[0].sql, /FOR UPDATE OF campaign/);
  assert.match(calls[2].sql, /INSERT INTO local801\.engagement_assignments/);
  assert.match(calls[2].sql, /assignment\.id IS NULL/);
  assert.match(calls[2].sql, /'direct', 'open'/);
  assert.match(calls[2].sql, /selected_assignee/);
  assert.equal(calls[2].parameters.at(-2), null);
  assert.equal(calls[2].parameters.at(-1), userId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event.payload.explicitAssignee, true);
  assert.equal(audits[0].event.payload.changedCount, 12000);
  assert.equal(audits[0].event.payload.department, undefined);
  assert.equal(audits[0].query instanceof Function, true);
});

test("bulk assignment rejects tampering, stale sets, ineligible campaigns, and affected-count races without audit", async () => {
  const initial = await preview();
  await assert.rejects(applyCampaignBulkAssignment(context(), campaignHandle, {
    assigneeHandle, criteria, confirmationToken: `${initial.confirmationToken}x`,
  }, { query: async () => [], tokenSecret, now: () => now + 1 }), (error) => (
    error instanceof CampaignMutationError && error.code === "INVALID_CONFIRMATION"
  ));

  for (const scenario of ["lock", "stale", "count"]) {
    let audits = 0;
    await assert.rejects(applyCampaignBulkAssignment(context(), campaignHandle, {
      assigneeHandle, criteria, confirmationToken: initial.confirmationToken,
    }, {
      query: async () => [], tokenSecret, now: () => now + 1,
      transaction: async (callback) => callback(async (sql) => {
        if (sql.includes("lock-campaign")) return scenario === "lock" ? [] : [{ campaign_id: campaignId, assignee_id: assigneeId }];
        if (sql.includes("preview")) return scenario === "stale" ? row({ revision: "d".repeat(64) }) : row();
        return [{ changed_count: scenario === "count" ? "11999" : "12000" }];
      }),
      audit: async () => { audits += 1; },
    }), (error) => error instanceof CampaignMutationError && [
      "CAMPAIGN_NOT_AVAILABLE", "STALE_CONFIRMATION", "CONCURRENT_CAMPAIGN_CHANGE",
    ].includes(error.code));
    assert.equal(audits, 0);
  }
});

test("bulk assignment denies non-management roles before SQL", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(previewCampaignBulkAssignment(context(role), campaignHandle, { assigneeHandle, criteria }, {
      query: async () => { calls += 1; return []; }, tokenSecret,
    }), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("bulk assignment routes are Preview-guarded, bounded JSON mutations with no internal id input", async () => {
  const [previewRoute, applyRoute, source] = await Promise.all([
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/assignments/bulk/preview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/assignments/bulk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/campaign-bulk-assignment.ts", import.meta.url), "utf8"),
  ]);
  assert.match(previewRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(applyRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(previewRoute, /previewCampaignBulkAssignment/);
  assert.match(applyRoute, /applyCampaignBulkAssignment/);
  assert.doesNotMatch(`${previewRoute}\n${applyRoute}`, /personId|campaignId|assigneeId|organizationId/);
  assert.doesNotMatch(source, /rank|score|optimi[sz]|recommended/i);
});
