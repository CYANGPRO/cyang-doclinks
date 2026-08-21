import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hydrateFollowupQueueFromProtectedPii } from "../src/lib/pii-protected-followup-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const assignedUserId = "33333333-3333-4333-8333-333333333333";
const optionUserId = "44444444-4444-4444-8444-444444444444";
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

function userHandle(userId) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function protectedPerson(keyConfig) {
  const first = envelope("Protected", "person", personId, "first-name", keyConfig);
  const last = envelope("Person", "person", personId, "last-name", keyConfig);
  const preferred = envelope("Synthetic Avery", "person", personId, "preferred-name", keyConfig);
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

function protectedUser(userId, displayName, keyConfig) {
  const display = envelope(displayName, "user", userId, "display-name", keyConfig);
  return {
    user_id: userId,
    display_name_encrypted_payload: display.encryptedPayload,
    display_name_encryption_key_version: display.encryptionKeyVersion,
    display_name_encryption_format_version: display.encryptionFormatVersion,
  };
}

function queue() {
  return {
    items: [{
      employeeHandle: personHandle(),
      followupHandle: "a".repeat(64),
      displayName: "WRONG LEGACY PERSON",
      membershipStatus: "member",
      department: "Health Licensing",
      classification: "Clerical",
      workLocation: "Downtown",
      dueAt: new Date().toISOString(),
      completedAt: null,
      status: "open",
      bucket: "upcoming",
      assignedTo: "WRONG LEGACY ASSIGNEE",
      assignedToHandle: userHandle(assignedUserId),
      assigneeOptions: [
        { handle: userHandle(assignedUserId), label: "WRONG LEGACY ASSIGNEE" },
        { handle: userHandle(optionUserId), label: "WRONG LEGACY OPTION" },
      ],
      campaignName: "Synthetic Member Outreach",
      latestEngagementAt: null,
      latestOutcome: null,
      willingActionCount: 0,
      consideringActionCount: 0,
      completedActionCount: 0,
      declinesAllActions: false,
    }],
    term: "",
    requestedScope: "authorized",
    effectiveScope: "authorized",
    focus: "all",
    pageSize: 25,
    total: 1,
    nextCursor: null,
  };
}

test("Follow-ups replaces employee and organizer display PII with protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-followup-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-followup-read:users")) return [
      protectedUser(assignedUserId, "Synthetic CAT Member", keyConfig),
      protectedUser(optionUserId, "Synthetic CAT Lead", keyConfig),
    ];
    throw new Error("unexpected query");
  };

  const result = await hydrateFollowupQueueFromProtectedPii(organizationId, queue(), { query, env: environment, keyConfig });
  assert.equal(result.items[0].displayName, "Synthetic Avery");
  assert.equal(result.items[0].assignedTo, "Synthetic CAT Member");
  assert.deepEqual(result.items[0].assigneeOptions.map((item) => item.label), ["Synthetic CAT Member", "Synthetic CAT Lead"]);
});

test("Follow-ups protected reads fail closed when a visible companion is missing", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-followup-read:people")) return [];
    if (sql.includes("pii-protected-followup-read:users")) return [];
    throw new Error("unexpected query");
  };

  await assert.rejects(
    hydrateFollowupQueueFromProtectedPii(organizationId, queue(), { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});

test("Follow-ups protected-read adapter contains no database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-followup-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});