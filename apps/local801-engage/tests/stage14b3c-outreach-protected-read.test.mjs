import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  hydrateEngagementFormOptionsFromProtectedPii,
  hydrateOutreachQueueFromProtectedPii,
  hydrateOutreachWorkspaceFromProtectedPii,
} from "../src/lib/pii-protected-outreach-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const viewerUserId = "22222222-2222-4222-8222-222222222222";
const assigneeUserId = "33333333-3333-4333-8333-333333333333";
const personId = "44444444-4444-4444-8444-444444444444";
const contactId = "55555555-5555-4555-8555-555555555555";
const followupId = "66666666-6666-4666-8666-666666666666";
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
  return createHash("sha256").update(`user:${organizationId}:${assigneeUserId}`).digest("hex");
}

function followupHandle() {
  return createHash("sha256").update(`followup:${organizationId}:${followupId}`).digest("hex");
}

function protectedPerson(keyConfig) {
  const first = envelope("Protected", "person", personId, "first-name", keyConfig);
  const last = envelope("Avery", "person", personId, "last-name", keyConfig);
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

function protectedContact(keyConfig) {
  const email = envelope("avery.protected@example.test", "person-contact", contactId, "contact-value", keyConfig);
  return {
    person_id: personId,
    contact_method_id: contactId,
    contact_value_encrypted_payload: email.encryptedPayload,
    encryption_key_version: email.encryptionKeyVersion,
    encryption_format_version: email.encryptionFormatVersion,
  };
}

function protectedUser(keyConfig) {
  const display = envelope("Synthetic Protected Organizer", "user", assigneeUserId, "display-name", keyConfig);
  return {
    user_id: assigneeUserId,
    display_name_encrypted_payload: display.encryptedPayload,
    display_name_encryption_key_version: display.encryptionKeyVersion,
    display_name_encryption_format_version: display.encryptionFormatVersion,
  };
}

test("My Outreach replaces legacy display PII with protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-outreach-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-outreach-read:work-email")) return [protectedContact(keyConfig)];
    throw new Error("unexpected query");
  };
  const page = {
    people: [{
      handle: personHandle(), displayName: "WRONG LEGACY NAME", membershipStatus: "member",
      department: "Health Licensing", classification: "Clerical", workLocation: "Downtown",
      workEmail: "wrong.legacy@example.test", assignmentRelationship: "authorized", priority: "recent",
      latestEngagementAt: null, latestOutcome: null, openFollowupCount: 0, overdueFollowupCount: 0,
      nextFollowupAt: null, willingActionCount: 0, consideringActionCount: 0, completedActionCount: 0,
      declinesAllActions: false,
    }],
    term: "Avery", requestedScope: "authorized", effectiveScope: "authorized", focus: "all",
    pageSize: 25, total: 1, previousCursor: null, nextCursor: null,
  };
  const result = await hydrateOutreachQueueFromProtectedPii(organizationId, viewerUserId, page, { query, env: environment, keyConfig });
  assert.equal(result.people[0].displayName, "Synthetic Avery");
  assert.equal(result.people[0].workEmail, "avery.protected@example.test");
});

