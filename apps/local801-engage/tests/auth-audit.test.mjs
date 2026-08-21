import assert from "node:assert/strict";
import test from "node:test";

const access = await import("../src/lib/access.ts");
const audit = await import("../src/lib/audit.ts");

test("role permissions enforce read-only users cannot mutate imports", () => {
  assert.equal(access.can("system_owner", "manageImports"), true);
  assert.equal(access.can("local_admin", "manageImports"), true);
  assert.equal(access.can("report_viewer", "manageImports"), false);
  assert.equal(access.can("cat_member", "manageImports"), false);
});

test("audit payload redacts sensitive fields", () => {
  const event = audit.buildAuditEvent({
    eventType: "import.preview",
    actorId: "preview-local-admin",
    organizationId: "local801-preview",
    payload: {
      sourceFilename: "sample.xlsx",
      workEmail: "sensitive@example.test",
      rowCount: 2,
    },
  });

  assert.equal(event.payload.workEmail, "[redacted]");
  assert.equal(event.payload.rowCount, 2);
  assert.match(event.eventHash, /^[a-f0-9]{64}$/);
});

test("durable import audit writes are organization scoped and hash-linked", async () => {
  const calls = [];
  const result = await audit.writeAuditEvent({
    eventType: "import.validation",
    actorId: "user-uuid",
    organizationId: "org-uuid",
    subjectType: "import_batch",
    subjectId: "batch-uuid",
    payload: { rowCount: 3 },
  }, async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("SELECT event_hash")) return [{ event_hash: "previous-hash" }];
    return [{ id: "event-uuid" }];
  });
  assert.equal(result.id, "event-uuid");
  assert.equal(result.previousHash, "previous-hash");
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /INSERT INTO local801\.audit_events/);
  assert.equal(calls[1].parameters[0], "org-uuid");
  assert.equal(calls[1].parameters[1], "user-uuid");
});

test("audit timestamps normalize Date and string values to deterministic display text", () => {
  const expected = "2026-08-11T15:30:45.123Z";
  const fromDate = audit.normalizeAuditTimestamp(new Date(expected));
  const fromString = audit.normalizeAuditTimestamp(expected);

  assert.equal(fromDate, expected);
  assert.equal(fromString, expected);
  assert.equal(typeof fromDate, "string");
  assert.equal(typeof fromString, "string");
  assert.equal(audit.normalizeAuditTimestamp("not-a-timestamp"), "Timestamp unavailable");
});

const auditContext = (role = "local_admin") => ({ organizationId: "org-uuid", role });

test("audit reads normalize timestamps and remain organization scoped and bounded", async () => {
  const calls = [];
  const rows = await audit.listAuditEvents(auditContext(), async (sql, parameters) => {
    calls.push({ sql, parameters });
    return [
      {
        id: "event-date",
        event_type: "import.upload",
        actor_user_id: "user-uuid",
        subject_type: "import_batch",
        subject_id: "batch-uuid",
        payload: {},
        event_hash: "hash-date",
        previous_hash: null,
        created_at: new Date("2026-08-11T15:30:45.123Z"),
      },
      {
        id: "event-string",
        event_type: "import.validation",
        actor_user_id: "user-uuid",
        subject_type: "import_batch",
        subject_id: "batch-uuid",
        payload: {},
        event_hash: "hash-string",
        previous_hash: "hash-date",
        created_at: "2026-08-11T15:31:45.123Z",
      },
    ];
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, ["org-uuid"]);
  assert.match(calls[0].sql, /WHERE organization_id = \$1/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(calls[0].sql, /LIMIT 50/);
  assert.deepEqual(rows.map((row) => row.created_at), [
    "2026-08-11T15:30:45.123Z",
    "2026-08-11T15:31:45.123Z",
  ]);
  assert.equal(rows.every((row) => typeof row.created_at === "string" && !(row.created_at instanceof Date)), true);
});

test("empty audit reads remain safe", async () => {
  const rows = await audit.listAuditEvents(auditContext(), async () => []);
  assert.deepEqual(rows, []);
});

test("audit service denies non-administrators before issuing SQL", async () => {
  let calls = 0;
  await assert.rejects(audit.listAuditEvents(auditContext("membership_data_manager"), async () => {
    calls += 1;
    return [];
  }), /not authorized/);
  assert.equal(calls, 0);
});

test("audit keyset cursor rejects invalid UUIDs before PostgreSQL casts", async () => {
  const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-08-11T15:30:45.123Z", id: "not-a-uuid" })).toString("base64url");
  let parameters;
  await audit.getAuditPage(auditContext(), { cursor }, async (_sql, values) => {
    parameters = values;
    return [];
  });
  assert.equal(parameters[2], null);
  assert.equal(parameters[3], null);
});
