import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Stage 14B companion envelope metadata is strictly all-null or all-present", async () => {
  const sql = await readFile(new URL("../db/migrations/0013__pii_scaffolding_integrity.sql", import.meta.url), "utf8");
  assert.match(sql, /^begin;/i);
  assert.match(sql, /alter table local801\.person_pii/);
  assert.match(sql, /person_pii_preferred_name_envelope_complete_ck/);
  assert.match(sql, /preferred_name_encrypted_payload is null[\s\S]*preferred_name_encryption_key_version is null[\s\S]*preferred_name_encryption_format_version is null/);
  assert.match(sql, /preferred_name_encrypted_payload is not null[\s\S]*preferred_name_encryption_key_version is not null[\s\S]*preferred_name_encryption_format_version is not null/);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b|\bUPDATE\s+local801\.|\bDELETE\s+FROM\b|\bDROP\s+/i);
  assert.match(sql, /organization_id/);
  assert.match(sql, /commit;\s*$/i);
});
