import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("migration 0029 installs the escalating organization action catalog without replacing history", async () => {
  const sql = await read("../db/migrations/0033__default_action_readiness_catalog.sql");
  const expected = [
    "Follow Up Call",
    "Complete a Survey",
    "Attend a Meeting",
    "Talk to a Coworker about MAPE''s Contract",
    "Sign a Petition",
    "Volunteer to Become a CAT",
    "Meet with Legislators",
    "Participate in Workforce Action",
  ];
  for (const label of expected) assert.match(sql, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sql, /where not exists/i);
  assert.doesNotMatch(sql, /delete from|truncate|update local801\.employee_actions/i);
});

test("catalog page exposes all four current response states and custom action management", async () => {
  const page = await read("../src/app/action-readiness/page.tsx");
  const manager = await read("../src/components/ActionCatalogManager.tsx");
  const route = await read("../src/app/api/action-readiness/catalog/route.ts");
  for (const state of ["Willing", "Considering", "Declined", "Completed"]) assert.match(page, new RegExp(state));
  assert.match(manager, /Escalation level/);
  assert.match(route, /requirePreviewUser\("manageActionCatalog"\)/);
  assert.match(route, /hasExactSameOrigin/);
  assert.match(route, /enforceWorkspaceRateLimit/);
  assert.match(route, /request\.headers\.get\("content-length"\)/);
  assert.match(route, /auth\.response\.headers\.set\("Cache-Control"/);
});

test("all DataTable consumers receive accessible client-side column sorting", async () => {
  const design = await read("../src/components/DesignSystem.tsx");
  const table = await read("../src/components/SortableDataTable.tsx");
  assert.match(design, /SortableDataTable/);
  assert.match(table, /aria-sort/);
  assert.match(table, /changeSort/);
  assert.match(table, /localeCompare/);
});

test("membership classification and report group results link to authorized person drilldowns", async () => {
  const membership = await read("../src/app/membership/page.tsx");
  const reports = await read("../src/app/reports/page.tsx");
  assert.match(membership, /classification/);
  assert.match(membership, /\/directory\?/);
  assert.match(reports, /Membership by classification/);
  assert.match(reports, /directoryDrilldown/);
  assert.match(reports, /membershipStatusDrilldown/);
  assert.match(reports, /can\(user\.role, "viewDirectory"\)/);
});

test("named report groups default to alphabetical order while time series retain chronological ordering", async () => {
  const reports = await read("../src/lib/reports.ts");
  const campaigns = await read("../src/lib/campaign-reports.ts");
  const catActions = await read("../src/lib/cat-action-reports.ts");
  const membership = await read("../src/app/membership/page.tsx");
  assert.doesNotMatch(reports, /ORDER BY (?:represented_count|new_hires|event_count|followup_count|ec\.assigned_count) DESC/);
  assert.match(reports, /ORDER BY label ASC/);
  assert.match(reports, /ORDER BY month DESC/);
  assert.match(campaigns, /ORDER BY summary\.name ASC/);
  assert.match(catActions, /ORDER BY summary\.name ASC/);
  assert.match(membership, /label\.localeCompare\(b\.label/);
  assert.match(membership, /Results appear alphabetically by group name/);
});
