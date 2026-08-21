import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../scripts/verify-pii-protected-preview.mjs", import.meta.url), "utf8");

test("protected PII reconciliation is explicitly read only and fail closed", () => {
  assert.match(source, /SET TRANSACTION READ ONLY/);
  assert.match(source, /backfill_state !== "complete"/);
  assert.match(source, /protected_read_enabled_at \|\| state\.protected_write_enabled_at/);
  assert.match(source, /decryptPiiField/);
  assert.match(source, /createPiiIntegrityHash/);
  assert.match(source, /buildSyntheticPiiBackfillPlan/);
  assert.match(source, /databaseMutations: 0/);
  assert.match(source, /Protected PII reconciliation passed; no database rows were changed\./);

  assert.doesNotMatch(source, /\binsert\s+into\s+local801\./i);
  assert.doesNotMatch(source, /\bupdate\s+local801\./i);
  assert.doesNotMatch(source, /\bdelete\s+from\s+local801\./i);
  assert.doesNotMatch(source, /\btruncate\s+local801\./i);
  assert.doesNotMatch(source, /\balter\s+table\s+local801\./i);
});

test("protected PII reconciliation reports counts and mismatch totals, not plaintext values", () => {
  assert.match(source, /sourceCounts:/);
  assert.match(source, /protectedCounts:/);
  assert.match(source, /recordMismatches/);
  assert.match(source, /derivativeMismatches/);
  assert.match(source, /totalMismatches/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(source\.email|source\.display_name|source\.first_name|source\.last_name|source\.identifier_value|source\.contact_value|source\.original_filename)/);
});
