import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getCampaignActionReadiness,
  getCatActionReadiness,
} from "../src/lib/action-readiness-summary.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const handle = "a".repeat(64);

const campaignContext = {
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.test",
  role: "cat_admin",
};

test("campaign Action Readiness is aggregate, organization scoped, and handle scoped", async () => {
  let recorded;
  const summary = await getCampaignActionReadiness(campaignContext, handle, async (sql, parameters) => {
    recorded = { sql, parameters };
    return [{ name: "Attend meeting", engagement_level: 2, willing_count: "4", considering_count: "3", declined_count: "1", completed_count: "2" }];
  });

  assert.deepEqual(recorded.parameters, [organizationId, handle]);
  assert.match(recorded.sql, /readiness\.organization_id = \$1::uuid/);
  assert.match(recorded.sql, /readiness\.scope_type = 'campaign'/);
  assert.match(recorded.sql, /digest\('campaign:' \|\| campaign\.organization_id/);
  assert.equal(summary.actionCount, 1);
  assert.equal(summary.willing, 4);
  assert.equal(summary.considering, 3);
  assert.equal(summary.declined, 1);
  assert.equal(summary.completed, 2);
});

test("CAT Action Readiness uses CAT-action scope and aggregates multiple readiness items", async () => {
  let recorded;
  const summary = await getCatActionReadiness(campaignContext, handle, async (sql, parameters) => {
    recorded = { sql, parameters };
    return [
      { name: "Wear sticker", engagement_level: 1, willing_count: 5, considering_count: 1, declined_count: 2, completed_count: 3 },
      { name: "Attend rally", engagement_level: 3, willing_count: 2, considering_count: 4, declined_count: 1, completed_count: 1 },
    ];
  });

  assert.deepEqual(recorded.parameters, [organizationId, handle]);
  assert.match(recorded.sql, /readiness\.scope_type = 'cat_action'/);
  assert.match(recorded.sql, /digest\('cat-action:' \|\| action\.organization_id/);
  assert.equal(summary.actionCount, 2);
  assert.equal(summary.willing, 7);
  assert.equal(summary.considering, 5);
  assert.equal(summary.declined, 3);
  assert.equal(summary.completed, 4);
});

test("scoped Action Readiness denies roles without management access", async () => {
  const reportViewer = { ...campaignContext, role: "report_viewer" };
  await assert.rejects(() => getCampaignActionReadiness(reportViewer, handle, async () => []), /not authorized/i);
  await assert.rejects(() => getCatActionReadiness(reportViewer, handle, async () => []), /not authorized/i);
});

test("campaign and CAT-action detail pages surface aggregate Action Readiness", () => {
  const campaign = readFileSync(new URL("../src/app/campaigns/[campaignHandle]/page.tsx", import.meta.url), "utf8");
  const catAction = readFileSync(new URL("../src/app/cat-actions/[actionHandle]/page.tsx", import.meta.url), "utf8");
  const component = readFileSync(new URL("../src/components/ActionReadinessSummary.tsx", import.meta.url), "utf8");

  assert.match(campaign, /getCampaignActionReadiness/);
  assert.match(campaign, /ActionReadinessSummary/);
  assert.match(catAction, /getCatActionReadiness/);
  assert.match(catAction, /ActionReadinessSummary/);
  assert.match(component, /recorded responses.not campaign completion and not a hidden member score/i);
  assert.match(component, /Current responses/);
});
