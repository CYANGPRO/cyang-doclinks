import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeSavedViewParams, notificationKey } from "../src/lib/work-preferences.ts";
import { getWorkNotifications } from "../src/lib/work-notifications.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function context(role) {
  return { organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role };
}

function followupPage(scope = "mine") {
  return {
    items: [{
      employeeHandle: "a".repeat(64),
      followupHandle: "b".repeat(64),
      displayName: "Protected Person",
      membershipStatus: "member",
      department: null,
      classification: null,
      workLocation: null,
      dueAt: "2026-08-16T15:00:00.000Z",
      completedAt: null,
      status: "open",
      bucket: "overdue",
      assignedTo: "Protected Organizer",
      assignedToHandle: "c".repeat(64),
      assigneeOptions: [],
      campaignName: null,
      latestEngagementAt: null,
      latestOutcome: null,
      willingActionCount: 0,
      consideringActionCount: 0,
      completedActionCount: 0,
      declinesAllActions: false,
    }],
    term: "",
    requestedScope: scope,
    effectiveScope: scope,
    focus: "all",
    pageSize: 50,
    total: 1,
    nextCursor: null,
  };
}

test("saved views persist only allowlisted operational filters and strip search/person state", () => {
  assert.deepEqual(normalizeSavedViewParams("cat_member", "/workload", {
    source: "campaign", window: "overdue", q: "A Person", personHandle: "a".repeat(64), cursor: "secret",
  }), { destination: "/workload", queryParams: { window: "overdue" } });

  assert.deepEqual(normalizeSavedViewParams("cat_lead", "/outreach", {
    scope: "authorized", focus: "stale", q: "Some Name", limit: "50", cursor: "opaque",
  }), { destination: "/outreach", queryParams: { focus: "stale", limit: "50" } });

  assert.deepEqual(normalizeSavedViewParams("local_admin", "/follow-ups", {
    scope: "authorized", focus: "today", q: "Some Name", limit: "50",
  }), { destination: "/follow-ups", queryParams: { scope: "authorized", focus: "today", limit: "50" } });
});

test("saved-view route authorization is enforced by current role", () => {
  assert.throws(() => normalizeSavedViewParams("report_viewer", "/workload", {}), /not available for this role/i);
  assert.throws(() => normalizeSavedViewParams("cat_member", "/imports", {}), /not available for this role/i);
  assert.deepEqual(normalizeSavedViewParams("membership_data_manager", "/imports", { q: "ignored" }), { destination: "/imports", queryParams: {} });
});

test("notification keys are deterministic hashes and never notification text", () => {
  const key = notificationKey(["followup", "b".repeat(64), "2026-08-16T15:00:00.000Z"]);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, notificationKey(["followup", "b".repeat(64), "2026-08-16T15:00:00.000Z"]));
  assert.notEqual(key, notificationKey(["followup", "b".repeat(64), "2026-08-17T15:00:00.000Z"]));
});

test("CAT members receive only their protected assigned follow-up notifications", async () => {
  const calls = { scope: null, hydrated: 0, metrics: 0, campaigns: 0, catActions: 0 };
  const notifications = await getWorkNotifications(context("cat_member"), {
    now: () => new Date("2026-08-17T04:30:00.000Z"),
    getFollowups: async (_context, input) => { calls.scope = input.scope; return followupPage("mine"); },
    hydrateFollowups: async (_organizationId, page) => { calls.hydrated += 1; return page; },
    getMetrics: async () => { calls.metrics += 1; throw new Error("not authorized"); },
    getCampaigns: async () => { calls.campaigns += 1; throw new Error("not authorized"); },
    getCatActions: async () => { calls.catActions += 1; throw new Error("not authorized"); },
    getAcknowledged: async () => new Set(),
  });
  assert.equal(calls.scope, "mine");
  assert.equal(calls.hydrated, 1);
  assert.equal(calls.metrics, 0);
  assert.equal(calls.campaigns, 0);
  assert.equal(calls.catActions, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "followup");
  assert.match(notifications[0].title, /Protected Person/);
});

test("acknowledged notification hashes filter only the matching current notification", async () => {
  const page = followupPage("mine");
  const key = notificationKey(["followup", page.items[0].followupHandle, page.items[0].dueAt]);
  const notifications = await getWorkNotifications(context("cat_member"), {
    now: () => new Date("2026-08-17T04:30:00.000Z"),
    getFollowups: async () => page,
    hydrateFollowups: async (_organizationId, value) => value,
    getAcknowledged: async () => new Set([key]),
  });
  assert.deepEqual(notifications, []);
});

test("Stage 17G migration stores preferences and acknowledgement hashes, not member content", () => {
  const sql = readFileSync(new URL("../db/migrations/0023__user_work_preferences.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists local801\.saved_work_views/i);
  assert.match(sql, /create table if not exists local801\.notification_acknowledgements/i);
  assert.match(sql, /foreign key \(organization_id, user_id\)/i);
  assert.match(sql, /notification_key char\(64\)/i);
  assert.match(sql, /octet_length\(query_params::text\) <= 2048/i);
  assert.doesNotMatch(sql, /person_id|member_id|employee_id|email|phone|note|notification_text|message_text/i);
});

test("Stage 17G HTTP and client controls avoid browser-stored member/work state", () => {
  const controls = readFileSync(new URL("../src/components/WorkPreferenceControls.tsx", import.meta.url), "utf8");
  const http = readFileSync(new URL("../src/lib/work-preference-http.ts", import.meta.url), "utf8");
  assert.doesNotMatch(controls, /localStorage|sessionStorage|indexedDB|caches\./i);
  assert.match(http, /hasExactSameOrigin/);
  assert.match(http, /requirePreviewUser/);
  assert.match(http, /MAX_JSON_BYTES = 4_096/);
});

test("Notifications page checks operational personal-workspace permission before querying", () => {
  const page = readFileSync(new URL("../src/app/notifications/page.tsx", import.meta.url), "utf8");
  const permissionCheck = page.indexOf('can(user.role, "viewPersonalWorkspace")');
  const workspaceRead = page.indexOf("resolveWorkspaceContext(user)");
  assert.ok(permissionCheck >= 0 && workspaceRead > permissionCheck);
  assert.match(page, /ProtectedPage permission="viewPersonalWorkspace"/);
});

test("Workload is the first save-enabled view and saved filters are server-canonicalized", () => {
  const page = readFileSync(new URL("../src/app/workload/page.tsx", import.meta.url), "utf8");
  assert.match(page, /SaveCurrentView destination="\/workload"/);
  assert.match(page, /person identifiers and search text are never saved/i);
});
