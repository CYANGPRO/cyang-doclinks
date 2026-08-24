import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("cursor pages always expose a safe history-backed Previous control", () => {
  const design = source("src/components/DesignSystem.tsx");
  assert.match(design, /historyBackFallbackHref/);
  assert.match(design, /<CursorBackButton fallbackHref=/);
  for (const path of [
    "src/app/campaigns/page.tsx",
    "src/app/campaigns/[campaignHandle]/page.tsx",
    "src/app/cat-actions/page.tsx",
    "src/app/cat-actions/[actionHandle]/page.tsx",
    "src/app/documents/page.tsx",
    "src/app/audit/page.tsx",
    "src/app/new-hires/page.tsx",
    "src/app/outreach/page.tsx",
    "src/app/membership/data-quality/page.tsx",
  ]) assert.match(source(path), /historyBackFallbackHref=/, path);
});

test("campaign lifecycle and disruptive actions require deliberate confirmation", () => {
  const campaigns = source("src/components/CampaignMutations.tsx");
  const followups = source("src/components/FollowupCompleteButton.tsx");
  const team = source("src/components/TeamAccessControls.tsx");
  assert.doesNotMatch(campaigns, /new-campaign-status/);
  assert.match(campaigns, /Activate this campaign\?/);
  assert.match(campaigns, /Close this campaign\?/);
  assert.match(followups, /window\.confirm/);
  assert.match(team, /disruptiveAction/);
  assert.match(team, /Deactivate \$\{displayName\}\?/);
  assert.match(team, /Sign \$\{displayName\} out everywhere\?/);
});

test("field and import detours preserve safe operational context", () => {
  const field = source("src/lib/field-mode.ts");
  const fieldPage = source("src/app/outreach/[handle]/field/page.tsx");
  const contactPage = source("src/app/outreach/[handle]/contact/page.tsx");
  const importPage = source("src/app/imports/[batchId]/page.tsx");
  assert.match(field, /fieldContactHref/);
  assert.match(fieldPage, /fieldContactHref\(workspace\.handle, fieldContext\)/);
  assert.match(contactPage, /fieldPersonHref\(handle, fieldContext\.enabled \? fieldContext : fieldContextFromOutreachReturnPath\(returnHref\)\)/);
  assert.match(importPage, /detailHref\(batchId, item\.value, search, detail\?\.pageSize \?\? 50\)/);
  assert.match(importPage, /detailHref\(batchId, category, search, detail\.pageSize, detail\.nextCursor\)/);
});

test("the complete data-quality report is discoverable and uses the shared responsive grid", () => {
  const reports = source("src/app/reports/page.tsx");
  const dataQuality = source("src/app/reports/data-quality/page.tsx");
  assert.match(reports, /"\/reports\/data-quality"/);
  assert.match(reports, /if \(view === "data-quality"\) redirect\("\/reports\/data-quality"\)/);
  assert.match(dataQuality, /className="metrics-grid"/);
  assert.doesNotMatch(dataQuality, /className="stat-grid"/);
});

test("navigation accessibility uses valid IDs and exposes mobile More state", () => {
  const navigation = source("src/components/AppNavigation.tsx");
  assert.match(navigation, /navigationGroupId/);
  assert.match(navigation, /replaceAll\(\/\[\^a-z0-9\]\+\/g, "-"\)/);
  assert.match(navigation, /const moreActive/);
  assert.match(navigation, /aria-current=\{moreActive \? "page" : undefined\}/);
});

