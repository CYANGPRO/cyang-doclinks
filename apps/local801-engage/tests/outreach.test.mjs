import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(new URL("../src/lib/outreach.ts", import.meta.url), "utf8");
const queuePage = readFileSync(new URL("../src/app/outreach/page.tsx", import.meta.url), "utf8");
const workspacePage = readFileSync(new URL("../src/app/outreach/[handle]/page.tsx", import.meta.url), "utf8");
const engagementRecorder = readFileSync(new URL("../src/components/EngagementRecorder.tsx", import.meta.url), "utf8");
const employeeActions = readFileSync(new URL("../src/lib/employee-actions.ts", import.meta.url), "utf8");

test("outreach queue requires recordEngagement before database access", () => {
  assert.match(service, /if \(!can\(context\.role, "recordEngagement"\)\) throw new OutreachAccessError/);
  assert.match(queuePage, /if \(!can\(user\.role, "recordEngagement"\)\) redirect\("\/unauthorized"\)/);
});

test("CAT outreach scope is based on current open assignments", () => {
  assert.match(service, /scope_assignment\.archived_at IS NULL[\s\S]*scope_assignment\.status = 'open'[\s\S]*primary_user_id = \$2::uuid OR scope_assignment\.backup_user_id = \$2::uuid/);
  assert.match(service, /organizationWideRoles = new Set<Role>\(\["system_owner", "local_admin", "cat_admin"\]\)/);
});

test("employee action person scope is hardened to open assignments", () => {
  assert.match(employeeActions, /assignment\.archived_at IS NULL\s+AND assignment\.status = 'open'\s+AND \(assignment\.primary_user_id = \$4::uuid OR assignment\.backup_user_id = \$4::uuid\)/);
});

test("browser-facing employee identifiers are opaque SHA-256 handles", () => {
  assert.match(service, /encode\(public\.digest\(\$1::text \|\| ':' \|\| person_id::text, 'sha256'\), 'hex'\) AS person_handle/);
  assert.match(service, /const HANDLE_RE = \/\^\[0-9a-f\]\{64\}\$\/i/);
  assert.match(queuePage, /href=\{`\/outreach\/\$\{person\.handle\}`\}/);
});

test("outreach queue uses deterministic priority and keyset ordering", () => {
  assert.match(service, /WHEN overdue_followup_count > 0 THEN 1/);
  assert.match(service, /WHEN latest_engagement_at IS NULL THEN 3/);
  assert.match(service, /latest_engagement_at < now\(\) - interval '90 days' THEN 4/);
  assert.match(service, /\(priority_rank, sort_due, sort_engagement, last_name, first_name, person_handle\)[\s\S]*> \(\$7::integer, \$8::double precision, \$9::double precision, \$10::text, \$11::text, \$12::text\)/);
});

test("outreach queue bind positions are contiguous for live PostgreSQL parsing", () => {
  const start = service.indexOf("/* outreach:priority-queue */");
  const end = service.indexOf("export async function getOutreachWorkspace", start);
  const sql = service.slice(start, end);
  assert.match(sql, /\$3::boolean/);
  assert.match(sql, /\$4::text IS NULL/);
  assert.match(sql, /LIMIT \$6::integer/);
  assert.match(sql, /\$12::text/);
  assert.doesNotMatch(sql, /\$13::text/);
  assert.match(sql, /context\.organizationId,\s*context\.userId,\s*organizationWide,\s*like\(normalized\.term\),\s*normalized\.focus/);
  assert.doesNotMatch(sql, /context\.role,/);
});

test("Minnesota day boundaries drive due-today priority", () => {
  assert.match(service, /America\/Chicago/);
});

test("work email respects directory visibility and assignment scope", () => {
  assert.match(service, /method\.visibility = 'authorized_directory'/);
  assert.match(service, /method\.visibility = 'assigned_only'[\s\S]*contact_assignment\.status = 'open'/);
});

test("employee workspace reuses Action Readiness and delegates restricted narrative note reads", () => {
  assert.match(service, /getEmployeeActionProfile\(context, row\.person_id, query\)/);
  assert.match(service, /listRecentEngagementHistory\(context, row\.person_id, query\)/);
  assert.match(workspacePage, /Narrative notes display only when the signed-in role and assignment scope allow them/);
  assert.doesNotMatch(workspacePage, /note_hash|noteHash/i);
});

test("Stage 7B workspace is operational through protected client controls", () => {
  assert.match(workspacePage, /EngagementRecorder/);
  assert.match(workspacePage, /FollowupCompleteButton/);
  assert.match(engagementRecorder, /Record conversation/);
  assert.match(engagementRecorder, /Create a follow-up/);
  assert.match(engagementRecorder, /Declines all actions/);
});

test("outreach queue exposes the approved operational focus controls", () => {
  assert.match(queuePage, /Needs attention/);
  assert.match(queuePage, /Never engaged/);
  assert.match(queuePage, /90\+ days stale/);
  assert.match(queuePage, /My current assignments/);
  assert.match(queuePage, /All authorized employees/);
});
