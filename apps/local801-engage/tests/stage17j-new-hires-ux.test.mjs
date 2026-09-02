import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Stage 17J New Hires prioritizes the operational queue without removing filters", () => {
  const page = source("src/app/new-hires/page.tsx");

  assert.match(page, /Track employees newly identified by the latest approved roster or an authoritative New Hires file/);
  assert.match(page, /MAPE Hire Date falls after the previous snapshot/);
  assert.match(page, /className="new-hire-journey"/);
  assert.match(page, /className="new-hire-search-form"/);
  assert.match(page, /className="field new-hire-search-field"/);
  assert.match(page, /id="new-hire-contact"/);
  assert.match(page, /id="new-hire-assignment"/);
  assert.match(page, /id="new-hire-days"/);
  assert.match(page, /className="new-hire-more-filters"/);
  assert.match(page, /<summary>More filters/);
  assert.match(page, /id="new-hire-membership"/);
  assert.doesNotMatch(page, /<label htmlFor="new-hire-limit">Rows<\/label>/);
});

test("Stage 17J New Hires keeps result controls with results and uses attention-focused summary cards", () => {
  const page = source("src/app/new-hires/page.tsx");

  assert.match(page, /results\.total > 25 \? <div className="new-hire-results-toolbar">/);
  assert.match(page, /aria-label="New hires per page"/);
  assert.match(page, /<StatCard label="New hires"/);
  assert.match(page, /<StatCard label="No conversation yet"/);
  assert.match(page, /<StatCard label="Unassigned"/);
  assert.match(page, /<StatCard label="Open follow-up"/);
  assert.doesNotMatch(page, /<StatCard label="Current members"/);
});

test("Stage 17J New Hires removes progress and action presentation while retaining a dedicated mobile list", () => {
  const page = source("src/app/new-hires/page.tsx");
  const css = source("src/app/stage17.css");

  assert.match(page, /headers=\{\["Person", "Hire Date", "Work", "Contact", "Assignment"\]\}/);
  assert.doesNotMatch(page, /Job Status|person\.jobStatus/);
  assert.doesNotMatch(page, /new-hire-progress-badges|new-hire-mobile-progress|new-hire-action-cell|new-hire-member360/);
  assert.match(page, /className="person-membership-stack"/);
  assert.match(page, /className="new-hire-desktop-results"/);
  assert.match(page, /className="new-hire-mobile-results"/);
  assert.match(page, /className="new-hire-person-row"/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /\.new-hire-desktop-results \{\s*display: none;/);
  assert.match(css, /\.new-hire-mobile-results \{[\s\S]*?display: block;/);
});

test("Stage 17J New Hires keeps protected reads, outreach authorization, and assignment authorization intact", () => {
  const page = source("src/app/new-hires/page.tsx");
  const access = source("src/lib/access.ts");

  assert.match(page, /permission="assignNewHires"/);
  assert.match(page, /hydrateNewHireQueueFromProtectedPii\(context\.organizationId, legacyResults\)/);
  assert.match(page, /const canOpenEmployee = can\(user\.role, "recordEngagement"\)/);
  assert.match(page, /const canAssignNewHires = can\(user\.role, "assignNewHires"\)/);
  assert.match(page, /href=\{`\/outreach\/\$\{person\.handle\}`\}/);
  assert.doesNotMatch(page, /aria-label=\{`Open outreach record for \$\{person\.displayName\}`\}/);
  assert.match(access, /recordEngagement: \["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"\]/);
  assert.doesNotMatch(access, /recordEngagement: \[[^\]]*membership_data_manager/);
  assert.match(access, /assignNewHires: \["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"\]/);
  assert.doesNotMatch(access, /assignNewHires: \[[^\]]*cat_member/);
  assert.doesNotMatch(access, /assignNewHires: \[[^\]]*report_viewer/);
});

test("Stage 17J New Hires uses consistent protected-PII and result-count language", () => {
  const page = source("src/app/new-hires/page.tsx");

  assert.match(page, /Protected PII/);
  assert.match(page, /Showing \$\{results\.people\.length\} of \$\{results\.total\} hires/);
  assert.doesNotMatch(page, /Protected PII ·/);
  assert.doesNotMatch(page, /Showing up to/);
});
