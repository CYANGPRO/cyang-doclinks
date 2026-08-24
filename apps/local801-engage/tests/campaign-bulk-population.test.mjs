import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __testing,
  applyCampaignPopulationChange,
  normalizeCampaignPopulationCriteria,
  previewCampaignPopulationChange,
} from "../src/lib/campaign-bulk-population.ts";
import { CampaignMutationError } from "../src/lib/campaign-management.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const campaignHandle = "a".repeat(64);
const revision = "b".repeat(64);
const includeHandle = "c".repeat(64);
const excludeHandle = "d".repeat(64);
const tokenSecret = "stage18-synthetic-confirmation-secret-only";
const now = Date.parse("2026-08-18T12:00:00.000Z");
const context = (role = "cat_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});
const searchMaterial = async () => ({ protectedMode: true, tokens: [], email: null });
const criteria = {
  membershipStatus: "member",
  department: "Synthetic Health",
  classification: "",
  workLocation: "Downtown",
  search: "",
  includeHandles: [includeHandle],
  excludeHandles: [excludeHandle],
};

function previewRow(overrides = {}) {
  return [{
    campaign_id: campaignId,
    revision,
    matched_count: "12000",
    present_count: "2000",
    change_count: "10000",
    excluded_count: "1",
    unavailable_count: "0",
    protected_count: "0",
    ...overrides,
  }];
}

async function makePreview(overrides = {}) {
  return previewCampaignPopulationChange(context(), campaignHandle, { operation: "add", criteria }, {
    query: async () => previewRow(),
    searchMaterial,
    tokenSecret,
    now: () => now,
    ...overrides,
  });
}

test("population criteria are canonical, bounded, deduplicated, and require an intentional selector", () => {
  const normalized = normalizeCampaignPopulationCriteria({
    membershipStatus: "member",
    department: `  Synthetic   ${"x".repeat(100)}  `,
    includeHandles: [includeHandle, includeHandle, excludeHandle],
    excludeHandles: [excludeHandle, excludeHandle],
  });
  assert.equal(normalized.department.length, __testing.MAX_FILTER_LENGTH);
  assert.deepEqual(normalized.includeHandles, [includeHandle]);
  assert.deepEqual(normalized.excludeHandles, [excludeHandle]);
  assert.throws(() => normalizeCampaignPopulationCriteria({}), (error) => (
    error instanceof CampaignMutationError && error.code === "EMPTY_CRITERIA"
  ));
  assert.throws(() => normalizeCampaignPopulationCriteria({ membershipStatus: "maybe" }), /Membership status is invalid/);
  assert.throws(() => normalizeCampaignPopulationCriteria({ includeHandles: Array(51).fill(includeHandle) }), /limited to 50/);
});

test("population preview returns aggregate counts and an actor/campaign/criteria-bound expiring token", async () => {
  let sqlText = "";
  let parameters = [];
  const preview = await makePreview({
    query: async (sql, values) => {
      sqlText = sql;
      parameters = values;
      return previewRow();
    },
  });
  assert.deepEqual({
    matched: preview.matched,
    alreadyPresent: preview.alreadyPresent,
    wouldChange: preview.wouldChange,
    excluded: preview.excluded,
    unavailable: preview.unavailable,
    protectedActivity: preview.protectedActivity,
  }, { matched: 12000, alreadyPresent: 2000, wouldChange: 10000, excluded: 1, unavailable: 0, protectedActivity: 0 });
  assert.equal(preview.expiresAt, "2026-08-18T12:10:00.000Z");
  const confirmation = __testing.readConfirmation(preview.confirmationToken, tokenSecret);
  assert.equal(confirmation.organizationId, organizationId);
  assert.equal(confirmation.actorId, userId);
  assert.equal(confirmation.campaignHandle, campaignHandle);
  assert.equal(confirmation.wouldChange, 10000);
  assert.match(sqlText, /campaign-bulk-population:preview/);
  assert.match(sqlText, /count\(state\.person_id\)/);
  assert.match(sqlText, /jsonb_to_recordset/);
  assert.match(sqlText, /person_search_tokens/);
  assert.match(sqlText, /pii_exact_indexes/);
  assert.doesNotMatch(sqlText, /SELECT\s+person\.first_name|SELECT\s+person\.last_name/i);
  assert.equal(parameters[0], organizationId);
  assert.equal(parameters[1], campaignHandle);
  assert.equal(parameters.includes(includeHandle), false);
  assert.match(parameters[9], new RegExp(includeHandle));
});

test("campaign population classification criteria match the complete classification", async () => {
  let sqlText = "";
  let parameters = [];
  await previewCampaignPopulationChange(context(), campaignHandle, {
    operation: "add",
    criteria: { ...criteria, classification: "  accounting   officer  " },
  }, {
    query: async (sql, values) => { sqlText = sql; parameters = values; return previewRow(); },
    searchMaterial,
    tokenSecret,
    now: () => now,
  });

  assert.match(sqlText, /lower\(btrim\(person\.classification\)\) = lower\(btrim\(\$5::text\)\)/);
  assert.doesNotMatch(sqlText, /person\.classification ILIKE \$5::text/);
  assert.equal(parameters[4], "accounting officer");
  assert.match(sqlText, /person\.classification ILIKE \$7::text/);
});

test("population apply locks and rechecks the live set, mutates set-wise, verifies counts, and audits once in the transaction", async () => {
  const preview = await makePreview();
  const calls = [];
  const audits = [];
  const result = await applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "add",
    criteria,
    confirmationToken: preview.confirmationToken,
  }, {
    query: async () => [],
    searchMaterial,
    tokenSecret,
    now: () => now + 1,
    transaction: async (callback) => callback(async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (sql.includes("lock-campaign")) return [{ campaign_id: campaignId }];
      if (sql.includes("preview")) return previewRow();
      if (sql.includes("apply")) return [{ changed_count: "10000" }];
      throw new Error("Unexpected SQL");
    }),
    audit: async (event, query) => {
      audits.push({ event, query });
      return { id: "audit" };
    },
  });
  assert.deepEqual(result, { changed: 10000, operation: "add" });
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /FOR UPDATE OF campaign/);
  assert.match(calls[0].sql, /role\.code IN \('system_owner','local_admin','cat_admin'\)/);
  assert.match(calls[2].sql, /INSERT INTO local801\.outreach_campaign_population/);
  assert.match(calls[2].sql, /ON CONFLICT \(campaign_id, person_id\) DO NOTHING/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event.eventType, "record.update");
  assert.deepEqual(audits[0].event.payload, {
    bulkPopulation: true,
    operation: "add",
    changedCount: 10000,
    matchedCount: 12000,
    protectedCount: 0,
    openAssignmentsArchived: false,
    membershipCriterion: true,
    departmentCriterion: true,
    classificationCriterion: false,
    locationCriterion: true,
    searchCriterion: false,
    explicitIncludeCount: 1,
    explicitExcludeCount: 1,
  });
  assert.equal(audits[0].event.payload.department, undefined);
  assert.equal(audits[0].query instanceof Function, true);
});

