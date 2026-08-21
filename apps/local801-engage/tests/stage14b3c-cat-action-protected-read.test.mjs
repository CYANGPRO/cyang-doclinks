import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hydrateCatActionDetailFromProtectedPii } from "../src/lib/pii-protected-cat-action-read.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const actionHandle = "a".repeat(64);
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

function envelope(plaintext, recordId, field, keyConfig) {
  return encryptPiiField(plaintext, { organizationId, entity: "user", recordId, field }, keyConfig);
}

function userHandle() {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function taskHandle() {
  return createHash("sha256").update(`cat-action-task:${organizationId}:${taskId}`).digest("hex");
}

function protectedUser(keyConfig) {
  const display = envelope("Synthetic CAT Lead", userId, "display-name", keyConfig);
  return {
    user_id: userId,
    display_name_encrypted_payload: display.encryptedPayload,
    display_name_encryption_key_version: display.encryptionKeyVersion,
    display_name_encryption_format_version: display.encryptionFormatVersion,
  };
}

function legacyBundle() {
  return {
    tasks: {
      tasks: [{
        handle: taskHandle(),
        title: "Synthetic task",
        status: "open",
        assigneeName: "WRONG LEGACY ASSIGNEE",
        assigneeActive: true,
        dueAt: "2026-08-20T15:00:00.000Z",
        createdAt: "2026-08-16T12:00:00.000Z",
        overdue: false,
      }],
      term: "",
      status: "",
      pageSize: 25,
      total: 1,
      summary: { open: 1, complete: 0, overdue: 0, unassigned: 0 },
      nextCursor: null,
    },
    options: {
      contractCycles: [],
      assignees: [{ handle: userHandle(), label: "WRONG OPTION", detail: "cat_lead" }],
    },
  };
}

test("CAT Action detail replaces task and organizer option display PII with protected user companions", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-cat-action-read:users")) return [protectedUser(keyConfig)];
    if (sql.includes("pii-protected-cat-action-read:task-assignees")) return [{ task_handle: taskHandle(), user_id: userId }];
    throw new Error("unexpected query");
  };

  const result = await hydrateCatActionDetailFromProtectedPii(
    organizationId,
    actionHandle,
    legacyBundle(),
    { query, env: environment, keyConfig },
  );

  assert.equal(result.tasks.tasks[0].assigneeName, "Synthetic CAT Lead");
  assert.equal(result.options.assignees[0].label, "Synthetic CAT Lead");
});

test("CAT Action protected reads fail closed when a visible task assignee companion is missing", async () => {
  const environment = env();
  const keyConfig = getPiiKeyConfiguration(environment);
  const query = async (sql) => {
    if (sql.includes("pii-protected-read:acceptance-state")) return state();
    if (sql.includes("pii-protected-cat-action-read:users")) return [];
    if (sql.includes("pii-protected-cat-action-read:task-assignees")) return [{ task_handle: taskHandle(), user_id: userId }];
    throw new Error("unexpected query");
  };

  await assert.rejects(
    hydrateCatActionDetailFromProtectedPii(organizationId, actionHandle, legacyBundle(), { query, env: environment, keyConfig }),
    /missing its protected PII companion/i,
  );
});

test("CAT Action protected-read adapter contains no database mutation statements", async () => {
  const source = await readFile(new URL("../src/lib/pii-protected-cat-action-read.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
});

test("CAT Action detail page wires the protected PII adapter and badge", async () => {
  const source = await readFile(new URL("../src/app/cat-actions/[actionHandle]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /hydrateCatActionDetailFromProtectedPii/);
  assert.match(source, /Protected PII/);
});
