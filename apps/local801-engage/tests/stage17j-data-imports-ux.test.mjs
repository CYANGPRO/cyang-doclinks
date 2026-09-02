import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const page = source("src/app/imports/page.tsx");
const form = source("src/components/ImportPreviewForm.tsx");

test("Data Imports keeps its existing authorization and protected-PII read boundary", () => {
  assert.match(page, /can\(user\.role, "manageImports"\)/);
  assert.match(page, /<ProtectedPage permission="manageImports">/);
  assert.match(page, /getImportBatchesPage/);
  assert.match(page, /hydrateImportBatchQueueFromProtectedPii/);
  assert.match(page, /getPiiProtectedReadMode/);
  assert.match(page, /resolveWorkspaceContext/);
});

test("Data Imports puts its focused upload at the top", () => {
  const uploadIndex = page.indexOf("<ImportPreviewForm previewMode={user.authentication === \"preview\"} />");
  const historyIndex = page.indexOf('title="Import history"');
  assert.ok(uploadIndex >= 0, "Upload form should be present.");
  assert.ok(historyIndex >= 0, "Import history should be present.");
  assert.ok(uploadIndex < historyIndex, "The upload workflow should appear before recent import history.");
  assert.match(page, /<DisclosureCard[\s\S]*title="Start a new import"[\s\S]*<ImportPreviewForm previewMode=\{user\.authentication === "preview"\} \/>/);
});

test("import history uses one clear row status and a single protected-data indicator", () => {
  assert.match(page, /Protected PII/);
  assert.doesNotMatch(page, /Protected PII ·/);
  assert.doesNotMatch(page, /Protected-read Preview ·/);
  assert.match(page, /headers=\{\["File", "Type", "Rows", "Status"\]\}/);
  assert.match(page, /processing_stage === "failed"\) return "Needs attention"/);
  assert.match(page, /state === "validated"\) return "Ready to review"/);
  assert.match(page, /state === "approved"\) return "Approved"/);
  assert.match(page, /item\.error_count > 0 \? <div className="muted">/);
  assert.match(page, /importedAtLabel\(item\.created_at\)/);
  assert.match(page, /importProcessingSafeFailureMessage\(item\.processing_error_code\)/);
});

test("upload form keeps import semantics while hiding legacy processing under Preview test options", () => {
  assert.match(form, /title="Upload data"/);
  assert.match(form, /requires review before any roster changes can be applied/);
  assert.match(form, /Preview workspace · generated test files only/);
  assert.match(form, /Authorized Local 801 files/);
  assert.match(form, /previewMode \? <details className="inline-disclosure import-preview-options">[\s\S]*<summary>Preview test options<\/summary>[\s\S]*name="processingMode"/);
  assert.match(form, /<input name="processingMode" type="hidden" value="durable" \/>/);
  assert.match(form, /defaultValue="durable"/);
  assert.match(form, /<option value="durable">Secure background processing<\/option>/);
  assert.match(form, /<option value="synchronous">Legacy fallback · pre-cutover only<\/option>/);

  for (const kind of ["current_roster", "new_hires"]) {
    assert.match(form, new RegExp(`<option value="${kind}">`));
  }
  for (const removedKind of ["recent_hires", "membership_additions", "membership_drops", "legacy_cat"]) {
    assert.doesNotMatch(form, new RegExp(`<option value="${removedKind}">`));
  }

  assert.match(form, /fetch\("\/api\/imports\/validate"/);
  assert.match(form, /Upload for review/);
  assert.match(form, /Supported source datasets/);
  assert.match(form, /Current roster:[\s\S]*derives the New Hires list/);
  assert.match(form, /New hires:[\s\S]*replaces the current New Hires work list/);
});

test("new-hire datasets include a hired-within-14-days view", () => {
  const newHires = source("src/app/new-hires/page.tsx");
  assert.match(newHires, /<option value="14">14 days<\/option>/);
});
