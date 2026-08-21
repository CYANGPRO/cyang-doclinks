import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../db/migrations/0009__encrypted_engagement_notes.sql", import.meta.url), "utf8");
const notes = readFileSync(new URL("../src/lib/engagement-notes.ts", import.meta.url), "utf8");
const recorder = readFileSync(new URL("../src/components/EngagementRecorder.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/outreach/[handle]/page.tsx", import.meta.url), "utf8");
const engagementRoute = readFileSync(new URL("../src/app/api/outreach/[handle]/engagements/route.ts", import.meta.url), "utf8");
const actionRoute = readFileSync(new URL("../src/app/api/outreach/[handle]/actions/route.ts", import.meta.url), "utf8");
const followupRoute = readFileSync(new URL("../src/app/api/outreach/[handle]/followups/[followupHandle]/route.ts", import.meta.url), "utf8");
const employeeActions = readFileSync(new URL("../src/lib/employee-actions.ts", import.meta.url), "utf8");
const outreach = readFileSync(new URL("../src/lib/outreach.ts", import.meta.url), "utf8");

test("0009 stores encrypted note envelopes, not plaintext note columns", () => {
  assert.match(migration, /encrypted_payload text not null/);
  assert.match(migration, /encryption_key_version text not null/);
  assert.match(migration, /visibility in \('writer_only','assigned_scope','cat_members','cat_leads','administrators'\)/);
  assert.match(migration, /length\(encrypted_payload\) between 1 and 20000/);
  assert.doesNotMatch(migration, /note_text|plaintext|body text/i);
});

test("note reads enforce writer, assignment, CAT, lead, and administrator visibility before decryption", () => {
  assert.match(notes, /note\.visibility = 'writer_only' AND note\.created_by = \$3::uuid/);
  assert.match(notes, /note\.visibility = 'assigned_scope'[\s\S]*assignment\.status = 'open'/);
  assert.match(notes, /note\.visibility = 'cat_members'/);
  assert.match(notes, /note\.visibility = 'cat_leads'/);
  assert.match(notes, /note\.visibility = 'administrators'/);
  assert.match(notes, /note\.visibility = event\.note_visibility/);
  assert.match(notes, /Encrypted engagement note integrity check failed/);
  assert.match(notes, /Encrypted engagement note metadata check failed/);
  assert.match(notes, /decryptEnvelope/);
});

test("all Stage 7B mutation routes require exact same origin and Preview recordEngagement auth", () => {
  for (const route of [engagementRoute, actionRoute, followupRoute]) {
    assert.match(route, /VERCEL_ENV === "production"/);
    assert.match(route, /hasExactSameOrigin\(request\)/);
    assert.match(route, /requirePreviewUser\("recordEngagement"\)/);
    assert.match(route, /Cache-Control/);
  }
});

test("JSON mutation bodies are bounded", () => {
  assert.match(engagementRoute, /MAX_JSON_BYTES = 32_768/);
  assert.match(actionRoute, /MAX_JSON_BYTES = 16_384/);
  assert.match(engagementRoute, /Buffer\.byteLength/);
  assert.match(actionRoute, /Buffer\.byteLength/);
});

test("client sends only opaque employee/action/engagement/assignee handles", () => {
  assert.match(recorder, /employeeHandle/);
  assert.match(recorder, /actionHandle/);
  assert.match(recorder, /engagementHandle: lastEngagementHandle/);
  assert.match(recorder, /assigneeHandle/);
  assert.doesNotMatch(recorder, /personId|assignmentId|engagementEventId|assignedTo/);
});

test("Stage 7B UI uses controlled selects and supports follow-up and decline-all", () => {
  assert.match(recorder, /Contact method/);
  assert.match(recorder, /Outcome/);
  assert.match(recorder, /Create a follow-up/);
  assert.match(recorder, /Declines all actions/);
  assert.match(recorder, /Restricted narrative note/);
  assert.match(page, /Mark complete|FollowupCompleteButton/);
});


test("Action Readiness writes are hardened to current open assignments", () => {
  const responseStart = employeeActions.indexOf("function responseInsertStatement");
  const declineStart = employeeActions.indexOf("function declineAllInsertStatement");
  const recordStart = employeeActions.indexOf("export async function recordEmployeeActionResponse");
  assert.ok(responseStart >= 0 && declineStart > responseStart && recordStart > declineStart);
  assert.match(employeeActions.slice(responseStart, declineStart), /assignment\.status = 'open'/);
  assert.match(employeeActions.slice(declineStart, recordStart), /assignment\.status = 'open'/);
});


test("client converts device-local datetime inputs to ISO before sending to the server", () => {
  assert.match(recorder, /localDateTimeToIso/);
  assert.match(recorder, /parsed\.toISOString\(\)/);
  assert.match(recorder, /Entered times use your device time zone/);
});

test("action route never reflects arbitrary database errors", () => {
  assert.match(actionRoute, /ACTION_READINESS_UNAVAILABLE/);
  assert.doesNotMatch(actionRoute, /\/invalid\|not available/);
});


test("Stage 7B outreach integration keeps follow-up IDs opaque and delegates note reads to the visibility service", () => {
  assert.match(outreach, /listRecentEngagementHistory/);
  assert.match(outreach, /followup:\$\{context\.organizationId\}:\$\{followup\.id\}/);
  assert.match(outreach, /recentEngagements: engagements/);
  assert.doesNotMatch(outreach, /followupId:/);
});


test("JSON mutation routes require application/json and preflight declared body length", () => {
  for (const route of [engagementRoute, actionRoute]) {
    assert.match(route, /mediaType !== "application\/json"/);
    assert.match(route, /content-length/);
    assert.match(route, /Number\.isSafeInteger/);
  }
});


test("auth failures are also marked no-store on mutation routes", () => {
  for (const route of [engagementRoute, actionRoute, followupRoute]) {
    assert.match(route, /auth\.response\.headers\.set\("Cache-Control"/);
  }
});
