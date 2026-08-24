import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ContactCorrectionError,
  decideContactCorrection,
  getVisibleContactActions,
  listContactCorrectionsForReview,
  preferredVisibleEmail,
  preferredVisiblePhone,
  submitContactCorrection,
} from "../src/lib/contact-corrections.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const contactId = "55555555-5555-4555-8555-555555555555";
const personHandle = createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
const requestHandle = createHash("sha256").update(`contact-correction:${organizationId}:${requestId}`).digest("hex");
const revision = "f".repeat(64);
const key = (byte) => Buffer.alloc(32, byte).toString("base64");

function environment(overrides = {}) {
  return {
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: key(1) }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: key(2) }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
    ...overrides,
  };
}

const keyConfig = getPiiKeyConfiguration(environment());
const protectedState = {
  write_mode: "protected",
  backfill_state: "complete",
  backfill_completed_at: "2026-08-16T00:00:00.000Z",
  protected_read_enabled_at: "2026-08-16T00:00:01.000Z",
  protected_write_enabled_at: "2026-08-16T00:00:02.000Z",
  verified_at: "2026-08-16T00:00:03.000Z",
};

function context(role = "local_admin") {
  return {
    organizationId,
    organizationSlug: "local801-preview",
    userId,
    email: `${role}@example.test`,
    role,
  };
}

function envelope(value, entity, recordId, field) {
  return encryptPiiField(value, { organizationId, entity, recordId, field }, keyConfig);
}

function proposedRow(value = "synthetic.member@example.test") {
  const proposed = envelope(value, "correction-request", requestId, "proposed-value");
  return {
    id: requestId,
    person_id: personId,
    field_name: "work_email",
    proposed_value_encrypted_payload: proposed.encryptedPayload,
    encryption_key_version: proposed.encryptionKeyVersion,
    encryption_format_version: proposed.encryptionFormatVersion,
  };
}

function visibleContactRow(id, contactType, contactLabel, value) {
  const protectedValue = envelope(value, "person-contact", id, "contact-value");
  return {
    contact_method_id: id,
    contact_type: contactType,
    contact_label: contactLabel,
    contact_value_encrypted_payload: protectedValue.encryptedPayload,
    encryption_key_version: protectedValue.encryptionKeyVersion,
    encryption_format_version: protectedValue.encryptionFormatVersion,
  };
}

function commonQuery(sql) {
  if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
  if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
  throw new Error(`Unexpected query: ${sql}`);
}

