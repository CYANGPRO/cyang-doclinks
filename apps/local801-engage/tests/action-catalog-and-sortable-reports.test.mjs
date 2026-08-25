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

test("dense report tables progressively reveal complete sortable results", async () => {
  const design = await read("../src/components/DesignSystem.tsx");
  const table = await read("../src/components/SortableDataTable.tsx");
  const reports = await read("../src/app/reports/page.tsx");
  assert.match(design, /initialRows/);
  assert.match(table, /Showing \{displayedRows\.length\} of \{sortedRows\.length\}/);
  assert.match(table, /Show all \$\{sortedRows\.length\}/);
  assert.match(table, /aria-live="polite"/);
  assert.match(reports, /initialRows=\{initialRows\}/);
  assert.match(reports, /Reveal the complete list when needed/);
});

test("dense operational queues default to compact, bounded views", async () => {
  const density = await read("../src/components/QueueDensity.tsx");
  const outreach = await read("../src/app/outreach/page.tsx");
  const audit = await read("../src/lib/audit.ts");
  const auditPage = await read("../src/app/audit/page.tsx");
  assert.match(density, /useState<Density>\("compact"\)/);
  assert.match(density, /aria-pressed/);
  assert.match(outreach, /Available contact/);
  assert.match(outreach, /filter\(\(contact\) => contact\.href\)/);
  assert.match(audit, /\? requested : 25/);
  assert.match(auditPage, /pageSize \?\? 25/);
});

test("applied queue filters collapse into a visible current-view summary", async () => {
  const design = await read("../src/components/DesignSystem.tsx");
  const pages = await Promise.all([
    read("../src/app/directory/page.tsx"),
    read("../src/app/outreach/page.tsx"),
    read("../src/app/new-hires/page.tsx"),
    read("../src/app/membership/data-quality/page.tsx"),
    read("../src/app/audit/page.tsx"),
  ]);
  assert.match(design, /function AppliedFilterSummary/);
  assert.match(design, /aria-label="Applied filters"/);
  for (const page of pages) {
    assert.match(page, /AppliedFilterSummary/);
    assert.match(page, /defaultOpen=/);
    assert.match(page, /clearHref=/);
  }
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
