import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("protected-mode constraints are deferred and remain inactive during dual-write acceptance", async () => {
  const migration = await readFile(new URL("../db/migrations/0016__protected_pii_commit_constraints.sql", import.meta.url), "utf8");
  assert.match(migration, /write_mode = 'protected'/);
  assert.match(migration, /deferrable initially deferred/gi);
  assert.match(migration, /protected user PII companion required/);
  assert.match(migration, /protected person PII companion required/);
  assert.match(migration, /protected import-row companion v2 required/);
  assert.match(migration, /direct PII is forbidden in protected import normalized_json/);
  assert.match(migration, /protected push endpoint blind index required/);
  assert.doesNotMatch(migration, /drop\s+(column|table)/i);
});

test("synthetic cutover tool is explicitly guarded and never auto-enables application production flags", async () => {
  const script = await readFile(new URL("../scripts/cutover-pii-protected-preview.mjs", import.meta.url), "utf8");
  assert.match(script, /LOCAL801_PII_CUTOVER_ENABLED/);
  assert.match(script, /I_HAVE_VERIFIED_PROTECTED_PII/);
  assert.match(script, /Production launch must remain disabled/);
  assert.match(script, /Authoritative import execution must remain disabled/);
  assert.match(script, /Dual-write must be disabled/);
  assert.match(script, /write_mode = 'protected'/);
  assert.match(script, /protected_read_enabled_at = now\(\)/);
  assert.match(script, /protected_write_enabled_at = now\(\)/);
  assert.match(script, /verified_at = now\(\)/);
  assert.doesNotMatch(script, /LOCAL801_PRODUCTION_LAUNCH_ENABLED\s*=\s*["']?1/);
  assert.doesNotMatch(script, /LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED\s*=\s*["']?1/);
  assert.doesNotMatch(script, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED\s*=\s*["']?1/);
});

test("cutover scrub removes direct import PII and replaces legacy direct identifiers with opaque placeholders", async () => {
  const script = await readFile(new URL("../scripts/cutover-pii-protected-preview.mjs", import.meta.url), "utf8");
  assert.match(script, /normalized_json = normalized_json - ARRAY/);
  assert.match(script, /row_hash = protected\.row_integrity_hash/);
  assert.match(script, /email = 'protected-' \|\| id::text \|\| '@invalid\.local'/);
  assert.match(script, /identifier_value = 'protected:' \|\| id::text/);
  assert.match(script, /provider_subject = 'protected:' \|\| id::text/);
  assert.match(script, /original_filename = 'protected-' \|\| id::text \|\| '\.upload'/);
  assert.match(script, /Protected PII coverage mismatch/);
  assert.match(script, /Protected blind-index coverage is incomplete/);
  assert.match(script, /Legacy direct-PII scrub verification failed/);
});
