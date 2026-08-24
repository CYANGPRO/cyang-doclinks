import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyCalendarDate, getWorkloadCalendar } from "../src/lib/workload-calendar.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function context(role = "local_admin") {
  return {
    organizationId,
    organizationSlug: "local801-preview",
    userId,
    email: `${role}@example.test`,
    role,
  };
}

const metrics = {
  represented: 10,
  members: 8,
  membershipPercentage: "80.0%",
  openAssignments: 5,
  assignedAttention90: 1,
  newHiresThisMonth: 2,
  newHiresAwaitingFirstEngagement14: 0,
  additionsThisMonth: 1,
  dropsThisMonth: 0,
  recentMembershipChanges7Days: 1,
  overdueFollowups: 1,
  followupsDueToday: 1,
  upcomingFollowups: 1,
  importsInReview: 0,
  activeCampaigns: 1,
  openCatActions: 1,
  reportingDate: "2026-08-16",
  sourceSnapshot: "synthetic",
  source: "database",
};

function followupPage(scope) {
  return {
    items: [
      {
        employeeHandle: "a".repeat(64),
        followupHandle: "b".repeat(64),
        displayName: "Protected Person",
        membershipStatus: "member",
        department: "Department",
        classification: "Classification",
        workLocation: "Work location",
        dueAt: "2026-08-17T15:00:00.000Z",
        completedAt: null,
        status: "open",
        bucket: "upcoming",
        assignedTo: "Protected Organizer",
        assignedToHandle: "c".repeat(64),
        assigneeOptions: [],
        campaignName: "Campaign A",
        latestEngagementAt: null,
        latestOutcome: null,
        willingActionCount: 0,
        consideringActionCount: 0,
        completedActionCount: 0,
        declinesAllActions: false,
      },
    ],
    term: "",
    requestedScope: scope,
    effectiveScope: scope,
    focus: "all",
    pageSize: 50,
    total: 1,
    nextCursor: null,
  };
}

test("Stage 17F calendar buckets use explicit America/Chicago date facts", () => {
  const now = new Date("2026-08-17T04:30:00.000Z"); // Aug 16, 11:30 PM America/Chicago
  assert.equal(classifyCalendarDate("2026-08-15", "2026-08-16", { now }), "overdue");
  assert.equal(classifyCalendarDate("2026-08-16", "2026-08-16", { now }), "today");
  assert.equal(classifyCalendarDate("2026-08-23", "2026-08-16", { now }), "next7");
  assert.equal(classifyCalendarDate("2026-08-24", "2026-08-16", { now }), "later");
  assert.equal(classifyCalendarDate("2026-08-16", "2026-08-16", { timedValue: "2026-08-17T04:00:00.000Z", now }), "overdue");
});

test("constrained CAT roles receive only their existing follow-up scope", async () => {
  const calls = { scope: null, campaigns: 0, catActions: 0, hydrated: 0 };
  const result = await getWorkloadCalendar(context("cat_lead"), {
    now: () => new Date("2026-08-16T18:00:00.000Z"),
    getMetrics: async () => metrics,
    getFollowups: async (_context, input) => {
      calls.scope = input.scope;
      return followupPage("mine");
    },
    hydrateFollowups: async (_organizationId, page) => {
      calls.hydrated += 1;
      return page;
    },
    getCampaigns: async () => { calls.campaigns += 1; throw new Error("not authorized"); },
    getCatActions: async () => { calls.catActions += 1; throw new Error("not authorized"); },
  });

  assert.equal(calls.scope, "mine");
  assert.equal(calls.hydrated, 1);
  assert.equal(calls.campaigns, 0);
  assert.equal(calls.catActions, 0);
  assert.equal(result.scope, "mine");
  assert.deepEqual(result.entries.map((entry) => entry.kind), ["followup"]);
});

test("organization-wide organizing roles receive authorized follow-ups plus allowed campaign and CAT due context", async () => {
  const result = await getWorkloadCalendar(context("local_admin"), {
    now: () => new Date("2026-08-16T18:00:00.000Z"),
    getMetrics: async () => metrics,
    getFollowups: async (_context, input) => followupPage(input.scope),
    hydrateFollowups: async (_organizationId, page) => page,
    getCampaigns: async () => ({
      campaigns: [{
        handle: "d".repeat(64),
        name: "Campaign A",
        status: "active",
        startsOn: "2026-08-01",
        endsOn: "2026-08-20",
        launchedAt: "2026-08-01T12:00:00.000Z",
        population: 20,
        assigned: 20,
        contacted: 10,
        completed: 5,
        remaining: 15,
        completionPercentage: 25,
      }],
      nextCursor: null,
      pageSize: 100,
    }),
    getCatActions: async () => ({
      actions: [{
        handle: "e".repeat(64),
        name: "CAT Action A",
        status: "active",
        contractCycleName: null,
        taskCount: 4,
        openTaskCount: 2,
        completedTaskCount: 2,
        overdueTaskCount: 0,
        assignedUserCount: 2,
        completionRate: 50,
        nextDueAt: "2026-08-19T17:00:00.000Z",
      }],
      term: "",
      status: "",
      pageSize: 100,
      total: 1,
      summary: { activeActions: 1, openTasks: 2, completedTasks: 2, overdueTasks: 0 },
      nextCursor: null,
    }),
  });

  assert.equal(result.scope, "authorized");
  assert.deepEqual(new Set(result.entries.map((entry) => entry.kind)), new Set(["followup", "campaign", "cat_action"]));
  assert.equal(result.entries.find((entry) => entry.kind === "campaign")?.detail, "15 remaining · 25% complete");
  assert.match(result.entries.find((entry) => entry.kind === "cat_action")?.detail ?? "", /2 open tasks/);
});

test("Stage 17F workload layer composes existing protected reads and contains no SQL or mutation path", () => {
  const source = readFileSync(new URL("../src/lib/workload-calendar.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/workload/page.tsx", import.meta.url), "utf8");
  assert.match(source, /hydrateFollowupQueueFromProtectedPii/);
  assert.match(source, /getFollowupQueue/);
  assert.match(source, /getCampaignsPage/);
  assert.match(source, /getCatActionsPage/);
  assert.doesNotMatch(source, /SELECT |INSERT |UPDATE |DELETE /i);
  assert.doesNotMatch(page, /fetch\(|method="post"|method="patch"|method="delete"/i);
  assert.match(page, /title="Planning only"/);
  assert.match(page, /doesn’t change assignments or rate anyone/i);
});

test("Workload navigation remains recordEngagement scoped in the task-first navigation model", () => {
  const access = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
  assert.match(access, /href: "\/workload", label: "Work planner", group: "My work", permission: "recordEngagement"/);
  assert.match(access, /href: "\/outreach", label: "Member outreach", group: "My work"/);
});

test("Stage 17F remains migration-free and defers bulk mutation until an atomic audited design exists", () => {
  const roadmap = readFileSync(new URL("../docs/STAGE17_ADVANCED_WORKFLOWS.md", import.meta.url), "utf8");
  assert.match(roadmap, /### 17F — Workload and calendar operations/);
  assert.match(roadmap, /Schema changes: \*\*none\*\*/);
  assert.match(roadmap, /read-only operations calendar/i);
  assert.match(roadmap, /Bulk mutation remains deferred/i);
  assert.match(roadmap, /operational capacity, never a performance score/i);
});
