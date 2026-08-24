import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(new URL("../src/lib/import-review-explanations.ts", import.meta.url), "utf8");
const table = readFileSync(new URL("../src/components/ImportReviewDetailTable.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8");

test("import explanations depend on protected classification facts only", () => {
  assert.match(service, /import \{ PROTECTED_IMPORT_REVIEW_CLASSIFICATION_CTE \} from "\.\/pii-protected-import-classification\.ts"/);
  assert.match(service, /import type \{ ImportReviewActor, ImportReviewCategory \} from "\.\/import-review\.ts"/);
  assert.match(service, /if \(coordinates\.length === 0 \|\| !isPiiProtectedReadEnabled\(\)\) return \[\];/);
  assert.doesNotMatch(service, /normalized_json ->> 'first_name'/);
  assert.doesNotMatch(service, /normalized_json ->> 'last_name'/);
  assert.doesNotMatch(service, /normalized_json ->> 'work_email'/);
});

test("protected explanations reveal field names and safe reasons, not old/new direct PII values", () => {
  for (const field of ["First name", "Last name", "Preferred name", "Work email", "Employee identifier", "Member identifier"]) {
    assert.match(service, new RegExp(field));
  }
  assert.match(service, /One or more supplied direct identity fields failed validation\./);
  assert.match(service, /More than one existing person matches the authoritative identity evidence\./);
  assert.match(service, /No exact authoritative identity match was found\./);
  assert.doesNotMatch(service, /existing_first_name|existing_last_name|existing_work_email/);
  assert.doesNotMatch(service, /ciphertext|nonce|auth_tag/);
});

test("review detail renders a Why column and falls back safely if explanations are unavailable", () => {
  assert.match(table, /headers=\{\["Source", "Person", "Work", "Status", "Why"\]\}/);
  assert.match(table, /Explanations are assistive only\. The existing protected review classification remains authoritative\./);
  assert.match(table, /Changed fields: \$\{explanation\.changeFields\.join\(", "\)\}/);
  assert.match(page, /<ImportReviewDetailTable batchId=\{batchId\} detail=\{detail\} \/>/);
});
