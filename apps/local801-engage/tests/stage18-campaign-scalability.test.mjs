import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Stage 18 campaign page exposes bounded factual operations and strict keyset controls", async () => {
  const [page, campaigns, component] = await Promise.all([
    source("../src/app/campaigns/[campaignHandle]/page.tsx"),
    source("../src/lib/campaigns.ts"),
    source("../src/components/CampaignBulkOperations.tsx"),
  ]);
  assert.match(page, /Campaign operations/);
  assert.match(page, /live count preview and a second confirmation/);
  assert.match(page, /name="assignment"/);
  assert.match(page, /name="workflow"/);
  assert.match(page, /name="q"/);
  assert.match(page, /Name or exact email/);
  assert.match(page, /<option value="25">25<\/option>/);
  assert.match(page, /<option value="50">50<\/option>/);
  assert.match(page, /<option value="100">100<\/option>/);
  assert.doesNotMatch(page, /<option value="20000"/);
  assert.match(campaigns, /person_handle > \$8::text/);
  assert.match(campaigns, /LIMIT \$13::integer/);
  assert.match(campaigns, /person_search_tokens/);
  assert.match(campaigns, /contact:work-email/);
  assert.match(campaigns, /LIMIT 100/);
  assert.doesNotMatch(campaigns, /\bOFFSET\b/i);
  assert.match(component, /Preview population change/);
  assert.match(component, /Confirm this exact population change/);
  assert.match(component, /Preview bulk assignment/);
  assert.match(component, /Choose the organizer who will own this work/);
  assert.match(component, /CAT will not select or rank an organizer for you/);
});

test("Stage 18 browser mutations send only criteria, bounded exceptions, opaque handles, and confirmation tokens", async () => {
  const component = await source("../src/components/CampaignBulkOperations.tsx");
  assert.match(component, /MAXLENGTH|confirmationToken/i);
  assert.match(component, /maxLength=\{3300\}/);
  assert.match(component, /includeHandles/);
  assert.match(component, /excludeHandles/);
  assert.match(component, /assigneeHandle/);
  assert.doesNotMatch(component, /personIds|campaignId|organizationId|participantHandles/);
  assert.equal((component.match(/\.people/g) ?? []).length, 0);
});

test("Stage 18 protected campaign hydration requests only current bounded handles", async () => {
  const protectedRead = await source("../src/lib/pii-protected-campaign-read.ts");
  assert.match(protectedRead, /requestedPersonHandles/);
  assert.match(protectedRead, /requestedPopulationHandles/);
  assert.match(protectedRead, /requestedUserHandles/);
  assert.match(protectedRead, /jsonb_to_recordset/);
  assert.match(protectedRead, /JOIN requested/);
  assert.doesNotMatch(protectedRead, /FROM local801\.person_pii\s+WHERE organization_id/);
  assert.doesNotMatch(protectedRead, /FROM local801\.user_pii\s+WHERE organization_id/);
});

test("Stage 18 records a no-migration decision and explicit 20K acceptance gate", async () => {
  const architecture = await source("../docs/STAGE18_CAMPAIGN_SCALABILITY.md");
  assert.match(architecture, /No migration is justified by the baseline/);
  assert.match(architecture, /20,000-person query plans/);
  assert.match(architecture, /1440×900/);
  assert.match(architecture, /390×844/);
});
