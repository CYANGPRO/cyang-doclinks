import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/0012__pii_protection_scaffolding.sql", import.meta.url);

test("Stage 14B2 migration is additive scaffolding only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /^begin;/i);
  assert.match(sql, /commit;\s*$/i);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+local801\./i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+local801\.(?:users|auth_identities|people|person_identifiers|person_contact_methods|contact_correction_requests|import_files|import_rows|push_subscriptions)\b/i);
});

test("Stage 14B2 creates protected companion tables for direct database PII", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "user_pii",
    "auth_identity_pii",
    "person_pii",
    "person_identifier_pii",
    "person_contact_method_pii",
    "contact_correction_request_pii",
    "import_file_pii",
    "import_row_pii",
    "push_subscription_pii",
  ]) assert.match(sql, new RegExp(`create table local801\\.${table}\\b`, "i"), table);

  assert.match(sql, /email_encrypted_payload text not null/i);
  assert.match(sql, /provider_subject_encrypted_payload text not null/i);
  assert.match(sql, /first_name_encrypted_payload text not null/i);
  assert.match(sql, /identifier_value_encrypted_payload text not null/i);
  assert.match(sql, /contact_value_encrypted_payload text not null/i);
  assert.match(sql, /original_filename_encrypted_payload text not null/i);
  assert.match(sql, /direct_pii_encrypted_payload text not null/i);
  assert.match(sql, /subscription_encrypted_payload text not null/i);
});

test("protected companion tables enforce organization-scoped foreign keys", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create unique index if not exists people_org_id_pii_uq[\s\S]*on local801\.people \(organization_id, id\)/i);
  assert.match(sql, /foreign key \(organization_id, person_id\)[\s\S]*references local801\.people \(organization_id, id\) on delete cascade/i);
  assert.match(sql, /foreign key \(organization_id, user_id\)[\s\S]*references local801\.users \(organization_id, id\) on delete cascade/i);
  assert.match(sql, /foreign key \(organization_id, import_row_id\)[\s\S]*references local801\.import_rows \(organization_id, id\) on delete cascade/i);
});

test("equality/search derivatives are keyed hashes with rotation versions and no raw token columns", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table local801\.pii_exact_indexes/);
  assert.match(sql, /index_key_version text not null/);
  assert.match(sql, /index_hash text not null check \(index_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /create table local801\.person_search_tokens/);
  assert.match(sql, /token_kind text not null check \(token_kind in \('word','prefix'\)\)/);
  assert.match(sql, /token_key_version text not null/);
  assert.match(sql, /token_hash text not null check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.doesNotMatch(sql, /\btoken_value\b|\bnormalized_name\b|\bnormalized_email\b/i);
});

test("protected import staging uses encrypted row bundle plus keyed integrity metadata", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table local801\.import_row_pii/);
  assert.match(sql, /direct_pii_field_set_version integer not null default 1/);
  assert.match(sql, /row_integrity_hash text not null check \(row_integrity_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /row_integrity_key_version text not null/);
  assert.doesNotMatch(sql, /first_name text|last_name text|work_email text|employee_identifier text|member_identifier text/i);
});

test("PII cutover state starts fail-safe and cannot claim protected reads before backfill completion", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table local801\.pii_protection_state/);
  assert.match(sql, /write_mode text not null default 'legacy'/);
  assert.match(sql, /backfill_state text not null default 'not_started'/);
  assert.match(sql, /protected_read_enabled_at is null or backfill_state = 'complete'/);
  assert.match(sql, /verified_at is null or \(backfill_state = 'complete' and protected_read_enabled_at is not null\)/);
});
