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

test("migration 0044 preserves employee history and rebuilds New hires from roster snapshots", async () => {
  const migration = await readFile(new URL("../db/migrations/0044__durable_employee_history_and_roster_new_hires.sql", import.meta.url), "utf8");
  assert.match(migration, /before delete on local801\.people/i);
  assert.match(migration, /Employee records must be archived and cannot be deleted/);
  assert.match(migration, /person\.hire_date > coalesce\(prior\.snapshot_date, latest\.snapshot_date - 30\)/i);
  assert.match(migration, /person\.hire_date <= latest\.snapshot_date/i);
  assert.match(migration, /not exists \([\s\S]*previous_row\.snapshot_id = prior\.id[\s\S]*previous_row\.person_id = current_row\.person_id/i);
  assert.match(migration, /update local801\.new_hire_roster_entries roster[\s\S]*set archived_at = now\(\)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+local801\.people/i);
});

test("current-roster execution derives and replaces the New hires cohort in both apply paths", async () => {
  for (const relativePath of ["../src/lib/import-execution.ts", "../src/lib/pii-protected-import-apply.ts"]) {
    const service = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(service, /current_roster_new_hires AS MATERIALIZED/i);
    assert.match(service, /batch\.import_kind = 'current_roster'/);
    assert.match(service, /snapshot_date - INTERVAL '30 days'/i);
    assert.match(service, /previous_row\.person_id = (?:target|mutation)\.target_person_id/);
    assert.match(service, /batch\.import_kind IN \('current_roster','new_hires','recent_hires'\)/);
  }
});
