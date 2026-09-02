import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("migration 0041 separates replaceable new-hire work from factual employment history", async () => {
  const migration = await readFile(new URL("../db/migrations/0041__replaceable_new_hire_work_queue.sql", import.meta.url), "utf8");
  assert.match(migration, /create table local801\.new_hire_roster_entries/);
  assert.match(migration, /primary key \(organization_id, person_id\)/);
  assert.match(migration, /where roster\.archived_at is null/);
  assert.match(migration, /create or replace view reporting\.new_hires/);
  assert.doesNotMatch(migration, /delete from local801\.employment_events|hire_date\s*=\s*null/i);
});

test("the New hires queue reads only active replacement-roster entries", async () => {
  const service = await readFile(new URL("../src/lib/new-hires.ts", import.meta.url), "utf8");
  assert.match(service, /JOIN local801\.new_hire_roster_entries roster/);
  assert.match(service, /roster\.archived_at IS NULL/);
});

test("migration 0043 gives the scoped runtime roles only the New hires access they need", async () => {
  const migration = await readFile(new URL("../db/migrations/0043__new_hire_roster_runtime_privileges.sql", import.meta.url), "utf8");
  assert.match(migration, /to_regrole\('local801_app'\)/);
  assert.match(migration, /grant select, insert, update on table local801\.new_hire_roster_entries to local801_app/);
  assert.match(migration, /grant select on table reporting\.new_hires to local801_app/);
  assert.match(migration, /grant select on table local801\.new_hire_roster_entries to local801_backup/);
  assert.match(migration, /grant select on table local801\.new_hire_roster_entries to local801_migrator/);
  assert.doesNotMatch(migration, /grant[^;]*delete[^;]*new_hire_roster_entries/i);
  assert.match(migration, /revoke all on table local801\.new_hire_roster_entries from public/);
});
