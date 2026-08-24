import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getPersonLifecycle } from "../src/lib/person-lifecycle.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const context = {
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "organizer@example.test",
  role: "cat_member",
};
const handle = "b".repeat(64);

test("person lifecycle reuses outreach authorization scope and returns durable event history", async () => {
  let recorded;
  const events = await getPersonLifecycle(context, handle, async (sql, parameters) => {
    recorded = { sql, parameters };
    return [
      { kind: "membership", event_type: "addition", effective_date: "2026-08-15", department: null, work_location: null },
      { kind: "employment", event_type: "hire", effective_date: "2026-08-01", department: "Operations", work_location: "Metro" },
    ];
  });

  assert.deepEqual(recorded.parameters, [organizationId, context.userId, handle, false]);
  assert.match(recorded.sql, /engagement_assignments/);
  assert.match(recorded.sql, /membership_events/);
  assert.match(recorded.sql, /employment_events/);
  assert.match(recorded.sql, /LIMIT 50/);
  assert.deepEqual(events, [
    { kind: "membership", eventType: "addition", effectiveDate: "2026-08-15", department: null, workLocation: null },
    { kind: "employment", eventType: "hire", effectiveDate: "2026-08-01", department: "Operations", workLocation: "Metro" },
  ]);
});

test("organization-wide organizer roles can use authorized person scope without assignment restriction", async () => {
  let parameters;
  await getPersonLifecycle({ ...context, role: "cat_admin" }, handle, async (_sql, values) => {
    parameters = values;
    return [];
  });
  assert.equal(parameters[3], true);
});

test("roles without engagement access cannot read person lifecycle", async () => {
  await assert.rejects(() => getPersonLifecycle({ ...context, role: "report_viewer" }, handle, async () => []), /not authorized/i);
});

test("existing outreach record is the person lifecycle hub", () => {
  const source = readFileSync(new URL("../src/app/outreach/[handle]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /eyebrow="Member outreach"/);
  assert.match(source, /Membership & employment history/);
  assert.match(source, /getPersonLifecycle/);
  assert.doesNotMatch(source, /Member 360/i);
});
