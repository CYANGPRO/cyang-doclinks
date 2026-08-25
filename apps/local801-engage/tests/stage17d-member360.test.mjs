import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMember360ConnectedContext } from "../src/lib/member360.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const handle = "a".repeat(64);

const context = {
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: "organizer@example.test",
  role: "cat_lead",
};

test("Member 360 connected context is scoped by opaque handle and active organizer assignment", async () => {
  const queries = [];
  const result = await getMember360ConnectedContext(context, handle, async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (sql.includes("member360:person-scope")) return [{ person_id: personId }];
    if (sql.includes("member360:campaign-history")) return [{
      campaign_handle: "b".repeat(64), name: "Synthetic Campaign", status: "active", assignment_status: "open", assignment_due_at: "2026-08-20T15:00:00Z",
    }];
    if (sql.includes("member360:scoped-readiness")) return [{
      scope: "cat_action", parent_handle: "c".repeat(64), parent_name: "Synthetic Action", parent_status: "active", action_label: "Attend", response_status: "willing", recorded_at: "2026-08-16T15:00:00Z",
    }];
    return [];
  });

  assert.deepEqual(queries[0].parameters, [organizationId, userId, handle, false]);
  assert.match(queries[0].sql, /assignment\.status = 'open'/);
  assert.match(queries[0].sql, /assignment\.primary_user_id = \$2::uuid OR assignment\.backup_user_id = \$2::uuid/);
  assert.equal(result.campaigns[0].name, "Synthetic Campaign");
  assert.equal(result.scopedReadiness[0].parentName, "Synthetic Action");
  assert.equal(result.scopedReadiness[0].response, "willing");
});

test("connected Member 360 query reads relationship metadata, not direct person/contact PII", () => {
  const source = readFileSync(new URL("../src/lib/member360.ts", import.meta.url), "utf8");
  assert.match(source, /outreach_campaign_population/);
  assert.match(source, /employee_action_current_responses/);
  assert.match(source, /'campaign:' \|\|/);
  assert.match(source, /'cat-action:' \|\|/);
  assert.doesNotMatch(source, /person\.first_name/);
  assert.doesNotMatch(source, /person\.last_name/);
  assert.doesNotMatch(source, /contact_value/);
  assert.doesNotMatch(source, /work_email/);
});

test("outreach record derives completeness only after protected hydration and keeps connected context read-only", () => {
  const source = readFileSync(new URL("../src/app/outreach/[handle]/page.tsx", import.meta.url), "utf8");
  const hydrationIndex = source.indexOf("hydrateOutreachWorkspaceFromProtectedPii");
  const completenessIndex = source.indexOf("const missingCoreFields");
  assert.ok(hydrationIndex >= 0 && completenessIndex > hydrationIndex);
  assert.match(source, /title="Current outreach work"/);
  assert.match(source, /These are not performance scores/);
  assert.match(source, /title="What we have on file"/);
  assert.match(source, /title="Campaigns"/);
  assert.match(source, /title="Campaign & action readiness"/);
  assert.match(source, /does not reuse them as a commitment to different work/);
  assert.match(source, /approved roster or import correction process/);
});