test("contact view loads every phone and email type and applies the requested contact preference order", async () => {
  const ids = {
    cell: "55555555-5555-4555-8555-555555555551",
    homePhone: "55555555-5555-4555-8555-555555555552",
    workPhone: "55555555-5555-4555-8555-555555555553",
    homeEmail: "55555555-5555-4555-8555-555555555554",
    workEmail: "55555555-5555-4555-8555-555555555555",
  };
  let contactSql = "";
  const contacts = await getVisibleContactActions(context("cat_member"), personHandle, {
    env: environment(),
    keyConfig,
    query: async (sql) => {
      if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
      if (sql.includes("contact-correction:resolve-person")) return [{ id: personId }];
      if (sql.includes("contact-correction:visible-contact-actions")) {
        contactSql = sql;
        return [
          visibleContactRow(ids.cell, "phone", "cell", "651-555-0101"),
          visibleContactRow(ids.homePhone, "phone", "home", "651-555-0102"),
          visibleContactRow(ids.workPhone, "phone", "work", "651-555-0103"),
          visibleContactRow(ids.homeEmail, "personal_email", "home", "member.home@example.test"),
          visibleContactRow(ids.workEmail, "work_email", "work", "member.work@example.test"),
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  assert.deepEqual(contacts, {
    cellPhone: "651-555-0101",
    homePhone: "651-555-0102",
    workPhone: "651-555-0103",
    homeEmail: "member.home@example.test",
    workEmail: "member.work@example.test",
  });
  assert.match(contactSql, /contact\.contact_type IN \('work_email','personal_email','phone'\)/);
  assert.match(contactSql, /DISTINCT ON \(contact\.contact_type, contact\.contact_label\)/);
  assert.doesNotMatch(contactSql, /contact\.is_primary = true/);
  assert.equal(preferredVisiblePhone(contacts), "651-555-0101");
  assert.equal(preferredVisiblePhone({ ...contacts, cellPhone: null }), "651-555-0102");
  assert.equal(preferredVisiblePhone({ ...contacts, cellPhone: null, homePhone: null }), "651-555-0103");
  assert.equal(preferredVisibleEmail(contacts), "member.home@example.test");
  assert.equal(preferredVisibleEmail({ ...contacts, homeEmail: null }), "member.work@example.test");
});

test("assigned organizers submit an encrypted contact update with atomic PII-free audit evidence", async () => {
  const transactions = [];
  let resolvedSql = "";
  const result = await submitContactCorrection(context("cat_member"), {
    personHandle,
    field: "work_email",
    proposedValue: "synthetic.member@example.test",
  }, {
    env: environment(),
    keyConfig,
    query: async (sql, parameters) => {
      if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
      if (sql.includes("contact-correction:resolve-person")) {
        resolvedSql = sql;
        assert.deepEqual(parameters, [organizationId, userId, personHandle, "cat_member"]);
        return [{ id: personId }];
      }
      if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    runTransaction: async (statements) => { transactions.push(statements); },
  });

  assert.match(resolvedSql, /assignment\.organization_id = \$1::uuid/);
  assert.match(resolvedSql, /assignment\.primary_user_id = \$2::uuid OR assignment\.backup_user_id = \$2::uuid/);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  const [write, audit] = transactions[0];
  assert.match(write.sql, /submit_protected_contact_correction/);
  const generatedRequestId = write.parameters[1];
  assert.deepEqual(write.parameters.slice(0, 5), [organizationId, generatedRequestId, personId, userId, "work_email"]);
  assert.notEqual(write.parameters[5], "synthetic.member@example.test");
  assert.equal(JSON.stringify(transactions[0]).includes("synthetic.member@example.test"), false);
  assert.equal(result.handle, createHash("sha256").update(`contact-correction:${organizationId}:${generatedRequestId}`).digest("hex"));
  assert.match(audit.sql, /INSERT INTO local801\.audit_events/);
  assert.deepEqual(JSON.parse(audit.parameters[5]), { field: "work_email", workflow: "organizer_reported_correction" });
});

test("contact updates fail closed without protected mode and reviewers are denied before queue SQL", async () => {
  let calls = 0;
  await assert.rejects(
    submitContactCorrection(context("cat_member"), { personHandle, field: "phone", proposedValue: "555-0100" }, {
      env: {},
      query: async () => { calls += 1; return []; },
    }),
    (error) => error instanceof ContactCorrectionError && error.code === "PROTECTED_PII_REQUIRED" && error.status === 503,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    listContactCorrectionsForReview(context("cat_admin"), { query: async () => { calls += 1; return []; } }),
    (error) => error instanceof ContactCorrectionError && error.code === "FORBIDDEN" && error.status === 403,
  );
  assert.equal(calls, 0);
});

test("authorized review hydrates current and proposed values only after protected-state validation", async () => {
  const proposed = proposedRow();
  const first = envelope("Synthetic", "person", personId, "first-name");
  const last = envelope("Member", "person", personId, "last-name");
  const current = envelope("old.synthetic@example.test", "person-contact", contactId, "contact-value");
  const calls = [];
  const page = await listContactCorrectionsForReview(context("membership_data_manager"), {
    env: environment(),
    keyConfig,
    query: async (sql, parameters) => {
      calls.push(sql);
      if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
      if (sql.includes("contact-correction:review-queue")) {
        assert.deepEqual(parameters, [organizationId]);
        return [{
          ...proposed,
          created_at: "2026-08-18T12:00:00.000Z",
          first_name_encrypted_payload: first.encryptedPayload,
          first_name_encryption_key_version: first.encryptionKeyVersion,
          first_name_encryption_format_version: 1,
          last_name_encrypted_payload: last.encryptedPayload,
          last_name_encryption_key_version: last.encryptionKeyVersion,
          last_name_encryption_format_version: 1,
          preferred_name_encrypted_payload: null,
          preferred_name_encryption_key_version: null,
          preferred_name_encryption_format_version: null,
          contact_method_id: contactId,
          revision,
          current_contact_value_encrypted_payload: current.encryptedPayload,
          current_contact_encryption_key_version: current.encryptionKeyVersion,
          current_contact_encryption_format_version: 1,
        }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });

  assert.ok(calls[0].includes("pii-protected-read:acceptance-state"));
  assert.deepEqual(page, {
    items: [{
      handle: requestHandle,
      revision,
      personHandle,
      displayName: "Synthetic Member",
      field: "work_email",
      currentValue: "old.synthetic@example.test",
      proposedValue: "synthetic.member@example.test",
      submittedAt: "2026-08-18T12:00:00.000Z",
    }],
    hasMore: false,
  });
});

test("approval updates the protected authoritative contact and audit in one transaction", async () => {
  const transactions = [];
  const row = proposedRow();
  const result = await decideContactCorrection(context("local_admin"), { handle: requestHandle, decision: "approved", revision }, {
    env: environment(),
    keyConfig,
    query: async (sql, parameters) => {
      if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
      if (sql.includes("contact-correction:resolve-review")) {
        assert.deepEqual(parameters, [organizationId, requestHandle]);
        return [row];
      }
      if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
      if (sql.includes("FROM local801.person_contact_methods")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    runTransaction: async (statements) => { transactions.push(statements); },
  });

  assert.deepEqual(result, { decision: "approved" });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  const [approve, audit] = transactions[0];
  assert.match(approve.sql, /approve_protected_contact_correction/);
  assert.deepEqual(approve.parameters.slice(0, 6), [organizationId, requestId, userId, approve.parameters[3], "work_email", "assigned_only"]);
  assert.match(approve.parameters[10], /^[0-9a-f]{64}$/);
  assert.equal(approve.parameters[11], revision);
  assert.equal(JSON.stringify(transactions[0]).includes("synthetic.member@example.test"), false);
  assert.deepEqual(JSON.parse(audit.parameters[5]), { field: "work_email", decision: "approved" });
});

test("rejection is atomic and a repeated decision fails stale without another mutation", async () => {
  let pending = true;
  const transactions = [];
  const row = proposedRow();
  const dependencies = {
    env: environment(),
    keyConfig,
    query: async (sql) => {
      if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
      if (sql.includes("contact-correction:resolve-review")) return pending ? [row] : [];
      if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    runTransaction: async (statements) => { transactions.push(statements); pending = false; },
  };

  assert.deepEqual(
    await decideContactCorrection(context("membership_data_manager"), { handle: requestHandle, decision: "rejected" }, dependencies),
    { decision: "rejected" },
  );
  assert.match(transactions[0][0].sql, /reject_protected_contact_correction/);
  assert.deepEqual(JSON.parse(transactions[0][1].parameters[5]), { field: "work_email", decision: "rejected" });

  await assert.rejects(
    decideContactCorrection(context("membership_data_manager"), { handle: requestHandle, decision: "approved" }, dependencies),
    (error) => error instanceof ContactCorrectionError && error.code === "NOT_FOUND" && error.status === 404,
  );
  assert.equal(transactions.length, 1);
});

test("Stage 17I routes and migration retain bounded request, authorization, no-store, and concurrency guards", () => {
  const submitRoute = readFileSync(new URL("../src/app/api/outreach/[handle]/contact-corrections/route.ts", import.meta.url), "utf8");
  const reviewRoute = readFileSync(new URL("../src/app/api/contact-corrections/[handle]/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../db/migrations/0024__protected_contact_corrections.sql", import.meta.url), "utf8");

  assert.match(submitRoute, /MAX_JSON_BYTES = 2_048/);
  assert.match(submitRoute, /hasExactSameOrigin\(request\)/);
  assert.match(submitRoute, /requirePreviewUser\("recordEngagement"\)/);
  assert.match(submitRoute, /private, no-store/);
  assert.match(reviewRoute, /MAX_JSON_BYTES = 1_024/);
  assert.match(reviewRoute, /content-length/);
  assert.match(reviewRoute, /Buffer\.byteLength\(text, "utf8"\) > MAX_JSON_BYTES/);
  assert.match(reviewRoute, /typeof parsed !== "object" \|\| Array\.isArray\(parsed\)/);
  assert.match(reviewRoute, /hasExactSameOrigin\(request\)/);
  assert.match(reviewRoute, /requirePreviewUser\("manageImports"\)/);
  assert.match(reviewRoute, /private, no-store/);

  assert.match(migration, /^begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, /submit_protected_contact_correction/);
  assert.match(migration, /reject_protected_contact_correction/);
  assert.match(migration, /approve_protected_contact_correction/);
  assert.match(migration, /state = 'submitted'[\s\S]*for update/i);
  assert.match(migration, /if changed <> 1 then raise exception 'contact correction request is no longer pending'/i);
  assert.doesNotMatch(migration, /proposed_value\s*=\s*(?:target_|encrypted_payload)/i);

  const integrityMigration = readFileSync(new URL("../db/migrations/0025__stage17_correction_integrity.sql", import.meta.url), "utf8");
  assert.match(integrityMigration, /person_contact_active_primary_per_type_uq/);
  assert.match(integrityMigration, /pii_exact_active_work_email_unique/);
  assert.match(integrityMigration, /pg_advisory_xact_lock[\s\S]*protected-work-email:/);
  assert.match(integrityMigration, /pg_advisory_xact_lock[\s\S]*contact-primary:/);
  assert.match(integrityMigration, /person\.archived_at is null[\s\S]*for update/);
  assert.match(integrityMigration, /errcode = 'P1701'/);
  assert.match(integrityMigration, /contact_correction_revision/);
  assert.match(integrityMigration, /protected\.xmin::text/);
  assert.match(integrityMigration, /expected_contact_revision/);
  assert.match(integrityMigration, /lock_data_quality_correction_target/);
  const service = readFileSync(new URL("../src/lib/contact-corrections.ts", import.meta.url), "utf8");
  assert.match(service, /current_contact\.contact_method_id::uuid/);
});

test("database decision conflicts become controlled stale or uniqueness responses", async () => {
  const row = proposedRow();
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return [protectedState];
    if (sql.includes("contact-correction:resolve-review")) return [row];
    if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
    if (sql.includes("FROM local801.person_contact_methods")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };

  await assert.rejects(
    decideContactCorrection(context(), { handle: requestHandle, decision: "rejected" }, {
      env: environment(), query, runTransaction: async () => { throw { code: "P1701" }; },
    }),
    (error) => error instanceof ContactCorrectionError && error.code === "STALE_REQUEST" && error.status === 409,
  );
  await assert.rejects(
    decideContactCorrection(context(), { handle: requestHandle, decision: "approved", revision }, {
      env: environment(), keyConfig, query, runTransaction: async () => { throw { code: "23505" }; },
    }),
    (error) => error instanceof ContactCorrectionError && error.code === "CONTACT_CONFLICT" && error.status === 409,
  );
});
