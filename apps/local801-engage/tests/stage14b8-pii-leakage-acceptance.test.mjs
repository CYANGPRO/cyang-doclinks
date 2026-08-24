import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const forbiddenAuditKeys = [
  "firstName", "lastName", "preferredName", "displayName", "email", "workEmail",
  "employeeIdentifier", "memberIdentifier", "contactValue", "providerSubject", "subscriptionJson",
];

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("production JWT/session state contains only opaque Local 801 account state", async () => {
  const [options, types] = await Promise.all([
    source("../src/lib/auth-options.ts"),
    source("../src/types/next-auth.d.ts"),
  ]);
  assert.match(options, /delete token\.email/);
  assert.match(options, /delete token\.name/);
  assert.match(options, /delete token\.picture/);
  assert.match(options, /session\.user = undefined/);
  assert.doesNotMatch(types, /\bemail\s*:/);
  assert.doesNotMatch(types, /\bname\s*:/);
  assert.match(types, /organizationSlug: string/);
  assert.match(types, /userId: string/);
  assert.match(types, /sessionVersion: number/);
});

test("protected import staging and authoritative preparation never persist direct raw values", async () => {
  const [preparation, migration] = await Promise.all([
    source("../src/lib/pii-protected-import-execution.ts"),
    source("../db/migrations/0015__protected_import_execution_staging.sql"),
  ]);
  assert.match(preparation, /operationalOnly/);
  assert.match(preparation, /DIRECT_IMPORT_PII_FIELDS/);
  assert.match(preparation, /person_protected_json/);
  assert.match(preparation, /identifier_protected_json/);
  assert.match(preparation, /contact_protected_json/);
  assert.match(migration, /operational_json jsonb not null/);
  assert.doesNotMatch(migration, /\b(first_name|last_name|preferred_name|work_email|personal_email|employee_identifier|member_identifier)\s+text\b/i);
});

test("protected reports decrypt organizer display names only in the authorized server adapter", async () => {
  const report = await source("../src/lib/pii-protected-report-read.ts");
  assert.match(report, /import "server-only"/);
  assert.match(report, /decryptPiiField/);
  assert.match(report, /user_pii/);
  assert.doesNotMatch(report, /app_user\.display_name/);
  assert.doesNotMatch(report, /app_user\.email/);
});

test("new Stage 14B audit payloads remain opaque metadata only", async () => {
  const files = [
    "../src/lib/pii-protected-import-review.ts",
    "../src/lib/pii-protected-import-execution.ts",
    "../src/lib/pii-protected-production-auth.ts",
    "../src/lib/pii-protected-write.ts",
  ];
  const combined = (await Promise.all(files.map(source))).join("\n");
  for (const key of forbiddenAuditKeys) {
    const pattern = new RegExp(`payload\\s*:\\s*\\{[^}]*\\b${key}\\s*:`, "is");
    assert.doesNotMatch(combined, pattern, key);
  }
  assert.doesNotMatch(combined, /console\.(?:log|error)\([^\n]*(?:email|firstName|lastName|identifier|contactValue|providerSubject)/i);
});

test("cutover constraints prohibit plaintext direct PII from returning to import JSON", async () => {
  const migration = await source("../db/migrations/0031__protected_import_personal_email.sql");
  for (const key of ["first_name", "last_name", "preferred_name", "work_email", "personal_email", "employee_identifier", "member_identifier"]) {
    assert.match(migration, new RegExp(key));
  }
  assert.match(migration, /direct PII is forbidden in protected import normalized_json/);
});
