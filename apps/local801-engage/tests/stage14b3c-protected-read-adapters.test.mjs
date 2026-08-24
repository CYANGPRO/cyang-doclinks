import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  hydrateDirectoryPageFromProtectedPii,
  hydrateTeamAccessPageFromProtectedPii,
  isPreviewProtectedPiiReadEnabled,
} from "../src/lib/pii-protected-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const contactId = "44444444-4444-4444-8444-444444444444";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const blindKey = Buffer.alloc(32, 9).toString("base64");

function env(overrides = {}) {
  return {
    VERCEL_ENV: "preview",
    LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "1",
    LOCAL801_PII_DUAL_WRITE_ENABLED: "1",
    LOCAL801_PII_BACKFILL_ENABLED: "0",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: encryptionKey }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: blindKey }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
    ...overrides,
  };
}

function state() {
  return [{
    write_mode: "dual",
    backfill_state: "complete",
    backfill_completed_at: new Date().toISOString(),
    protected_read_enabled_at: null,
    protected_write_enabled_at: null,
    verified_at: null,
  }];
}

function envelope(plaintext, entity, recordId, field, keyConfig) {
  const value = encryptPiiField(plaintext, { organizationId, entity, recordId, field }, keyConfig);
  return value;
}

function teamHandle() {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function personHandle() {
  return createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
}

test("protected-read Preview gate is fail closed outside Preview and while cutover gates conflict", () => {
  assert.equal(isPreviewProtectedPiiReadEnabled(env({ LOCAL801_PII_PROTECTED_READ_PREVIEW_ENABLED: "0" })), false);
  assert.throws(() => isPreviewProtectedPiiReadEnabled(env({ VERCEL_ENV: "production" })), /Vercel Preview environment/);
  assert.throws(() => isPreviewProtectedPiiReadEnabled(env({ LOCAL801_PII_DUAL_WRITE_ENABLED: "0" })), /dual-write/);
  assert.throws(() => isPreviewProtectedPiiReadEnabled(env({ LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1" })), /protected-only/);
});

test("Team & Access renders email and display name from protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const email = envelope("protected.user@example.test", "user", userId, "email", keyConfig);
  const display = envelope("Protected User", "user", userId, "display-name", keyConfig);
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-read:team-users")) return [{
      user_id: userId,
      email_encrypted_payload: email.encryptedPayload,
      email_encryption_key_version: email.encryptionKeyVersion,
      email_encryption_format_version: email.encryptionFormatVersion,
      display_name_encrypted_payload: display.encryptedPayload,
      display_name_encryption_key_version: display.encryptionKeyVersion,
      display_name_encryption_format_version: display.encryptionFormatVersion,
    }];
    throw new Error("unexpected query");
  };

  const page = {
    members: [{
      handle: teamHandle(),
      displayName: "WRONG LEGACY NAME",
      email: "wrong.legacy@example.test",
      role: "cat_member",
      active: true,
      invitedAt: null,
      lastAuthenticatedAt: null,
      lastMfaAt: null,
      identityLinked: false,
    }],
    assignableRoles: ["cat_member"],
  };
  const result = await hydrateTeamAccessPageFromProtectedPii(organizationId, page, { query, env: environment, keyConfig });
  assert.equal(result.members[0].displayName, "Protected User");
  assert.equal(result.members[0].email, "protected.user@example.test");
  assert.equal(calls.length, 2);
});

test("Directory renders names and authorized work email from protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const first = envelope("Protected", "person", personId, "first-name", keyConfig);
  const last = envelope("Person", "person", personId, "last-name", keyConfig);
  const preferred = envelope("Protected Preferred", "person", personId, "preferred-name", keyConfig);
  const workEmail = envelope("protected.person@example.test", "person-contact", contactId, "contact-value", keyConfig);
  const directoryQueries = [];
  const query = async (sql, parameters) => {
    directoryQueries.push({ sql, parameters });
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-read:directory-people")) return [{
      person_id: personId,
      first_name_encrypted_payload: first.encryptedPayload,
      first_name_encryption_key_version: first.encryptionKeyVersion,
      first_name_encryption_format_version: first.encryptionFormatVersion,
      last_name_encrypted_payload: last.encryptedPayload,
      last_name_encryption_key_version: last.encryptionKeyVersion,
      last_name_encryption_format_version: last.encryptionFormatVersion,
      preferred_name_encrypted_payload: preferred.encryptedPayload,
      preferred_name_encryption_key_version: preferred.encryptionKeyVersion,
      preferred_name_encryption_format_version: preferred.encryptionFormatVersion,
    }];
    if (sql.includes("pii-protected-read:directory-work-email")) return [{
      person_id: personId,
      contact_method_id: contactId,
      contact_value_encrypted_payload: workEmail.encryptedPayload,
      encryption_key_version: workEmail.encryptionKeyVersion,
      encryption_format_version: workEmail.encryptionFormatVersion,
    }];
    throw new Error("unexpected query");
  };

  const page = {
    people: [{
      handle: personHandle(),
      employeeReference: "L801-100001",
      displayName: "WRONG LEGACY NAME",
      firstName: "Wrong",
      lastName: "Legacy",
      membershipStatus: "member",
      department: "Test",
      section: null,
      classification: "Tester",
      workLocation: "Test",
      workEmail: "wrong.legacy@example.test",
      workPhone: null,
    }],
    term: "",
    pageSize: 50,
    total: 1,
    previousCursor: null,
    nextCursor: null,
    requestedScope: "authorized",
    effectiveScope: "authorized",
    filters: { membershipStatus: "", department: "", classification: "", workLocation: "" },
  };
  const result = await hydrateDirectoryPageFromProtectedPii(organizationId, page, { query, env: environment, keyConfig });
  assert.equal(result.people[0].firstName, "Protected");
  assert.equal(result.people[0].lastName, "Person");
  assert.equal(result.people[0].displayName, "Protected Person");
  assert.equal(result.people[0].workEmail, "protected.person@example.test");
  const peopleQuery = directoryQueries.find((entry) => entry.sql.includes("pii-protected-read:directory-people"));
  const contactQuery = directoryQueries.find((entry) => entry.sql.includes("pii-protected-read:directory-work-email"));
  assert.deepEqual(peopleQuery.parameters, [organizationId, [personHandle()]]);
  assert.deepEqual(contactQuery.parameters, [organizationId, false, [personId]]);
  assert.match(peopleQuery.sql, /digest\(concat\(\$1::uuid::text, ':', person_id::text\)/);
  assert.match(contactQuery.sql, /contact\.person_id = ANY\(\$3::uuid\[\]\)/);
});

test("protected-read adapters contain no PII database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});
