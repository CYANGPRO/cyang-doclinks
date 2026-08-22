import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findUnreferencedListedObjects, getBoundedListedObjects } from "../scripts/lib/retention-inventory-policy.mjs";

test("retention tooling is bounded inventory-only and contains no object or database deletion", async () => {
  const source = await readFile(new URL("../scripts/retention-inventory.mjs", import.meta.url), "utf8");
  for (const category of ["storage_cleanup_pending_at", "generated_reports", "import_files", "import_processing_jobs", "possibleOrphanedObjects"]) {
    assert.match(source, new RegExp(category));
  }
  assert.match(source, /LOCAL801_RETENTION_INVENTORY/);
  assert.match(source, /limit \$\{batchSize\}/);
  assert.match(source, /storage_key = any\(\$\{listedKeys\}::text\[\]\)/);
  assert.match(source, /organization_id = \$\{organizationId\}/);
  assert.match(source, /orphanClassificationScope: "listed-page-only"/);
  assert.doesNotMatch(source, /DeleteObjectCommand|delete\s+from|--delete/i);
});

test("orphan classification compares only the bounded listed page with exact organization-scoped references", () => {
  const listed = getBoundedListedObjects([
    { Key: "local801/documents/2026/08/11111111-1111-4111-8111-111111111111", Size: 100 },
    { Key: "local801/reports/2026/08/22222222-2222-4222-8222-222222222222", Size: 200 },
  ], 2);
  const orphaned = findUnreferencedListedObjects(listed, [listed[0].key]);
  assert.deepEqual(orphaned, [listed[1]]);
  assert.throws(() => findUnreferencedListedObjects(listed, ["local801/documents/2026/08/33333333-3333-4333-8333-333333333333"]), /escaped/);
  assert.throws(() => getBoundedListedObjects([...listed, listed[0]], 2), /outside the reviewed bound/);
  assert.throws(() => getBoundedListedObjects([{ Key: "member-name.pdf", Size: 1 }], 2), /invalid/);
});
