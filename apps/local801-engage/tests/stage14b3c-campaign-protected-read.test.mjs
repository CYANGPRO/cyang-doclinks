import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hydrateCampaignDetailFromProtectedPii } from "../src/lib/pii-protected-campaign-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const campaignHandle = "c".repeat(64);
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

function userHandle() {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function protectedPerson(keyConfig) {
  const first = envelope("Protected", "person", personId, "first-name", keyConfig);
  const last = envelope("Participant", "person", personId, "last-name", keyConfig);
  const preferred = envelope("Synthetic Campaign Person", "person", personId, "preferred-name", keyConfig);
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

function protectedUser(keyConfig) {
  const display = envelope("Synthetic CAT Lead", "user", userId, "display-name", keyConfig);
  return {
    user_id: userId,
    display_name_encrypted_payload: display.encryptedPayload,
    display_name_encryption_key_version: display.encryptionKeyVersion,
    display_name_encryption_format_version: display.encryptionFormatVersion,
  };
}

function legacyBundle() {
  return {
    population: {
      people: [{
        personHandle: personHandle(),
        first_name: "WRONG",
        last_name: "LEGACY",
        department: "Health Licensing",
        assignment_status: "open",
        assignee_name: "WRONG LEGACY ASSIGNEE",
        assignment_due_at: "2026-08-20T15:00:00.000Z",
      }],
      total: 1,
      hasNext: false,
      nextCursor: null,
      pageSize: 50,
      filters: { assignment: "all", workflow: "all" },
    },
    options: {
      assignees: [{ handle: userHandle(), label: "WRONG OPTION", detail: "cat_lead" }],
    },
    candidates: {
      term: "Synthetic",
      candidates: [{
        personHandle: personHandle(),
        displayName: "WRONG CANDIDATE",
        department: "Health Licensing",
        classification: "Clerical",
        workLocation: "Downtown",
      }],
    },
    organizerProgress: [{
      assigneeHandle: userHandle(),
      assigneeName: "WRONG PROGRESS NAME",
      assigned: 10,
      open: 6,
      completed: 4,
      overdue: 1,
    }],
  };
}

test("Campaign detail replaces participant, candidate, assignee, and option display PII with protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-campaign-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-campaign-read:users")) return [protectedUser(keyConfig)];
    if (sql.includes("pii-protected-campaign-read:latest-assignees")) return [{ person_id: personId, user_id: userId }];
    throw new Error("unexpected query");
  };

  const result = await hydrateCampaignDetailFromProtectedPii(
    organizationId,
    campaignHandle,
    legacyBundle(),
    { query, env: environment, keyConfig },
  );

  assert.equal(result.population.people[0].first_name, "Protected");
  assert.equal(result.population.people[0].last_name, "Participant");
  assert.equal(result.population.people[0].assignee_name, "Synthetic CAT Lead");
  assert.equal(result.options.assignees[0].label, "Synthetic CAT Lead");
  assert.equal(result.candidates.candidates[0].displayName, "Synthetic Campaign Person");
  assert.equal(result.organizerProgress[0].assigneeName, "Synthetic CAT Lead");
});

test("Campaign detail protected reads fail closed when a visible assignee companion is missing", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-campaign-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-campaign-read:users")) return [];
    if (sql.includes("pii-protected-campaign-read:latest-assignees")) return [{ person_id: personId, user_id: userId }];
    throw new Error("unexpected query");
  };

  await assert.rejects(
    hydrateCampaignDetailFromProtectedPii(organizationId, campaignHandle, legacyBundle(), { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});

test("Campaign protected-read adapter contains no database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-campaign-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});
