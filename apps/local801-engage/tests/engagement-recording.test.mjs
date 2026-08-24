import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mod = await import("../src/lib/engagement-recording.ts");
const {
  __testing,
  getEngagementFormOptions,
  recordEngagement,
  completeOutreachFollowup,
} = mod;

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const ASSIGNMENT = "44444444-4444-4444-8444-444444444444";
const ASSIGNEE = "55555555-5555-4555-8555-555555555555";
const FOLLOWUP = "66666666-6666-4666-8666-666666666666";
const context = { organizationId: ORG, userId: USER, role: "local_admin" };

function handle(kind, id) { return __testing.opaqueHandle(kind, ORG, id); }

function queryFor(map) {
  return async (sql) => {
    for (const [marker, rows] of Object.entries(map)) if (sql.includes(marker)) return typeof rows === "function" ? rows(sql) : rows;
    throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  };
}

test("controlled engagement taxonomies reject arbitrary values", () => {
  assert.equal(__testing.normalizeEnum("email", mod.CONTACT_METHODS, "Contact method"), "email");
  assert.equal(__testing.normalizeEnum("contacted", mod.ENGAGEMENT_OUTCOMES, "Outcome"), "contacted");
  assert.throws(() => __testing.normalizeEnum("maybe", mod.ENGAGEMENT_OUTCOMES, "Outcome"), /invalid/i);
});

test("narrative notes default to assigned scope and are bounded", () => {
  assert.deepEqual(__testing.normalizeNote({ text: "  Follow up about schedule.  " }), {
    text: "Follow up about schedule.", visibility: "assigned_scope",
  });
  assert.equal(__testing.normalizeNote({ text: "   " }), null);
  assert.throws(() => __testing.normalizeNote({ text: "x".repeat(2001) }), /2000/);
});

test("engagement timestamps reject future and excessively old direct entry", () => {
  const now = new Date("2026-08-14T19:00:00.000Z");
  assert.equal(__testing.normalizeOccurredAt("2026-08-14T18:55:00.000Z", now), "2026-08-14T18:55:00.000Z");
  assert.throws(() => __testing.normalizeOccurredAt("2026-08-14T20:00:00.000Z", now), /future/i);
  assert.throws(() => __testing.normalizeOccurredAt("2024-01-01T00:00:00.000Z", now), /too far/i);
});

test("form options expose only opaque assignment and assignee handles", async () => {
  const query = queryFor({
    "engagement-recording:resolve-person": [{ id: PERSON }],
    "engagement-recording:assignment-options": [{ id: ASSIGNMENT, campaign_name: "Synthetic Outreach", is_primary: true, is_backup: false }],
    "engagement-recording:assignee-options": [{ id: USER, display_name: "Synthetic Admin" }],
    "employee-actions:definitions": [],
  });
  const options = await getEngagementFormOptions(context, "a".repeat(64), query);
  assert.equal(options.assignments.length, 1);
  assert.match(options.assignments[0].handle, /^[0-9a-f]{64}$/);
  assert.notEqual(options.assignments[0].handle, ASSIGNMENT);
  assert.match(options.assignees[0].handle, /^[0-9a-f]{64}$/);
  assert.notEqual(options.assignees[0].handle, USER);
});

test("conversation, encrypted note, follow-up, and audit are one bounded transaction", async () => {
  const statements = [];
  let auditEvent;
  const query = queryFor({
    "engagement-recording:resolve-person": [{ id: PERSON }],
    "engagement-recording:resolve-assignment": [{ id: ASSIGNMENT, campaign_id: null }],
    "engagement-recording:resolve-assignee": [{ id: ASSIGNEE }],
  });
  const result = await recordEngagement(context, {
    personHandle: "a".repeat(64),
    assignmentHandle: handle("assignment", ASSIGNMENT),
    contactMethod: "email",
    outcome: "contacted",
    occurredAt: "2026-08-14T18:30:00.000Z",
    note: { text: "Sensitive organizing note", visibility: "assigned_scope" },
    followup: { dueAt: "2026-08-20T18:30:00.000Z", assigneeHandle: handle("user", ASSIGNEE) },
  }, {
    query,
    now: () => new Date("2026-08-14T19:00:00.000Z"),
    encrypt: () => ({ payload: Buffer.from("ENCRYPTED_ENVELOPE"), keyVersion: "v9", formatVersion: 1 }),
    prepareAudit: async (event) => { auditEvent = event; return { sql: "/* audit */ select 1", parameters: [] }; },
    runTransaction: async (items) => { statements.push(...items); },
  });
  assert.equal(statements.length, 4);
  assert.match(statements[0].sql, /insert-event/);
  assert.match(statements[0].sql, /assignment\.status = 'open'/);
  assert.match(statements[1].sql, /insert-encrypted-note/);
  assert.equal(statements[1].parameters[3], "ENCRYPTED_ENVELOPE");
  assert.match(statements[2].sql, /insert-followup/);
  assert.match(statements[3].sql, /audit/);
  assert.equal(auditEvent.hasOwnProperty("payload"), true);
  assert.equal(auditEvent.payload.hasNarrative, true);
  assert.equal(JSON.stringify(auditEvent).includes("Sensitive organizing note"), false);
  assert.equal(statements.some((item) => JSON.stringify(item.parameters || []).includes("Sensitive organizing note")), false);
  assert.match(result.engagementHandle, /^[0-9a-f]{64}$/);
  assert.equal(result.followupCreated, true);
});

