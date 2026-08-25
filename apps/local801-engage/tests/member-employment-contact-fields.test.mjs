import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(relative) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("migration 0018 adds reportable employment facts and labeled protected contacts", async () => {
  const migration = await text("../db/migrations/0018__member_contact_and_employment_fields.sql");
  assert.match(migration, /add column if not exists hire_date date/);
  assert.match(migration, /add column if not exists job_status text/);
  assert.match(migration, /add column if not exists contact_label text/);
  assert.match(migration, /direct_pii_field_set_version >= 3[\s\S]*between 0 and 1023/i);
  assert.match(migration, /reporting\.membership_by_job_status/);
  assert.match(migration, /create or replace view reporting\.new_hires/);
});

test("summary views omit job status and personal contacts while the protected contact screen retains them", async () => {
  const [directory, newHires, contact, uploadRoute] = await Promise.all([
    text("../src/app/directory/page.tsx"),
    text("../src/app/new-hires/page.tsx"),
    text("../src/app/outreach/[handle]/contact/page.tsx"),
    text("../src/app/api/imports/validate/route.ts"),
  ]);
  for (const source of [directory, newHires]) {
    for (const label of ["Hire Date", "Work", "Contact"]) {
      assert.match(source, new RegExp(label));
    }
    assert.doesNotMatch(source, /Job Status|person\.jobStatus/);
    assert.doesNotMatch(source, /person\.(?:cellPhone|homePhone|homeEmail)/);
  }
  for (const label of ["Cell phone", "Home phone", "Home email"]) {
    assert.match(contact, new RegExp(label));
  }
  for (const header of ["MAPE Hire Date", "Appointment Employment Status Name", "Work Phone", "Cell Phone", "Home Phone", "Home Email"]) {
    assert.match(uploadRoute, new RegExp(header));
  }
});

test("protected authoritative apply persists employment facts and labeled contact companions", async () => {
  const source = await text("../src/lib/pii-protected-import-apply.ts");
  assert.match(source, /hire_date = COALESCE/);
  assert.match(source, /job_status = COALESCE/);
  assert.match(source, /contact\.contact_label IS NOT DISTINCT FROM candidate\.contact_label/);
  assert.match(source, /INSERT INTO local801\.person_contact_method_pii/);
  for (const field of ["home_email", "work_phone", "cell_phone", "home_phone"]) {
    assert.doesNotMatch(source, new RegExp(`operational_json\\s*->>\\s*['\"]${field}['\"]`, "i"));
  }
});
