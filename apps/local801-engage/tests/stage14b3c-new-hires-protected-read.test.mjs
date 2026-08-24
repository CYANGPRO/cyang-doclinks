import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hydrateNewHireQueueFromProtectedPii } from "../src/lib/pii-protected-new-hire-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const primaryUserId = "44444444-4444-4444-8444-444444444444";
const backupUserId = "55555555-5555-4555-8555-555555555555";
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
  return encryptPiiField(plaintext, { organizationId, entity, recordId, field }, keyConfig);
}

function personHandle() {
  return createHash("sha256").update(`${organizationId}:${personId}`).digest("hex");
}

function protectedPerson(keyConfig) {
  const first = envelope("Protected", "person", personId, "first-name", keyConfig);
  const last = envelope("Hire", "person", personId, "last-name", keyConfig);
  const preferred = envelope("Synthetic New Hire", "person", personId, "preferred-name", keyConfig);
  return {
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
  };
}

function protectedContact(keyConfig) {
  const value = envelope("newhire.protected@example.test", "person-contact", contactId, "contact-value", keyConfig);
  return {
    person_id: personId,
    contact_type: "work_email",
    contact_method_id: contactId,
    contact_type: "work_email",
    contact_label: "work",
    contact_value_encrypted_payload: value.encryptedPayload,
    encryption_key_version: value.encryptionKeyVersion,
    encryption_format_version: value.encryptionFormatVersion,
  };
}

function protectedOrganizer(userId, name, role, keyConfig) {
  const value = envelope(name, "user", userId, "display-name", keyConfig);
  return {
    person_id: personId,
    assignment_role: role,
    user_id: userId,
    display_name_encrypted_payload: value.encryptedPayload,
    display_name_encryption_key_version: value.encryptionKeyVersion,
    display_name_encryption_format_version: value.encryptionFormatVersion,
  };
}

function legacyPage() {
  return {
    people: [{
      handle: personHandle(),
      employeeReference: "L801-100001",
      displayName: "WRONG LEGACY NAME",
      hireDate: "2026-08-01",
      daysSinceHire: 15,
      membershipStatus: "member",
      department: "Health Licensing",
      classification: "Clerical",
      workLocation: "Downtown",
      jobStatus: "Permanent",
      workEmail: "wrong.legacy@example.test",
      workPhone: null,
      assigned: true,
      primaryOrganizers: "WRONG PRIMARY",
      backupOrganizers: "WRONG BACKUP",
      latestEngagementAt: null,
      latestOutcome: null,
      openFollowupCount: 0,
      overdueFollowupCount: 0,
      nextFollowupAt: null,
      contactState: "never_engaged",
    }],
    term: "",
    assignment: "all",
    contact: "all",
    membershipStatus: "",
    daysWithin: null,
    pageSize: 25,
    total: 1,
    summary: { neverEngaged: 1, unassigned: 0, openFollowups: 0, members: 1 },
    nextCursor: null,
  };
}

test("New Hires replaces legacy person, contact, and organizer display PII with protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-new-hire-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-new-hire-read:contact-details")) return [protectedContact(keyConfig)];
    if (sql.includes("pii-protected-new-hire-read:organizers")) return [
      protectedOrganizer(primaryUserId, "Synthetic CAT Lead", "primary", keyConfig),
      protectedOrganizer(backupUserId, "Synthetic CAT Member", "backup", keyConfig),
    ];
    throw new Error("unexpected query");
  };

  const result = await hydrateNewHireQueueFromProtectedPii(organizationId, legacyPage(), { query, env: environment, keyConfig });
  assert.equal(result.people[0].displayName, "Synthetic New Hire");
  assert.equal(result.people[0].workEmail, "newhire.protected@example.test");
  assert.equal(result.people[0].primaryOrganizers, "Synthetic CAT Lead");
  assert.equal(result.people[0].backupOrganizers, "Synthetic CAT Member");
});

test("New Hires protected reads fail closed when a visible organizer companion is missing", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const missing = {
    person_id: personId,
    assignment_role: "primary",
    user_id: primaryUserId,
    display_name_encrypted_payload: null,
    display_name_encryption_key_version: null,
    display_name_encryption_format_version: null,
  };
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-new-hire-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-new-hire-read:contact-details")) return [protectedContact(keyConfig)];
    if (sql.includes("pii-protected-new-hire-read:organizers")) return [missing];
    throw new Error("unexpected query");
  };

  await assert.rejects(
    hydrateNewHireQueueFromProtectedPii(organizationId, legacyPage(), { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});

test("New Hires protected-read adapter contains no database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-new-hire-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});