test("conversation without note or follow-up writes only event and audit", async () => {
  const statements = [];
  const query = queryFor({ "engagement-recording:resolve-person": [{ id: PERSON }] });
  await recordEngagement(context, {
    personHandle: "a".repeat(64), contactMethod: "phone", outcome: "no_answer",
  }, {
    query,
    now: () => new Date("2026-08-14T19:00:00.000Z"),
    prepareAudit: async () => ({ sql: "/* audit */ select 1" }),
    runTransaction: async (items) => statements.push(...items),
  });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /insert-event/);
  assert.match(statements[1].sql, /audit/);
});

test("CAT members cannot record a general engagement without an open assignment context", async () => {
  const memberContext = { ...context, role: "cat_member" };
  const query = queryFor({ "engagement-recording:resolve-person": [{ id: PERSON }] });
  await assert.rejects(() => recordEngagement(memberContext, {
    personHandle: "a".repeat(64), contactMethod: "phone", outcome: "contacted",
  }, { query, now: () => new Date("2026-08-14T19:00:00Z") }), /Select a current outreach assignment/i);
});

test("LCATs can record organization-wide general outreach without a prior assignment", async () => {
  const statements = [];
  const leadContext = { ...context, role: "cat_lead" };
  const query = queryFor({ "engagement-recording:resolve-person": [{ id: PERSON }] });
  await recordEngagement(leadContext, {
    personHandle: "a".repeat(64), contactMethod: "phone", outcome: "contacted",
  }, {
    query,
    now: () => new Date("2026-08-14T19:00:00Z"),
    prepareAudit: async () => ({ sql: "/* audit */ select 1" }),
    runTransaction: async (items) => statements.push(...items),
  });
  assert.match(statements[0].sql, /'system_owner','local_admin','cat_admin','cat_lead'/);
});

test("follow-up completion is scoped to the authorized employee and audited atomically", async () => {
  const statements = [];
  const query = queryFor({
    "engagement-recording:resolve-person": [{ id: PERSON }],
    "engagement-recording:resolve-followup": [{ id: FOLLOWUP }],
  });
  const result = await completeOutreachFollowup(context, {
    personHandle: "a".repeat(64), followupHandle: handle("followup", FOLLOWUP),
  }, {
    query,
    prepareAudit: async () => ({ sql: "/* audit */ select 1" }),
    runTransaction: async (items) => statements.push(...items),
  });
  assert.equal(result.completed, true);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /status = 'completed'/);
  assert.match(statements[1].sql, /audit/);
});

test("production SQL does not use dynamic arbitrary outcome or contact values", () => {
  const source = readFileSync(new URL("../src/lib/engagement-recording.ts", import.meta.url), "utf8");
  assert.match(source, /CONTACT_METHODS/);
  assert.match(source, /ENGAGEMENT_OUTCOMES/);
  assert.match(source, /normalizeEnum\(input\.contactMethod/);
  assert.match(source, /normalizeEnum\(input\.outcome/);
});


test("follow-up writes recheck organizer role and CAT-member self assignment inside the transaction", async () => {
  const statements = [];
  const query = queryFor({
    "engagement-recording:resolve-person": [{ id: PERSON }],
    "engagement-recording:resolve-assignment": [{ id: ASSIGNMENT, campaign_id: null }],
    "engagement-recording:resolve-assignee": [{ id: ASSIGNEE }],
  });
  await recordEngagement(context, {
    personHandle: "a".repeat(64), assignmentHandle: handle("assignment", ASSIGNMENT), contactMethod: "email", outcome: "contacted",
    followup: { dueAt: "2026-08-20T18:30:00.000Z", assigneeHandle: handle("user", ASSIGNEE) },
  }, {
    query, now: () => new Date("2026-08-14T19:00:00.000Z"),
    prepareAudit: async () => ({ sql: "/* audit */ select 1" }),
    runTransaction: async (items) => statements.push(...items),
  });
  const followup = statements.find((item) => /insert-followup/.test(item.sql));
  assert.match(followup.sql, /workspace_user_roles/);
  assert.match(followup.sql, /role\.code IN \('system_owner','local_admin','cat_admin','cat_lead','cat_member'\)/);
  assert.match(followup.sql, /\$7::text <> 'cat_member' OR assignee\.id = \$6::uuid/);
});

test("follow-up completion rechecks current open assignment authorization in the transaction", async () => {
  const statements = [];
  const query = queryFor({
    "engagement-recording:resolve-person": [{ id: PERSON }],
    "engagement-recording:resolve-followup": [{ id: FOLLOWUP }],
  });
  await completeOutreachFollowup(context, { personHandle: "a".repeat(64), followupHandle: handle("followup", FOLLOWUP) }, {
    query, prepareAudit: async () => ({ sql: "/* audit */ select 1" }), runTransaction: async (items) => statements.push(...items),
  });
  assert.match(statements[0].sql, /assignment\.status = 'open'/);
  assert.match(statements[0].sql, /assignment\.primary_user_id = actor\.id OR assignment\.backup_user_id = actor\.id/);
});
