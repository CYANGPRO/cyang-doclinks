import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSyntheticPiiBackfillPlan, MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY } from "../src/lib/pii-backfill.ts";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const org = "11111111-1111-4111-8111-111111111111";
const ids = {
  user: "22222222-2222-4222-8222-222222222222",
  person: "33333333-3333-4333-8333-333333333333",
  identifier: "44444444-4444-4444-8444-444444444444",
  contact: "55555555-5555-4555-8555-555555555555",
  correction: "66666666-6666-4666-8666-666666666666",
  file: "77777777-7777-4777-8777-777777777777",
  row: "88888888-8888-4888-8888-888888888888",
};

function config() {
  return getPiiKeyConfiguration({
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 31).toString("base64") }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 47).toString("base64") }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  });
}

function dataset() {
  return {
    users: [{ id: ids.user, organization_id: org, email: "synthetic.owner@example.test", display_name: "Synthetic Owner" }],
    authIdentities: [],
    people: [{ id: ids.person, organization_id: org, first_name: "Synthetic", last_name: "Avery", preferred_name: "Avery" }],
    identifiers: [{ id: ids.identifier, organization_id: org, identifier_type: "employee_id", identifier_value: "SYN-1001" }],
    contacts: [{ id: ids.contact, organization_id: org, contact_type: "work_email", contact_value: "avery@example.test" }],
    corrections: [{ id: ids.correction, organization_id: org, proposed_value: "new.synthetic@example.test" }],
    importFiles: [{ id: ids.file, organization_id: org, original_filename: "synthetic-roster.csv" }],
    importRows: [{ id: ids.row, organization_id: org, normalized_json: { first_name: "Synthetic", last_name: "Avery", work_email: "avery@example.test", department: "Health Licensing" } }],
    pushSubscriptions: [],
  };
}

test("synthetic PII backfill planner creates encrypted companions and keyed derivatives without plaintext payloads", () => {
  const plan = buildSyntheticPiiBackfillPlan(dataset(), config());
  assert.equal(plan.users.length, 1);
  assert.equal(plan.people.length, 1);
  assert.equal(plan.identifiers.length, 1);
  assert.equal(plan.contacts.length, 1);
  assert.equal(plan.importFiles.length, 1);
  assert.equal(plan.importRows.length, 1);
  assert.ok(plan.exactIndexes.length >= 8);
  assert.ok(plan.searchTokens.length > 0);
  const serialized = JSON.stringify(plan);
  for (const raw of ["synthetic.owner@example.test", "Synthetic Owner", "SYN-1001", "avery@example.test", "synthetic-roster.csv"]) {
    assert.equal(serialized.includes(raw), false, raw);
  }
  assert.match(serialized, /p1\./);
  assert.match(serialized, /[0-9a-f]{64}/);
});

test("synthetic PII backfill planner rejects mixed organizations and unbounded datasets", () => {
  const mixed = dataset();
  mixed.people = [{ ...mixed.people[0], organization_id: "99999999-9999-4999-8999-999999999999" }];
  assert.throws(() => buildSyntheticPiiBackfillPlan(mixed, config()), /exactly one organization/i);

  const oversized = dataset();
  oversized.authIdentities = Array.from({ length: MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY + 1 }, (_, index) => ({
    id: `${String(index % 10).repeat(8)}-1111-4111-8111-${String(index % 10).repeat(12)}`,
    organization_id: org,
    provider_subject: `sub-${index}`,
    linked_email: `user${index}@example.test`,
  }));
  assert.throws(() => buildSyntheticPiiBackfillPlan(oversized, config()), /bounded-row limit/i);
});

test("runtime backfill command is dry-run by default and apply is separately gated", async () => {
  const script = await readFile(new URL("../scripts/backfill-pii-preview.mjs", import.meta.url), "utf8");
  assert.match(script, /const apply = process\.argv\.includes\("--apply"\)/);
  assert.match(script, /LOCAL801_PII_BACKFILL_ENABLED !== "1"/);
  assert.match(script, /LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"/);
  assert.match(script, /VERCEL_ENV === "production"/);
  assert.match(script, /LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1"/);
  assert.match(script, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/);
  assert.match(script, /slug === "local801-preview"/);
  assert.match(script, /protected_read_enabled_at/);
  assert.match(script, /Dry run only: no database rows were changed/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(email|display_name|identifier_value|contact_value|normalized_json|original_filename)/i);
});
