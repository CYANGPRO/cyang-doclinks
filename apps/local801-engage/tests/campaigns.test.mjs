import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getCampaignDetail, getCampaignPopulationPage, getCampaignsPage, __testing } from "../src/lib/campaigns.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const campaignHandle = "a".repeat(64);
const personHandle = "b".repeat(64);
const context = (role = "cat_admin") => ({ organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role });

function campaignRow(overrides = {}) {
  return {
    campaign_handle: campaignHandle,
    name: "Synthetic Campaign",
    status: "active",
    starts_on: "2026-08-01",
    ends_on: "2026-09-01",
    launched_at: "2026-08-01T12:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    population_count: "20000",
    assigned_count: "18000",
    contacted_count: "12000",
    completed_count: "10000",
    ...overrides,
  };
}

test("campaign portfolio exposes opaque handles and aggregate progress only", async () => {
  const page = await getCampaignsPage(context(), {}, async () => [campaignRow()]);
  assert.deepEqual(page.campaigns[0], {
    handle: campaignHandle,
    name: "Synthetic Campaign",
    status: "active",
    startsOn: "2026-08-01",
    endsOn: "2026-09-01",
    launchedAt: "2026-08-01T12:00:00.000Z",
    population: 20000,
    assigned: 18000,
    contacted: 12000,
    completed: 10000,
    remaining: 10000,
    completionPercentage: 50,
  });
  assert.equal("id" in page.campaigns[0], false);
});

test("campaign keyset cursor contains only timestamp plus opaque campaign handle", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => campaignRow({
    campaign_handle: index.toString(16).padStart(64, "0"),
    name: `Synthetic Campaign ${index}`,
    created_at: new Date(Date.UTC(2026, 7, 26 - index)).toISOString(),
  }));
  const page = await getCampaignsPage(context(), { pageSize: 25 }, async () => rows);
  assert.equal(typeof page.nextCursor, "string");
  const decoded = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["createdAt", "handle"]);
  assert.match(decoded.handle, /^[0-9a-f]{64}$/);
  assert.equal("id" in decoded, false);
  assert.deepEqual(__testing.campaignCursor(page.nextCursor), decoded);
});

test("campaign detail resolves an opaque handle inside organization scope", async () => {
  let sqlText = "";
  let parameters = [];
  const detail = await getCampaignDetail(context(), campaignHandle, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return [campaignRow({ name: "Campaign Detail" })];
  });
  assert.equal(detail?.handle, campaignHandle);
  assert.equal(detail?.name, "Campaign Detail");
  assert.deepEqual(parameters, [organizationId, campaignHandle]);
  assert.match(sqlText, /campaign\.organization_id = \$1::uuid/);
  assert.match(sqlText, /encode\(public\.digest\('campaign:'/);
  assert.match(sqlText, /= \$2::text/);
  assert.match(sqlText, /campaign\.archived_at IS NULL/);
  assert.match(sqlText, /count\(DISTINCT assignment\.person_id\)/);
  assert.match(sqlText, /count\(DISTINCT event\.person_id\)/);
  assert.doesNotMatch(sqlText, /campaign\.id = \$2::uuid/);
});

test("invalid campaign handles fail closed before database work", async () => {
  let calls = 0;
  const detail = await getCampaignDetail(context(), "not-an-opaque-handle", async () => {
    calls += 1;
    return [];
  });
  assert.equal(detail, null);
  assert.equal(calls, 0);
});

test("campaign read services deny roles without manageCampaigns before SQL", async () => {
  for (const run of [
    (query) => getCampaignsPage(context("cat_lead"), {}, query),
    (query) => getCampaignDetail(context("cat_lead"), campaignHandle, query),
    (query) => getCampaignPopulationPage(context("cat_lead"), campaignHandle, {}, query),
  ]) {
    let calls = 0;
    await assert.rejects(run(async () => { calls += 1; return []; }), /Forbidden/);
    assert.equal(calls, 0);
  }
});

test("campaign participant detail uses opaque employee handles and bounded keyset pagination", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    person_handle: index.toString(16).padStart(64, "0"),
    first_name: `Synthetic${index}`,
    last_name: "Participant",
    department: "Synthetic",
    assignment_status: "open",
    assignee_name: "Synthetic CAT Lead",
    assignment_due_at: "2026-08-20T12:00:00.000Z",
    total_count: "20000",
  }));
  let sqlText = "";
  let parameters = [];
  const detail = await getCampaignPopulationPage(context(), campaignHandle, { pageSize: 100 }, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return rows;
  });
  assert.equal(detail.people.length, 100);
  assert.equal(detail.total, 20000);
  assert.equal(detail.hasNext, true);
  assert.equal(detail.people[0].personHandle, "0".repeat(64));
  assert.equal("person_id" in detail.people[0], false);
  assert.equal(detail.people[0].assignee_name, "Synthetic CAT Lead");
  assert.equal(detail.people[0].assignment_due_at, "2026-08-20T12:00:00.000Z");
  assert.deepEqual(parameters.slice(0, 2), [organizationId, campaignHandle]);
  assert.equal(parameters.at(-1), 101);
  assert.match(sqlText, /member\.organization_id = \$1::uuid/);
  assert.match(sqlText, /person_handle > \$5::text/);
  assert.match(sqlText, /public\.digest\(\$1::text \|\| ':' \|\| person\.id::text/);
  assert.doesNotMatch(sqlText, /OFFSET/i);

  const cursor = JSON.parse(Buffer.from(detail.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(cursor).sort(), ["firstName", "handle", "lastName"]);
  assert.match(cursor.handle, /^[0-9a-f]{64}$/);
  assert.equal("id" in cursor, false);
});

test("campaign portfolio and detail routes use opaque handle navigation", async () => {
  const portfolio = await readFile(new URL("../src/app/campaigns/page.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../src/app/campaigns/[campaignHandle]/page.tsx", import.meta.url), "utf8");
  assert.match(portfolio, /key=\{campaign\.handle\}/);
  assert.match(portfolio, /href=\{`\/campaigns\/\$\{campaign\.handle\}`\}/);
  assert.doesNotMatch(portfolio, /campaign\.id/);
  assert.match(detail, /getCampaignDetail\(context, campaignHandle\)/);
  assert.match(detail, /getCampaignPopulationPage\(context, campaignHandle/);
  assert.match(detail, /CampaignEditForm/);
  assert.match(detail, /CampaignAssignmentForm/);
  assert.match(detail, /href=\{`\/outreach\/\$\{person\.personHandle\}`\}/);
  assert.match(detail, /permission="manageCampaigns"/);
  assert.doesNotMatch(detail, /campaignId/);
});
