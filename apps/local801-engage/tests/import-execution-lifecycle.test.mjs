import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  enterImportReviewForProtectedExecution,
  ImportExecutionLifecycleError,
} from "../src/lib/import-execution-lifecycle.ts";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  role: "system_owner",
};
const batchId = "00000000-0000-4000-8000-000000000003";

test("protected execution lifecycle moves only a ready validated/review batch into under_review", async () => {
  let captured;
  const result = await enterImportReviewForProtectedExecution(actor, batchId, async (sql, parameters) => {
    captured = { sql, parameters };
    return [{ id: batchId, state: "under_review" }];
  });
  assert.deepEqual(result, { state: "under_review" });
  assert.match(captured.sql, /processing_stage = 'ready_for_review'/);
  assert.match(captured.sql, /state IN \('validated', 'under_review'\)/);
  assert.deepEqual(captured.parameters, [actor.organizationId, batchId]);
});

test("protected execution lifecycle fails closed for unauthorized, malformed, or stale batches", async () => {
  let calls = 0;
  const query = async () => { calls += 1; return []; };
  await assert.rejects(
    enterImportReviewForProtectedExecution({ ...actor, role: "cat_member" }, batchId, query),
    (error) => error instanceof ImportExecutionLifecycleError && error.code === "FORBIDDEN" && error.status === 403,
  );
  await assert.rejects(
    enterImportReviewForProtectedExecution(actor, "not-a-uuid", query),
    (error) => error instanceof ImportExecutionLifecycleError && error.code === "IMPORT_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    enterImportReviewForProtectedExecution(actor, batchId, query),
    (error) => error instanceof ImportExecutionLifecycleError && error.code === "BATCH_NOT_REVIEWABLE" && error.status === 409,
  );
  assert.equal(calls, 1);
});

test("protected execute route confirms preflight fingerprint before entering review and preparing mutations", async () => {
  const route = await readFile(new URL("../src/app/api/imports/[batchId]/execute/route.ts", import.meta.url), "utf8");
  const preflight = route.indexOf("getImportExecutionPreflight(actor, batchId)");
  const stale = route.indexOf("preflight.fingerprint !== fingerprint");
  const enterReview = route.indexOf("enterImportReviewForProtectedExecution(actor, batchId)");
  const prepare = route.indexOf("prepareProtectedImportExecution(actor, batchId,");
  const apply = route.indexOf("applyPreparedProtectedImport(");
  assert.ok(preflight >= 0 && stale > preflight && enterReview > stale && prepare > enterReview && apply > prepare);
  assert.match(route, /ImportExecutionLifecycleError/);
});
