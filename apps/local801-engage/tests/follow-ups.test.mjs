import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(new URL("../src/lib/follow-ups.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/follow-ups/page.tsx", import.meta.url), "utf8");

test("follow-up queue requires recordEngagement permission", () => {
  assert.match(service, /if \(!can\(context\.role, "recordEngagement"\)\) throw new FollowupAccessError/);
  assert.match(page, /if \(!can\(user\.role, "recordEngagement"\)\) redirect\("\/unauthorized"\)/);
});

test("CAT roles cannot broaden follow-up scope", () => {
  assert.match(service, /organizationWideRoles = new Set<Role>\(\["system_owner", "local_admin", "cat_admin", "cat_lead"\]\)/);
  assert.match(service, /return organizationWideRoles\.has\(role\) \? requested : "mine"/);
  assert.match(page, /Your CAT role only shows follow-ups assigned to you for people in your current assignment scope/);
});

test("CAT follow-up scope requires current open employee assignments", () => {
  assert.match(service, /followup\.assigned_to = \$2::uuid[\s\S]*assignment\.archived_at IS NULL[\s\S]*assignment\.status = 'open'[\s\S]*primary_user_id = \$2::uuid OR assignment\.backup_user_id = \$2::uuid/);
});

test("administrators can select all authorized follow-ups", () => {
  assert.match(page, /<option value="authorized">Team follow-ups<\/option>/);
  assert.match(service, /const organizationWide = effectiveScope === "authorized"/);
});

test("employee and follow-up database UUIDs are converted to opaque handles", () => {
  assert.match(service, /public\.digest\(\$1::text \|\| ':' \|\| followup\.person_id::text, 'sha256'\)/);
  assert.match(service, /public\.digest\('followup:' \|\| \$1::text \|\| ':' \|\| followup\.id::text, 'sha256'\)/);
  assert.doesNotMatch(page, /person_id|followup_id|assignment_id|engagement_event_id/);
});

test("follow-ups use Minnesota day boundaries and mutually exclusive open buckets", () => {
  assert.match(service, /America\/Chicago/);
  assert.match(service, /followup\.due_at < now\(\) THEN 1/);
  assert.match(service, /status = 'open'[\s\S]*due_at >= now\(\)[\s\S]*America\/Chicago/);
});

test("completed focus is limited to the last 14 days", () => {
  assert.match(service, /completed_at >= now\(\) - interval '14 days'/);
  assert.match(page, /Completed in last 14 days/);
});

test("queue includes campaign and latest engagement context", () => {
  assert.match(service, /campaign\.name AS campaign_name/);
  assert.match(service, /latest\.occurred_at AS latest_engagement_at/);
  assert.match(service, /latest\.outcome AS latest_outcome/);
});

test("queue includes aggregate Action Readiness context", () => {
  assert.match(service, /reporting\.employee_action_person_readiness/);
  assert.match(page, /Action readiness/);
  assert.match(page, /Declines all actions/);
});

test("Stage 8A reuses the existing completion component", () => {
  assert.match(page, /FollowupCompleteButton/);
  assert.match(page, /item\.status === "open" \? <FollowupCompleteButton/);
  assert.doesNotMatch(page, /fetch\(|\/api\/follow-ups/);
});

test("completed follow-ups are read-only", () => {
  assert.match(page, /Completed work remains available for 14 days/);
  assert.match(page, /item\.status === "open"/);
});

test("queue supports deterministic keyset pagination", () => {
  assert.match(service, /\(priority_rank, sort_time, last_name, first_name, followup_handle\)[\s\S]*> \(\$8::integer, \$9::double precision, \$10::text, \$11::text, \$12::text\)/);
  assert.match(service, /ORDER BY priority_rank ASC, sort_time ASC, last_name ASC, first_name ASC, followup_handle ASC/);
  assert.match(page, /nextHref=\{results\.nextCursor \? href\(results, results\.nextCursor\) : null\}/);
});

test("search stays server-side and covers operational follow-up context", () => {
  assert.match(service, /person\.first_name ILIKE \$5/);
  assert.match(service, /person\.department ILIKE \$5/);
  assert.match(service, /campaign\.name ILIKE \$5/);
  assert.match(service, /assignee\.display_name ILIKE \$5/);
});

test("public queue model does not return raw database identifiers", () => {
  const publicType = service.slice(service.indexOf("export type FollowupQueueItem"), service.indexOf("export type FollowupQueuePage"));
  assert.doesNotMatch(publicType, /\bid\b|personId|followupId|assignmentId|engagementEventId/);
  assert.match(publicType, /employeeHandle: string/);
  assert.match(publicType, /followupHandle: string/);
});
