import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Preview role entry is visually isolated from the authorized application shell", () => {
  const frame = source("src/components/RouteAwareFrame.tsx");
  const css = source("src/app/stage17-redesign.css");
  assert.match(frame, /const isolated = pathname === "\/sign-in"/);
  assert.match(frame, /app-frame\$\{isolated \? " isolated-route" : ""\}/);
  assert.match(css, /\.isolated-route > \.sidebar,[\s\S]*\.isolated-route > \.mobile-nav,[\s\S]*\.isolated-route \.topbar \{ display: none; \}/);
});

test("mobile More is a modal destination sheet with keyboard and scroll management", () => {
  const navigation = source("src/components/AppNavigation.tsx");
  assert.match(navigation, /aria-modal="true"[\s\S]*role="dialog"/);
  assert.match(navigation, /document\.body\.style\.overflow = "hidden"/);
  assert.match(navigation, /event\.key === "Escape"/);
  assert.match(navigation, /event\.key !== "Tab"/);
  assert.match(navigation, /triggerRef\.current\?\.focus\(\)/);
  assert.match(navigation, /aria-label="Close navigation"/);
});

test("shared tables become labeled records instead of sideways mobile tables", () => {
  const design = source("src/components/DesignSystem.tsx");
  const sortable = source("src/components/SortableDataTable.tsx");
  const globals = source("src/app/globals.css");
  const stage16 = source("src/app/stage16.css");
  const css = source("src/app/stage17-redesign.css");
  assert.match(design, /SortableDataTable/);
  assert.match(sortable, /cloneElement\(cell, \{ "data-label": headers\[index\] \?\? "" \}\)/);
  assert.match(sortable, /className="responsive-table"/);
  assert.match(css, /\.responsive-table thead \{ display: none; \}/);
  assert.match(css, /\.responsive-table td::before \{[\s\S]*content: attr\(data-label\)/);
  assert.match(globals, /\.table-scroll \{[^}]*overflow-x: visible/);
  assert.doesNotMatch(`${globals}\n${stage16}`, /\.data-table \{[^}]*min-width: (?:640|720)px/);
  assert.doesNotMatch(sortable, /Swipe horizontally/);
});

test("dense operational tables keep no more than six decision-focused columns", () => {
  const directory = source("src/app/directory/page.tsx");
  const newHires = source("src/app/new-hires/page.tsx");
  const campaigns = source("src/app/campaigns/page.tsx");
  const catActions = source("src/app/cat-actions/page.tsx");
  const documents = source("src/app/documents/page.tsx");

  assert.match(directory, /\["Person", "Hire Date", "Work", "Contact", "Action"\]/);
  assert.match(newHires, /\["Person", "Hire Date", "Work", "Contact", "Assignment"\]/);
  assert.match(campaigns, /\["Campaign", "Status", "Dates", "Population", "Contacted", "Completed"\]/);
  assert.match(catActions, /\["Action", "Cycle", "Workload", "Completed", "Next due"\]/);
  assert.match(documents, /\["Document", "File", "Access", "Created", "Action"\]/);
});

test("Home leads with prioritized work and a compact role-aware snapshot", () => {
  const home = source("src/app/page.tsx");
  assert.match(home, /title="Work requiring attention"/);
  assert.match(home, /title="Current Local 801 totals"/);
  assert.match(home, /attentionItems\.sort/);
  assert.doesNotMatch(home, /title="Preview"/);
  assert.ok(home.indexOf('className="priority-panel"') < home.indexOf('className="snapshot-panel"'));
});

test("uploads lead their workspaces while program setup remains secondary", () => {
  const imports = source("src/app/imports/page.tsx");
  const campaigns = source("src/app/campaigns/page.tsx");
  const documents = source("src/app/documents/page.tsx");
  assert.ok(imports.indexOf('title="Start a new import"') < imports.indexOf('title="Import history"'));
  assert.ok(campaigns.indexOf('title="Campaign work records"') < campaigns.indexOf('title="Create a draft campaign"'));
  assert.ok(documents.indexOf('title="Upload a document"') < documents.indexOf('title="Document library"'));
  assert.match(imports, /<DisclosureCard[\s\S]*title="Start a new import"/);
  assert.match(campaigns, /<DisclosureCard[\s\S]*title="Create a draft campaign"/);
  assert.match(documents, /<DisclosureCard[\s\S]*title="Upload a document"/);
});

test("buttons have raised surfaces and size to their labels", () => {
  const css = source("src/app/stage17-redesign.css");
  assert.match(css, /\.button \{[\s\S]*box-shadow: 0 2px 5px[\s\S]*width: fit-content;/);
  assert.match(css, /\.button\.secondary \{[\s\S]*background: #fff;[\s\S]*box-shadow:/);
  assert.match(css, /\.button\.tertiary \{[\s\S]*border-color: var\(--border\);[\s\S]*box-shadow:/);
  assert.match(css, /\.page-actions \.button,[\s\S]*\.inline-actions \.button \{ width: fit-content; \}/);
  assert.match(css, /\.report-view-nav \.button \{[\s\S]*background: #fff;[\s\S]*border-color: #c0ced7;[\s\S]*box-shadow:/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*\.button \{ min-height: 44px; \}/);
});

test("long disclosure badges wrap inside the mobile viewport", () => {
  const css = source("src/app/stage17-redesign.css");
  assert.match(css, /\.expandable-meta \{ flex: 0 1 55%; justify-content: flex-end; max-width: 55%; \}/);
  assert.match(css, /\.expandable-meta \.status-badge \{[\s\S]*overflow-wrap: anywhere;[\s\S]*white-space: normal;/);
  assert.match(css, /\.expandable-chevron \{ flex: 0 0 30px; \}/);
});
