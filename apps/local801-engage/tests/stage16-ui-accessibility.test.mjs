import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("application shell exposes a keyboard skip link and explicit focusable main target", () => {
  const shell = source("src/components/AppShell.tsx");
  const frame = source("src/components/RouteAwareFrame.tsx");
  assert.match(frame, /className="skip-link" href="#main-content"/);
  assert.match(frame, /<main className="main-shell" id="main-content" tabIndex=\{-1\}>/);
  assert.match(shell, /Preview environment/);
  assert.match(shell, /<AccountSessionMenu authentication=\{user\.authentication\} roleLabel=\{shell\.roleLabel\} \/>/);
});

test("Stage 16 layers visual refinements after the established global design system", () => {
  const layout = source("src/app/layout.tsx");
  assert.match(layout, /import "\.\/globals\.css";[\s\S]*import "\.\/stage16\.css";[\s\S]*import "\.\/stage16-components\.css";/);
});

test("Stage 16 targets accessible control size, flexible reflow, high contrast, and reduced motion", () => {
  const css = source("src/app/stage16.css");
  const detailCss = source("src/app/stage16-components.css");
  assert.match(css, /\.button \{[\s\S]*min-height: 44px/);
  assert.match(css, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height: 48px/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(detailCss, /nav\[aria-label="Report views"\] \.button \{[\s\S]*min-height: 44px !important/);
  assert.match(detailCss, /\.compact-button \{[\s\S]*min-height: 44px/);
});

test("shared tables retain accessible captions, scoped headers, and labeled overflow regions", () => {
  const sortableTable = source("src/components/SortableDataTable.tsx");
  assert.match(sortableTable, /className="table-scroll" tabIndex=\{0\} role="region" aria-label=\{caption\}/);
  assert.match(sortableTable, /<caption className="sr-only">\{caption\}<\/caption>/);
  assert.match(sortableTable, /scope="col"/);
  assert.match(sortableTable, /aria-sort=\{sort\?\.column === index \? sort\.direction : "none"\}/);
  assert.match(sortableTable, /<button className="table-sort-button" type="button"/);
});

test("high-interaction forms use shared responsive layout and non-inline feedback styling", () => {
  const files = [
    source("src/components/EngagementRecorder.tsx"),
    source("src/components/DocumentUploadForm.tsx"),
    source("src/components/FollowupEditForm.tsx"),
    source("src/components/TeamAccessControls.tsx"),
    source("src/components/CampaignMutations.tsx"),
    source("src/components/CatActionMutations.tsx"),
    source("src/components/CampaignPopulationMutations.tsx"),
    source("src/components/ImportPreviewForm.tsx"),
    source("src/components/ImportReviewDecisions.tsx"),
    source("src/components/ImportExecutionPreflightControls.tsx"),
    source("src/components/ImportExecutionControl.tsx"),
  ];

  assert.match(files[0], /className="choice-field"/);
  assert.match(files[1], /className="form-grid"/);
  assert.match(files[2], /className="section-card disclosure-card"/);
  assert.match(files[3], /className="form-grid"/);
  assert.match(files[4], /className="form-grid"/);
  assert.match(files[5], /className="inline-disclosure"/);
  assert.match(files[6], /className="inline-actions"/);
  assert.match(files[7], /className="form-grid"/);
  assert.match(files[8], /role="alert"/);
  assert.match(files[9], /className="form-actions/);
  assert.match(files[10], /aria-describedby="execution-confirmation-help"/);

  for (const file of files) assert.doesNotMatch(file, /style=\{\{/);
});

test("destructive and inline operational actions do not regress to undersized targets", () => {
  const deleteControl = source("src/components/DocumentDeleteButton.tsx");
  const followupControl = source("src/components/FollowupCompleteButton.tsx");
  const populationControl = source("src/components/CampaignPopulationMutations.tsx");

  assert.match(deleteControl, /button danger compact-button/);
  assert.doesNotMatch(deleteControl, /minHeight:\s*32/);
  assert.match(followupControl, /className="button secondary"/);
  assert.match(populationControl, /className="inline-actions/);
});

test("dense filter panels retain clear separation from their result summaries", () => {
  const css = source("src/app/stage18.css");
  assert.match(css, /\.task-filter-panel \+ \.metrics-grid,[\s\S]*margin-top: 24px/);
  assert.match(css, /\.import-data-issues-section \+ \.data-quality-summary,[\s\S]*margin-top: 24px/);
  assert.match(css, /\.data-quality-summary \+ \.data-quality-filter-card,[\s\S]*margin-top: 24px/);
  assert.match(css, /\.data-quality-filter-card \+ \.data-quality-review-queue[\s\S]*margin-top: 24px/);
});

test("dashboard, membership, member detail, documents, and sign-in use Stage 16 layout utilities", () => {
  const dashboard = source("src/app/page.tsx");
  const membership = source("src/app/membership/page.tsx");
  const employee = source("src/app/outreach/[handle]/page.tsx");
  const documents = source("src/app/documents/page.tsx");
  const signIn = source("src/app/sign-in/page.tsx");
  const previewRoleForm = source("src/components/PreviewRoleForm.tsx");
  const catAction = source("src/app/cat-actions/[actionHandle]/page.tsx");

  assert.match(dashboard, /className="priority-row"/);
  assert.match(dashboard, /className="metrics-grid dashboard-metrics"/);
  assert.match(membership, /className="metrics-grid"/);
  assert.match(membership, /title="Related membership work"/);
  assert.match(membership, /title="Membership by group"/);
  assert.match(employee, /className="full-span"/);
  assert.doesNotMatch(employee, /style=\{\{/);
  assert.match(documents, /className="inline-actions"/);
  assert.doesNotMatch(documents, /style=\{\{/);
  assert.match(signIn, /className="content sign-in-content"/);
  assert.match(previewRoleForm, /className="stack sign-in-form"/);
  assert.doesNotMatch(signIn, /<main\b/);
  assert.doesNotMatch(signIn, /style=\{\{/);
  assert.match(catAction, /className="section-separator"/);
  assert.doesNotMatch(catAction, /style=\{\{/);
});
