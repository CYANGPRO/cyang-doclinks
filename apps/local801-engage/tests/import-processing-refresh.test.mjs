import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getImportProcessingStatus } from "../src/lib/import-persistence.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";
const actor = { organizationId, userId: "33333333-3333-4333-8333-333333333333", role: "system_owner" };

test("lightweight import status lookup is organization-scoped and does not load review rows", async () => {
  let observed = null;
  const status = await getImportProcessingStatus(actor, batchId, async (sql, parameters) => {
    observed = { sql, parameters };
    return [{ processing_stage: "validating", processed_row_count: 500, total_row_count: 787, processing_error_code: null }];
  });
  assert.equal(status.processing_stage, "validating");
  assert.deepEqual(observed.parameters, [batchId, organizationId]);
  assert.match(observed.sql, /FROM local801\.import_batches/);
  assert.doesNotMatch(observed.sql, /import_rows|pii_exact_indexes|normalized_json/);
});

test("processing UI polls the lightweight endpoint without overlapping full page refreshes", async () => {
  const [component, page, route] = await Promise.all([
    readFile(new URL("../src/components/ImportProcessingRefresh.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/imports/[batchId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/imports/[batchId]/status/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(component, /fetch\(`\/api\/imports\/\$\{encodeURIComponent\(batchId\)\}\/status`/);
  assert.match(component, /window\.setTimeout/);
  assert.doesNotMatch(component, /setInterval/);
  assert.match(component, /terminalStages\.has/);
  assert.match(page, /ImportProcessingRefresh active=\{processingActive\} batchId=\{batchId\}/);
  assert.match(page, /getImportExecutionPreflight\(actor, batchId, undefined, loadedSummary\)/);
  assert.match(route, /getImportProcessingStatus/);
  assert.match(route, /Cache-Control.*no-store/);
});
