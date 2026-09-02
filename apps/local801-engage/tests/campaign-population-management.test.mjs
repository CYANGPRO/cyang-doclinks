import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CampaignMutationError } from "../src/lib/campaign-management.ts";
import {
  __testing,
  addCampaignPopulationMember,
  getCampaignPopulationCandidates,
  getCampaignPopulationFilterOptions,
  removeCampaignPopulationMember,
} from "../src/lib/campaign-population-management.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const campaignId = "33333333-3333-4333-8333-333333333333";
const personId = "44444444-4444-4444-8444-444444444444";
const populationId = "55555555-5555-4555-8555-555555555555";
const campaignHandle = "a".repeat(64);
const personHandle = "b".repeat(64);
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
      uuid: () => populationId,
      ...overrides,
    },
  };
}

test("campaign population candidate search is bounded, protected, organization scoped, draft-only, and excludes contact values", async () => {
  let sqlText = "";
  let parameters = [];
  const result = await getCampaignPopulationCandidates(context(), campaignHandle, "  Synthetic   Health ", async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return [{
      person_handle: personHandle,
      preferred_name: "Synthetic Avery",
      first_name: "Synthetic",
      last_name: "Avery",
      membership_status: "member",
      department: "Health Licensing",
      classification: "Clerical",
      work_location: "Downtown",
    }];
  });
  assert.equal(result.term, "Synthetic Health");
  assert.deepEqual(result.candidates, [{
    personHandle,
    displayName: "Synthetic Avery",
    membershipStatus: "member",
    department: "Health Licensing",
    classification: "Clerical",
    workLocation: "Downtown",
  }]);
  assert.deepEqual(parameters.slice(0, 2), [organizationId, campaignHandle]);
  assert.equal(parameters[3], __testing.MAX_CANDIDATES);
  assert.equal(__testing.MAX_CANDIDATES, 25);
  assert.match(sqlText, /campaign\.status = 'draft'/);
  assert.match(sqlText, /person\.organization_id = \$1::uuid/);
  assert.match(sqlText, /person\.archived_at IS NULL/);
  assert.match(sqlText, /person\.local_number = '0801'/);
  assert.match(sqlText, /NOT EXISTS[\s\S]*outreach_campaign_population/);
  assert.match(sqlText, /LIMIT \$4::integer/);
  assert.match(sqlText, /person_search_tokens/);
  assert.match(sqlText, /contact:work-email/);
  assert.doesNotMatch(sqlText, /contact_value|contact\.contact_value/i);
  assert.equal(JSON.stringify(result).includes(personId), false);
});

