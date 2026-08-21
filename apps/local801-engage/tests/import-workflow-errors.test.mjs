import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { FatalError, RetryableError } from "workflow";
import {
  safeImportProcessingCodeFromWorkflowError,
  throwImportProcessingStepError,
} from "../src/lib/import-workflow-error-boundary.ts";
import { ImportWorkerError, safeImportWorkerErrorCode } from "../src/lib/import-worker.ts";

function captureThrown(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected callback to throw.");
}

function reconstructedSdkFatalError(message) {
  return runInNewContext(`
    const error = new Error(message);
    error.name = "FatalError";
    error;
  `, { message });
}

test("MALWARE_REJECTED survives the cross-realm workflow step boundary", () => {
  const workerError = new ImportWorkerError("MALWARE_REJECTED");
  const stepError = captureThrown(() => throwImportProcessingStepError(
    safeImportWorkerErrorCode(workerError),
    workerError.retryable,
  ));
  assert.equal(FatalError.is(stepError), true);
  assert.equal(RetryableError.is(stepError), false);

  const workflowError = reconstructedSdkFatalError(stepError.message);
  assert.equal(workflowError instanceof Error, false);
  assert.equal(safeImportProcessingCodeFromWorkflowError(workflowError), "MALWARE_REJECTED");
});

test("SCANNER_UNAVAILABLE survives the cross-realm workflow step boundary", () => {
  const workerError = new ImportWorkerError("SCANNER_UNAVAILABLE");
  const stepError = captureThrown(() => throwImportProcessingStepError(
    safeImportWorkerErrorCode(workerError),
    workerError.retryable,
  ));
  assert.equal(FatalError.is(stepError), true);
  assert.equal(RetryableError.is(stepError), false);
  assert.equal(
    safeImportProcessingCodeFromWorkflowError(reconstructedSdkFatalError(stepError.message)),
    "SCANNER_UNAVAILABLE",
  );
});

test("retryable scanner failures retain retry behavior and survive retry exhaustion", () => {
  const workerError = new ImportWorkerError("SCANNER_TEMPORARY_FAILURE", true);
  const stepError = captureThrown(() => throwImportProcessingStepError(
    safeImportWorkerErrorCode(workerError),
    workerError.retryable,
  ));
  assert.equal(RetryableError.is(stepError), true);
  assert.equal(FatalError.is(stepError), false);
  assert.equal(stepError.retryAfter instanceof Date, true);

  const exhaustedMessage = `Step "step//src/workflows/process-import.ts//scanSourceStep" failed after 3 retries: ${stepError.message}`;
  assert.equal(
    safeImportProcessingCodeFromWorkflowError(reconstructedSdkFatalError(exhaustedMessage)),
    "SCANNER_TEMPORARY_FAILURE",
  );
});

test("unknown workflow errors persist only INTERNAL_PROCESSING_FAILURE", () => {
  const workflowError = reconstructedSdkFatalError("unexpected workflow failure");
  assert.equal(safeImportProcessingCodeFromWorkflowError(workflowError), "INTERNAL_PROCESSING_FAILURE");
  assert.equal(safeImportProcessingCodeFromWorkflowError("non-error rejection"), "INTERNAL_PROCESSING_FAILURE");
});

test("raw exception details do not cross into the persisted safe code", () => {
  const rawDetail = "password=not-a-real-secret database exploded";
  const stepError = captureThrown(() => throwImportProcessingStepError(
    safeImportWorkerErrorCode(new Error(rawDetail)),
    true,
  ));
  assert.equal(RetryableError.is(stepError), true);
  assert.equal(stepError.message.includes(rawDetail), false);

  const exhaustedMessage = `Step "step//src/workflows/process-import.ts//scanSourceStep" failed after 3 retries: ${stepError.message}`;
  const persistedCode = safeImportProcessingCodeFromWorkflowError(reconstructedSdkFatalError(exhaustedMessage));
  assert.equal(persistedCode, "INTERNAL_PROCESSING_FAILURE");
  assert.equal(JSON.stringify({ processing_error_code: persistedCode }).includes(rawDetail), false);
});
