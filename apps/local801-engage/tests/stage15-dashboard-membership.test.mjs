import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMembershipSummary, unavailableMembershipSummary } from "../src/lib/membership.ts";
import { membershipGroupFromSearch } from "../src/lib/membership-group-preference.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const context = {
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.test",
  role: "local_admin",
};

test("membership summary exposes additions and drops without changing approved-snapshot scope", async () => {
  let recorded;
  const summary = await getMembershipSummary(context, async (sql, parameters) => {
    recorded = { sql, parameters };
    return [{
      snapshot_date: "2026-08-16",
      represented: "100",
      members: "74",
      nonmembers: "26",
      additions_this_month: "5",
      drops_this_month: "2",
      net_change: "3",
    }];
  });

  assert.deepEqual(recorded.parameters, [organizationId]);
  assert.match(recorded.sql, /status = 'approved'/);
  assert.match(recorded.sql, /event\.event_type = 'addition'/);
  assert.match(recorded.sql, /event\.event_type = 'drop'/);
  assert.equal(summary.additionsThisMonth, 5);
  assert.equal(summary.dropsThisMonth, 2);
  assert.equal(summary.netChange, 3);
  assert.equal(summary.source, "database");
  assert.equal(summary.sourceLabel, "Approved snapshot · 2026-08-16");
});

test("unavailable membership summary withholds lifecycle values", () => {
  const summary = unavailableMembershipSummary();
  assert.equal(summary.additionsThisMonth, "—");
  assert.equal(summary.dropsThisMonth, "—");
  assert.equal(summary.netChange, "—");
  assert.equal(summary.source, "unavailable");
});

test("membership page consolidates the snapshot and keeps authorized lifecycle drill-throughs", () => {
  const source = readFileSync(new URL("../src/app/membership/page.tsx", import.meta.url), "utf8");
  const tabs = readFileSync(new URL("../src/components/MembershipGroupTabs.tsx", import.meta.url), "utf8");
  const groupPreference = readFileSync(new URL("../src/lib/membership-group-preference.ts", import.meta.url), "utf8");
  assert.match(source, /Membership snapshot/);
  assert.match(source, /Changes this month/);
  assert.match(source, /Related membership work/);
  assert.match(source, /Membership by group/);
  assert.match(source, /MembershipGroupTabs/);
  assert.match(tabs, /group=\$\{item\.key\}/);
  assert.match(tabs, /localStorage\.getItem\(MEMBERSHIP_GROUP_STORAGE_KEY\)/);
  assert.match(tabs, /router\.replace\(`/);
  assert.match(groupPreference, /"classification"/);
  assert.match(groupPreference, /"department"/);
  assert.match(groupPreference, /"location"/);
  assert.match(source, /\/reports\?view=membership/);
  assert.match(source, /href="\/imports"/);
  assert.match(source, /href="\/new-hires"/);
  assert.match(source, /href="\/membership\/data-quality"/);
  assert.match(source, /label\.localeCompare\(b\.label/);
  assert.match(source, /visibleBreakdowns[\s\S]*label\.localeCompare\(b\.label/);
  assert.match(source, /every office in the latest approved snapshot/);
});

test("membership group defaults to classification and preserves valid selections", () => {
  assert.equal(membershipGroupFromSearch(undefined), "classification");
  assert.equal(membershipGroupFromSearch("invalid"), "classification");
  assert.equal(membershipGroupFromSearch("department"), "department");
  assert.equal(membershipGroupFromSearch(["location", "classification"]), "location");
});

test("dashboard converts urgent aggregates and current work into scope-aware drill-through queues", () => {
  const source = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Work requiring attention/);
  assert.match(source, /Current Local 801 totals/);
  assert.match(source, /const outreachScope = organizationWideOrganizing \? "authorized" : "assigned"/);
  assert.match(source, /const followupScope = organizationWideOrganizing \? "authorized" : "mine"/);
  assert.match(source, /focus=overdue/);
  assert.match(source, /focus=all/);
  assert.match(source, /href="\/imports"/);
  assert.match(source, /href="\/new-hires"/);
  assert.match(source, /member360ActionLabel/);
});
