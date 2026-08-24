import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("document upload explains the selected sharing audience before submission", () => {
  const form = readFileSync(new URL("../src/components/DocumentUploadForm.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/documents/page.tsx", import.meta.url), "utf8");

  assert.match(form, /aria-describedby="document-visibility-description"/);
  assert.match(form, /selectedOption\?\.description/);
  assert.match(page, /Visible only to System Owners and Local Administrators/);
  assert.match(page, /Membership Data Managers/);
  assert.match(page, /LCATs, and CATs/);
  assert.match(page, /Visible to you and users above your role/);
});