test("employee workspace replaces person PII and follow-up assignee from protected companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const organizer = protectedUser(keyConfig);
  const calls = [];
  const query = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-outreach-read:people")) return [protectedPerson(keyConfig)];
    if (sql.includes("pii-protected-outreach-read:work-email")) return [protectedContact(keyConfig)];
    if (sql.includes("pii-protected-outreach-read:followup-assignees")) return [{
      followup_id: followupId,
      user_id: assigneeUserId,
      display_name_encrypted_payload: organizer.display_name_encrypted_payload,
      display_name_encryption_key_version: organizer.display_name_encryption_key_version,
      display_name_encryption_format_version: organizer.display_name_encryption_format_version,
    }];
    throw new Error("unexpected query");
  };
  const workspace = {
    handle: personHandle(), displayName: "WRONG LEGACY NAME", membershipStatus: "member",
    department: "Health Licensing", section: "Regulation", classification: "Clerical", workLocation: "Downtown",
    workEmail: "wrong.legacy@example.test", assignmentRelationship: "authorized", activeAssignmentCount: 1,
    campaignNames: ["Synthetic Member Outreach"], actionReadiness: { posture: "not_recorded", actions: [] },
    followups: [{ handle: followupHandle(), dueAt: new Date().toISOString(), assignee: "WRONG LEGACY ORGANIZER", overdue: false }],
    recentEngagements: [],
  };
  const result = await hydrateOutreachWorkspaceFromProtectedPii(organizationId, viewerUserId, workspace, { query, env: environment, keyConfig });
  assert.equal(result.displayName, "Synthetic Avery");
  assert.equal(result.workEmail, "avery.protected@example.test");
  assert.equal(result.followups[0].assignee, "Synthetic Protected Organizer");
  const personLookup = calls.find((call) => call.sql.includes("pii-protected-outreach-read:people"));
  const contactLookup = calls.find((call) => call.sql.includes("pii-protected-outreach-read:work-email"));
  assert.deepEqual(personLookup.parameters, [organizationId, [personHandle()]]);
  assert.deepEqual(contactLookup.parameters, [organizationId, viewerUserId, [personId]]);
  assert.match(personLookup.sql, /ANY\(\$2::text\[\]\)/);
  assert.match(contactLookup.sql, /contact\.person_id = ANY\(\$3::uuid\[\]\)/);
});

test("employee workspace remains handle-scoped when the organization exceeds 500 members", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql, parameters) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-outreach-read:people")) {
      assert.deepEqual(parameters, [organizationId, [personHandle()]]);
      return [protectedPerson(keyConfig)];
    }
    if (sql.includes("pii-protected-outreach-read:work-email")) {
      assert.deepEqual(parameters, [organizationId, viewerUserId, [personId]]);
      return [protectedContact(keyConfig)];
    }
    if (sql.includes("pii-protected-outreach-read:followup-assignees")) return [];
    throw new Error("unexpected query");
  };
  const workspace = {
    handle: personHandle(), displayName: "WRONG", membershipStatus: "member",
    department: null, section: null, classification: null, workLocation: null,
    workEmail: "wrong@example.test", assignmentRelationship: "authorized", activeAssignmentCount: 0,
    campaignNames: [], actionReadiness: { posture: "not_recorded", actions: [] }, followups: [], recentEngagements: [],
  };
  const result = await hydrateOutreachWorkspaceFromProtectedPii(organizationId, viewerUserId, workspace, { query, env: environment, keyConfig });
  assert.equal(result.displayName, "Synthetic Avery");
});

test("engagement recorder assignee labels come from protected user companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-outreach-read:assignee-options")) return [protectedUser(keyConfig)];
    throw new Error("unexpected query");
  };
  const options = {
    assignments: [],
    assignees: [{ handle: userHandle(), label: "WRONG LEGACY ORGANIZER", current: false }],
    actionDefinitions: [],
  };
  const result = await hydrateEngagementFormOptionsFromProtectedPii(organizationId, options, { query, env: environment, keyConfig });
  assert.equal(result.assignees[0].label, "Synthetic Protected Organizer");
});

test("outreach protected reads fail closed when a visible legacy PII companion is missing", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-outreach-read:people")) return [];
    if (sql.includes("pii-protected-outreach-read:work-email")) return [];
    throw new Error("unexpected query");
  };
  const page = {
    people: [{
      handle: personHandle(), displayName: "LEGACY NAME", membershipStatus: "member",
      department: null, classification: null, workLocation: null, workEmail: "legacy@example.test",
      assignmentRelationship: "authorized", priority: "recent", latestEngagementAt: null, latestOutcome: null,
      openFollowupCount: 0, overdueFollowupCount: 0, nextFollowupAt: null, willingActionCount: 0,
      consideringActionCount: 0, completedActionCount: 0, declinesAllActions: false,
    }],
    term: "", requestedScope: "authorized", effectiveScope: "authorized", focus: "all",
    pageSize: 25, total: 1, previousCursor: null, nextCursor: null,
  };
  await assert.rejects(
    hydrateOutreachQueueFromProtectedPii(organizationId, viewerUserId, page, { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});

test("outreach protected-read adapter contains no database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-outreach-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});
