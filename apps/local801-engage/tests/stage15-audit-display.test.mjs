import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  auditEventFilterOptions,
  auditEventLabel,
  auditSubjectLabel,
  getAuditDisplayPage,
} from "../src/lib/audit-display.ts";

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.test",
  role: "local_admin",
};

test("audit activity has human-readable labels with safe fallback", () => {
  assert.equal(auditEventLabel("import.execute"), "Executed import");
  assert.equal(auditEventLabel("role.change"), "Changed user role");
  assert.equal(auditEventLabel("future.event_name"), "Future event name");
  assert.equal(auditSubjectLabel("engagement_followup"), "Follow-up");
  assert.equal(auditSubjectLabel("future_subject"), "Future subject");
  assert.equal(auditSubjectLabel(null), "General activity");
  assert.equal(auditEventFilterOptions.some((option) => option.value === "import.execute" && option.label === "Executed import"), true);
});

test("legacy audit display remains organization scoped and does not invent actor PII", async () => {
  const calls = [];
  const page = await getAuditDisplayPage(context, { eventType: "role.change", pageSize: 25 }, {
    env: {},
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{
        id: "33333333-3333-4333-8333-333333333333",
        event_type: "role.change",
        actor_user_id: "44444444-4444-4444-8444-444444444444",
        subject_type: "user",
        subject_id: "55555555-5555-4555-8555-555555555555",
        created_at: "2026-08-16T20:00:00.000Z",
      }];
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].parameters[0], context.organizationId);
  assert.equal(calls[0].parameters[1], "role.change");
  assert.equal(page.protectedActorNames, false);
  assert.equal(page.events[0].eventLabel, "Changed user role");
  assert.equal(page.events[0].subjectLabel, "Workspace user");
  assert.equal(page.events[0].actorDisplayName, null);
});

test("audit page renders friendly activity without internal actor or subject IDs", () => {
  const source = readFileSync(new URL("../src/app/audit/page.tsx", import.meta.url), "utf8");
  assert.match(source, /What happened/);
  assert.match(source, /Protected PII/);
  assert.match(source, /auditEventFilterOptions/);
  assert.match(source, /actorDisplayName/);
  assert.doesNotMatch(source, /event\.subject_id/);
});