test("campaign population dropdown choices are bounded, draft-only, and exclude current participants", async () => {
  let sqlText = "";
  const result = await getCampaignPopulationFilterOptions(context(), campaignHandle, async (sql, parameters) => {
    sqlText = sql;
    assert.deepEqual(parameters, [organizationId, campaignHandle, 200]);
    return [
      { kind: "department", label: "Transportation" },
      { kind: "classification", label: "Planner" },
      { kind: "work_location", label: "Central Office" },
    ];
  });
  assert.deepEqual(result, {
    departments: ["Transportation"],
    classifications: ["Planner"],
    workLocations: ["Central Office"],
  });
  assert.match(sqlText, /campaign\.status = 'draft'/);
  assert.match(sqlText, /person\.archived_at IS NULL/);
  assert.match(sqlText, /NOT EXISTS[\s\S]*outreach_campaign_population/);
  assert.match(sqlText, /PARTITION BY kind/);
  assert.match(sqlText, /COALESCE\(NULLIF\(btrim\(person\.section\)/);
  assert.doesNotMatch(sqlText, /first_name|last_name|person_contact_methods|person_pii/i);
});

test("blank candidate search does no database work", async () => {
  let calls = 0;
  const result = await getCampaignPopulationCandidates(context(), campaignHandle, "   ", async () => {
    calls += 1;
    return [];
  });
  assert.deepEqual(result, { term: "", candidates: [] });
  assert.equal(calls, 0);
});

test("adding a campaign population member is draft-only, deduplicated, role-rechecked, and atomic with audit", async () => {
  const state = deps({
    query: async (sql, parameters) => {
      assert.equal(parameters[0], organizationId);
      assert.deepEqual(parameters.slice(1), [campaignHandle, personHandle]);
      assert.match(sql, /campaign\.status = 'draft'/);
      return [{ campaign_id: campaignId, person_id: personId, already_in_population: false }];
    },
  });
  const result = await addCampaignPopulationMember(context(), campaignHandle, personHandle, state.values);
  assert.equal(result.added, true);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 2);
  const statement = state.transactions[0][0];
  assert.match(statement.sql, /INSERT INTO local801\.outreach_campaign_population/);
  assert.match(statement.sql, /campaign\.status = 'draft'/);
  assert.match(statement.sql, /person\.organization_id = \$1::uuid/);
  assert.match(statement.sql, /person\.local_number = '0801'/);
  assert.match(statement.sql, /role\.code = \$4::text/);
  assert.match(statement.sql, /role\.code IN \('system_owner','local_admin','cat_admin'\)/);
  assert.match(statement.sql, /WHERE NOT EXISTS[\s\S]*outreach_campaign_population existing/);
  assert.deepEqual(statement.parameters, [organizationId, campaignId, userId, "cat_admin", populationId, personId]);
  assert.equal(state.audits[0].eventType, "record.create");
  assert.equal(state.audits[0].subjectType, "outreach_campaign_population");
  assert.deepEqual(state.audits[0].payload, { campaignPopulation: true });
});

test("duplicate or unavailable draft population targets fail before transaction work", async () => {
  const duplicate = deps({ query: async () => [{ campaign_id: campaignId, person_id: personId, already_in_population: true }] });
  await assert.rejects(
    addCampaignPopulationMember(context(), campaignHandle, personHandle, duplicate.values),
    (error) => error instanceof CampaignMutationError && error.code === "ALREADY_IN_POPULATION",
  );
  assert.equal(duplicate.transactions.length, 0);

  const unavailable = deps({ query: async () => [] });
  await assert.rejects(
    addCampaignPopulationMember(context(), campaignHandle, personHandle, unavailable.values),
    (error) => error instanceof CampaignMutationError && error.code === "POPULATION_TARGET_NOT_FOUND",
  );
  assert.equal(unavailable.transactions.length, 0);
});

test("participant removal protects campaign activity and completed assignments", async () => {
  for (const row of [
    { has_engagement: true, has_completed_assignment: false },
    { has_engagement: false, has_completed_assignment: true },
  ]) {
    const state = deps({ query: async () => [{
      population_id: populationId,
      campaign_id: campaignId,
      person_id: personId,
      ...row,
    }] });
    await assert.rejects(
      removeCampaignPopulationMember(context(), campaignHandle, personHandle, state.values),
      (error) => error instanceof CampaignMutationError && error.code === "POPULATION_MEMBER_IMMUTABLE",
    );
    assert.equal(state.transactions.length, 0);
  }
});

test("safe draft participant removal archives open assignments, rechecks activity, deletes population, and audits atomically", async () => {
  const state = deps({ query: async (sql) => {
    assert.match(sql, /campaign\.status = 'draft'/);
    return [{
      population_id: populationId,
      campaign_id: campaignId,
      person_id: personId,
      has_engagement: false,
      has_completed_assignment: false,
    }];
  } });
  const result = await removeCampaignPopulationMember(context(), campaignHandle, personHandle, state.values);
  assert.equal(result.removed, true);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 3);
  const [archiveAssignments, deletePopulation] = state.transactions[0];
  assert.match(archiveAssignments.sql, /UPDATE local801\.engagement_assignments assignment/);
  assert.match(archiveAssignments.sql, /SET archived_at = now\(\)/);
  assert.match(archiveAssignments.sql, /assignment\.status <> 'completed'/);
  assert.match(archiveAssignments.sql, /campaign\.status = 'draft'/);
  assert.match(deletePopulation.sql, /DELETE FROM local801\.outreach_campaign_population population/);
  assert.match(deletePopulation.sql, /campaign\.status = 'draft'/);
  assert.match(deletePopulation.sql, /NOT EXISTS[\s\S]*local801\.engagement_events event/);
  assert.match(deletePopulation.sql, /event\.voided_at IS NULL/);
  assert.match(deletePopulation.sql, /NOT EXISTS[\s\S]*engagement_assignments assignment/);
  assert.match(deletePopulation.sql, /assignment\.status = 'completed'/);
  assert.deepEqual(deletePopulation.parameters, [organizationId, populationId, userId, "cat_admin", campaignId, personId]);
  assert.equal(state.audits[0].eventType, "record.archive");
  assert.equal(state.audits[0].subjectType, "outreach_campaign_population");
  assert.equal(state.audits[0].payload.openAssignmentsArchived, true);
});

test("campaign population management denies non-management roles before SQL", async () => {
  for (const role of ["membership_data_manager", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    const query = async () => { calls += 1; return []; };
    await assert.rejects(getCampaignPopulationCandidates(context(role), campaignHandle, "Synthetic", query), /not authorized/i);
    await assert.rejects(getCampaignPopulationFilterOptions(context(role), campaignHandle, query), /not authorized/i);
    await assert.rejects(addCampaignPopulationMember(context(role), campaignHandle, personHandle, { query }), /not authorized/i);
    await assert.rejects(removeCampaignPopulationMember(context(role), campaignHandle, personHandle, { query }), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("population APIs reuse the hardened Preview mutation guard and accept only opaque handles", async () => {
  const [addRoute, removeRoute, source, page, component] = await Promise.all([
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/population/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/campaigns/[campaignHandle]/population/[personHandle]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/campaign-population-management.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/campaigns/[campaignHandle]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/CampaignPopulationMutations.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(addRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(addRoute, /addCampaignPopulationMember/);
  assert.match(removeRoute, /authorizeCampaignMutation\(request\)/);
  assert.match(removeRoute, /removeCampaignPopulationMember/);
  assert.match(source, /HANDLE_RE = \/\^\[0-9a-f\]\{64\}\$\/i/);
  assert.match(source, /campaign\.status = 'draft'/);
  assert.match(source, /MAX_CANDIDATES = 25/);
  assert.match(source, /person_search_tokens/);
  assert.match(source, /contact:work-email/);
  assert.doesNotMatch(source, /contact_value|contact\.contact_value/i);
  assert.match(page, /Find and add employees/);
  assert.match(page, /Current campaign participants are excluded/);
  assert.match(page, /canManageCampaign && campaign\.status === "draft"/);
  assert.match(page, /candidate_q/);
  assert.match(page, /CampaignPopulationAddButton/);
  assert.match(page, /CampaignPopulationRemoveButton/);
  assert.match(component, /\/api\/campaigns\/\$\{campaignHandle\}\/population/);
  assert.doesNotMatch(`${addRoute}\n${removeRoute}\n${component}`, /personId|campaignId/);
});
