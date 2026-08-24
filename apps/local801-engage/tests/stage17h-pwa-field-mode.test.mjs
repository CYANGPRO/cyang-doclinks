import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fieldContactHref, fieldPersonHref, fieldQueueHref, normalizeFieldModeContext } from "../src/lib/field-mode.ts";

test("field mode keeps only safe queue context and ignores search/cursor/person state", () => {
  assert.deepEqual(normalizeFieldModeContext({
    field: "1",
    scope: "authorized",
    focus: "attention",
    limit: "50",
    q: "Protected Person",
    cursor: "opaque-cursor",
    personHandle: "a".repeat(64),
  }), {
    enabled: true,
    scope: "authorized",
    focus: "attention",
    limit: 50,
  });

  assert.deepEqual(normalizeFieldModeContext({ field: "yes", scope: "other", focus: "other", limit: "100" }), {
    enabled: false,
    scope: "assigned",
    focus: "all",
    limit: 25,
  });
});

test("field mode URLs contain only opaque handle and bounded queue settings", () => {
  const context = { scope: "assigned", focus: "stale", limit: 25 };
  assert.equal(fieldQueueHref(context), "/outreach?field=1&scope=assigned&focus=stale&limit=25");
  const person = fieldPersonHref("a".repeat(64), context);
  assert.equal(person, `/outreach/${"a".repeat(64)}/field?field=1&scope=assigned&focus=stale&limit=25`);
  assert.equal(fieldContactHref("a".repeat(64), context), `/outreach/${"a".repeat(64)}/contact?field=1&scope=assigned&focus=stale&limit=25`);
  assert.doesNotMatch(person, /name=|email=|q=|cursor=/i);
});

test("field outreach queue deliberately drops free-text search and opens lightweight field workspace", () => {
  const page = readFileSync(new URL("../src/app/outreach/page.tsx", import.meta.url), "utf8");
  assert.match(page, /term: fieldMode \? undefined : parameters\.q/);
  assert.match(page, /Search is turned off in field view/i);
  assert.match(page, /fieldPersonHref\(person\.handle, canonicalFieldContext\)/);
  assert.match(page, /Start field view/);
  assert.match(page, /FieldConnectionStatus/);
  assert.match(page, /Member details, notes, and form responses are never saved for offline use/i);
});

test("field employee route reuses existing protected reads and EngagementRecorder rather than new mutations", () => {
  const page = readFileSync(new URL("../src/app/outreach/[handle]/field/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getOutreachWorkspace/);
  assert.match(page, /getEngagementFormOptions/);
  assert.match(page, /hydrateOutreachWorkspaceFromProtectedPii/);
  assert.match(page, /hydrateEngagementFormOptionsFromProtectedPii/);
  assert.match(page, /<EngagementRecorder/);
  assert.match(page, /Done · back to my list/);
  assert.match(page, /Full outreach record/);
  assert.doesNotMatch(page, /fetch\(|queryLocal801|runLocal801Transaction|DatabaseStatement|INSERT INTO|UPDATE local801\.|DELETE FROM/i);
});

test("field connection status is informational only and persists nothing in the browser", () => {
  const source = readFileSync(new URL("../src/components/FieldConnectionStatus.tsx", import.meta.url), "utf8");
  assert.match(source, /navigator\.onLine/);
  assert.match(source, /addEventListener\("online"/);
  assert.match(source, /addEventListener\("offline"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie/i);
});

test("PWA service worker remains static-assets-only for protected member data", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /const STATIC_ASSETS = \[/);
  assert.match(source, /"\/offline\.html"/);
  assert.match(source, /"\/icons\/local801-icon\.svg"/);
  assert.doesNotMatch(source, /STATIC_ASSETS[\s\S]*"\/outreach/);
  assert.doesNotMatch(source, /STATIC_ASSETS[\s\S]*"\/api\//);
  assert.match(source, /if \(request\.mode === "navigate"\)[\s\S]*fetch\(request\)\.catch/);
  assert.doesNotMatch(source, /cache\.put\(/i);
  assert.doesNotMatch(source, /fetch\(request\)[\s\S]{0,300}caches\.open\(/i);
});

test("push notification content stays generic and does not embed protected work details", () => {
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /body: "You have an Engaging Local 801 update\."/);
  assert.doesNotMatch(source, /employeeHandle|member|follow-up due|campaign name|work email/i);
});

test("Stage 17H remains migration-free and closes with explicit PWA privacy guardrails", () => {
  const roadmap = readFileSync(new URL("../docs/STAGE17_ADVANCED_WORKFLOWS.md", import.meta.url), "utf8");
  assert.match(roadmap, /### 17H — PWA field mode — complete/);
  assert.match(roadmap, /Schema changes: \*\*none\*\*/);
  assert.match(roadmap, /service worker remains static-shell-only/i);
  assert.match(roadmap, /server after each employee/i);
  assert.match(roadmap, /no Production, real-data, or DocLinks changes/i);
});
