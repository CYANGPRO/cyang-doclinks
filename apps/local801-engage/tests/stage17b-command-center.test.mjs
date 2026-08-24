import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getDashboardMetrics } from "../src/lib/metrics.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function row() {
  return {
    organization_exists: true,
    represented: "100",
    members: "75",
    open_assignments: "12",
    assigned_attention_90: "4",
    new_hires_this_month: "6",
    new_hires_awaiting_first_engagement_14: "2",
    additions_this_month: "5",
    drops_this_month: "1",
    recent_membership_changes_7_days: "3",
    overdue_followups: "2",
    followups_due_today: "1",
    upcoming_followups: "7",
    imports_in_review: "1",
    active_campaigns: "2",
    open_cat_actions: "3",
  };
}

function context(role) {
  return {
    organizationId,
    organizationSlug: "local801-preview",
    userId,
    email: "synthetic@example.test",
    role,
  };
}

test("dashboard command-center metrics use explicit operational facts and Chicago due-date boundaries", async () => {
  let recorded;
  const metrics = await getDashboardMetrics(context("cat_lead"), async (sql, parameters) => {
    recorded = { sql, parameters };
    return [row()];
  });

  assert.deepEqual(recorded.parameters, [organizationId, userId, true]);
  assert.match(recorded.sql, /America\/Chicago/);
  assert.match(recorded.sql, /count\(DISTINCT a\.person_id\)/i);
  assert.match(recorded.sql, /e\.occurred_at >= now\(\) - interval '90 days'/);
  assert.match(recorded.sql, /h\.hire_date <= current_date - interval '14 days'/);
  assert.match(recorded.sql, /h\.engagement_count = 0/);
  assert.match(recorded.sql, /e\.effective_date >= current_date - interval '7 days'/);
  assert.match(recorded.sql, /a\.person_id = f\.person_id/);
  assert.match(recorded.sql, /a\.status = 'open'/);

  assert.equal(metrics.assignedAttention90, 4);
  assert.equal(metrics.newHiresAwaitingFirstEngagement14, 2);
  assert.equal(metrics.followupsDueToday, 1);
  assert.equal(metrics.upcomingFollowups, 7);
  assert.equal(metrics.recentMembershipChanges7Days, 3);
});

test("organization-wide dashboard roles request organization-wide organizing aggregates", async () => {
  let parameters;
  await getDashboardMetrics(context("local_admin"), async (_sql, values) => {
    parameters = values;
    return [row()];
  });
  assert.deepEqual(parameters, [organizationId, userId, true]);
});

test("dashboard drill-through uses the same role-dependent scope as its aggregate counts", () => {
  const source = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");

  assert.match(source, /organizationWideOrganizing/);
  assert.match(source, /const outreachScope = organizationWideOrganizing \? "authorized" : "assigned"/);
  assert.match(source, /const followupScope = organizationWideOrganizing \? "authorized" : "mine"/);
  assert.match(source, /focus=overdue/);
  assert.match(source, /focus=today/);
  assert.match(source, /focus=all/);
  assert.match(source, /focus=attention/);
  assert.match(source, /Current Local 801 totals/);
  assert.match(source, /Work requiring attention/);
  assert.match(source, /Open member outreach/);
  assert.match(source, /Follow-ups due/);
});

test("Stage 17B remains migration-free and explicitly excludes hidden scoring", () => {
  const roadmap = readFileSync(new URL("../docs/STAGE17_ADVANCED_WORKFLOWS.md", import.meta.url), "utf8");
  assert.match(roadmap, /### 17B — Command center and drill-through — (?:implementation wave|complete)/);
  assert.match(roadmap, /Schema changes: \*\*none\*\*/);
  assert.match(roadmap, /will not add hidden or opaque scores/i);
  assert.match(roadmap, /No silent sensitive inference is permitted/i);
  assert.match(roadmap, /since your last visit[^\n]*tracking was added/i);
});