test("remove preview and apply protect activity and delete only the safe live subset", async () => {
  const preview = await previewCampaignPopulationChange(context(), campaignHandle, { operation: "remove", criteria }, {
    query: async () => previewRow({ present_count: "9000", change_count: "8500", protected_count: "500" }),
    searchMaterial,
    tokenSecret,
    now: () => now,
  });
  let applySql = "";
  const result = await applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "remove", criteria, confirmationToken: preview.confirmationToken,
  }, {
    query: async () => [], searchMaterial, tokenSecret, now: () => now + 1,
    transaction: async (callback) => callback(async (sql) => {
      if (sql.includes("lock-campaign")) return [{ campaign_id: campaignId }];
      if (sql.includes("preview")) return previewRow({ present_count: "9000", change_count: "8500", protected_count: "500" });
      applySql = sql;
      return [{ changed_count: "8500" }];
    }),
    audit: async () => ({ id: "audit" }),
  });
  assert.equal(preview.protectedActivity, 500);
  assert.equal(result.changed, 8500);
  assert.match(applySql, /DELETE FROM local801\.outreach_campaign_population/);
  assert.match(applySql, /UPDATE local801\.engagement_assignments assignment/);
  assert.match(applySql, /SET archived_at = now\(\)/);
  assert.match(applySql, /NOT state\.protected_activity/);
});

test("tampered, expired, criteria-mismatched, and stale confirmations fail closed without a mutation or audit", async () => {
  const preview = await makePreview();
  const base = { query: async () => [], searchMaterial, tokenSecret };
  await assert.rejects(applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "add", criteria, confirmationToken: `${preview.confirmationToken.slice(0, -1)}x`,
  }, base), (error) => error instanceof CampaignMutationError && error.code === "INVALID_CONFIRMATION");
  await assert.rejects(applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "add", criteria, confirmationToken: preview.confirmationToken,
  }, { ...base, now: () => now + (__testing.CONFIRMATION_SECONDS + 1) * 1000 }), (error) => (
    error instanceof CampaignMutationError && error.code === "CONFIRMATION_EXPIRED"
  ));
  await assert.rejects(applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "add", criteria: { ...criteria, department: "Changed" }, confirmationToken: preview.confirmationToken,
  }, { ...base, now: () => now + 1 }), (error) => error instanceof CampaignMutationError && error.code === "CONFIRMATION_MISMATCH");

  let applyCalls = 0;
  let auditCalls = 0;
  await assert.rejects(applyCampaignPopulationChange(context(), campaignHandle, {
    operation: "add", criteria, confirmationToken: preview.confirmationToken,
  }, {
    ...base,
    now: () => now + 1,
    transaction: async (callback) => callback(async (sql) => {
      if (sql.includes("lock-campaign")) return [{ campaign_id: campaignId }];
      if (sql.includes("preview")) return previewRow({ revision: "e".repeat(64) });
      applyCalls += 1;
      return [];
    }),
    audit: async () => { auditCalls += 1; },
  }), (error) => error instanceof CampaignMutationError && error.code === "STALE_CONFIRMATION");
  assert.equal(applyCalls, 0);
  assert.equal(auditCalls, 0);
});

test("bulk population denies non-management roles before any database work", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(previewCampaignPopulationChange(context(role), campaignHandle, { operation: "add", criteria }, {
      query: async () => { calls += 1; return []; }, searchMaterial, tokenSecret,
    }), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("bulk population routes reuse the Preview mutation guard and never accept internal ids", async () => {
  const [previewRoute, applyRoute, source] = await Promise.all([
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/population/bulk/preview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/population/bulk/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/campaign-bulk-population.ts", import.meta.url), "utf8"),
  ]);
  assert.match(previewRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(applyRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(previewRoute, /previewCampaignPopulationChange/);
  assert.match(applyRoute, /applyCampaignPopulationChange/);
  assert.doesNotMatch(`${previewRoute}\n${applyRoute}`, /personId|campaignId|organizationId/);
  assert.match(source, /MAX_EXCEPTIONS = 50/);
  assert.match(source, /withLocal801Transaction/);
});
