import assert from "node:assert/strict";
import test from "node:test";
import { newHireLifecycle } from "../src/lib/new-hire-lifecycle.ts";
import { readFileSync } from "node:fs";

function person(overrides = {}) {
  return {
    assigned: false,
    latestEngagementAt: null,
    latestOutcome: null,
    membershipStatus: "unknown",
    ...overrides,
  };
}

test("new-hire lifecycle advances only from explicit recorded workflow facts", () => {
  assert.equal(newHireLifecycle(person()).stage, "new");
  assert.equal(newHireLifecycle(person({ assigned: true })).stage, "assigned");
  assert.equal(newHireLifecycle(person({ assigned: true, latestEngagementAt: "2026-08-17T00:00:00Z", latestOutcome: "left_message" })).stage, "contact_attempted");
  assert.equal(newHireLifecycle(person({ assigned: true, latestEngagementAt: "2026-08-17T00:00:00Z", latestOutcome: "contacted" })).stage, "conversation_completed");
  assert.equal(newHireLifecycle(person({ assigned: true, latestEngagementAt: "2026-08-17T00:00:00Z", latestOutcome: "contacted", membershipStatus: "member" })).stage, "membership_resolved");
  assert.equal(newHireLifecycle(person({ assigned: true, latestEngagementAt: "2026-08-17T00:00:00Z", latestOutcome: "contacted", membershipStatus: "nonmember" })).stage, "membership_resolved");
});

test("known membership alone does not silently skip organizing workflow stages", () => {
  const lifecycle = newHireLifecycle(person({ membershipStatus: "member" }));
  assert.equal(lifecycle.stage, "new");
  assert.match(lifecycle.detail, /No open outreach assignment or engagement/);
});

test("new-hire page explains lifecycle without treating it as a score", () => {
  const page = readFileSync(new URL("../src/app/new-hires/page.tsx", import.meta.url), "utf8");
  assert.match(page, /Stages move forward from recorded work\. They are progress markers, not scores\./);
  assert.match(page, /headers=\{\["Employee ID", "Person", "Hire Date", "Job Status", "Classification", "Department \/ Work Location", "Work Email", "Work Phone", "Cell Phone", "Home Phone", "Home Email", "Progress", "Assignment", "Action"\]\}/);
  assert.match(page, /Step \{lifecycle\.step\} of \{lifecycle\.totalSteps\}/);
});