test("member outreach preserves a validated originating queue", () => {
  const links = source("src/lib/field-mode.ts");
  const queue = source("src/app/outreach/page.tsx");
  const member = source("src/app/outreach/[handle]/page.tsx");
  const contact = source("src/app/outreach/[handle]/contact/page.tsx");
  const field = source("src/app/outreach/[handle]/field/page.tsx");

  assert.match(links, /safeReturnPath\(value\)/);
  assert.match(links, /candidate === "\/outreach" \|\| candidate\.startsWith\("\/outreach\?"\)/);
  assert.match(links, /export function member360Href/);
  assert.match(queue, /member360Href\(person\.handle, currentQueueHref\)/);
  assert.match(member, /outreachReturnPath\(parameters\.returnTo\)/);
  assert.match(member, /Back to filtered list/);
  assert.match(contact, /member360Href\(handle, returnHref\)/);
  assert.match(field, /member360Href\(workspace\.handle, returnHref\)/);
});

test("contact view shows all phone and email types and uses explicit preference helpers", () => {
  const contact = source("src/app/outreach/[handle]/contact/page.tsx");
  for (const label of ["Cell phone", "Home phone", "Work phone", "Home email", "Work email"]) {
    assert.match(contact, new RegExp(`<strong>${label}<\\/strong>`));
  }
  assert.match(contact, /preferredVisiblePhone\(contacts\)/);
  assert.match(contact, /preferredVisibleEmail\(contacts\)/);
  assert.match(contact, /telHref\(preferredPhone\)/);
  assert.match(contact, /smsHref\(preferredPhone\)/);
  assert.match(contact, /mailto:\$\{preferredEmail\}/);
});

test("workload reset remounts uncontrolled filters from the URL state", () => {
  const workload = source("src/app/workload/page.tsx");
  assert.match(workload, /key=\{`\$\{selectedSource\}:\$\{selectedWindow\}`\}/);
  assert.match(workload, /href="\/workload"/);
});

test("shared responsive layouts distinguish dashboard summaries from operational metrics", () => {
  const home = source("src/app/page.tsx");
  const reports = source("src/app/reports/page.tsx");
  const css = source("src/app/stage16.css");

  assert.match(home, /className="metrics-grid dashboard-metrics"/);
  assert.match(css, /\.dashboard-metrics \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.metrics-grid:not\(\.dashboard-metrics\) \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(reports, /className="report-view-nav"/);
  assert.match(css, /\.report-view-nav \{[\s\S]*flex-wrap: wrap;/);
  assert.doesNotMatch(reports, /overflowX/);
});

test("mobile outreach keeps record and return actions within reach", () => {
  const member = source("src/app/outreach/[handle]/page.tsx");
  const field = source("src/app/outreach/[handle]/field/page.tsx");
  const css = source("src/app/stage16.css");

  assert.match(member, /className="member360-sticky-actions member360-mobile-actions"/);
  assert.match(member, /href="#record-conversation"/);
  assert.match(field, /return to the refreshed list for the next person/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.member360-sticky-actions \{[\s\S]*position: sticky;/);
});

test("mobile queues keep current work ahead of setup except for requested upload entry points", () => {
  const campaigns = source("src/app/campaigns/page.tsx");
  const actions = source("src/app/cat-actions/page.tsx");
  const documents = source("src/app/documents/page.tsx");
  const team = source("src/app/team/page.tsx");

  assert.ok(campaigns.indexOf('title="Campaign work records"') < campaigns.indexOf('title="Create a draft campaign"'));
  assert.ok(actions.indexOf('title="CAT Action work records"') < actions.indexOf('title="Create a CAT Action"'));
  assert.ok(documents.indexOf("<DocumentUploadForm") < documents.indexOf('title="Document library"'));
  assert.ok(team.indexOf('title="Current users"') < team.indexOf('title="What each role can do"'));
  assert.match(documents, /Protected user/);
});

test("singular queue summaries use singular grammar", () => {
  const outreach = source("src/app/outreach/page.tsx");
  const quality = source("src/app/membership/data-quality/page.tsx");

  assert.match(outreach, /count === 1 \? "person" : "people"/);
  assert.match(quality, /count === 1 \? "person" : "people"/);
  assert.match(quality, /issueCount\(results\.summary, results\.issue\) === 1 \? "needs" : "need"/);
});
