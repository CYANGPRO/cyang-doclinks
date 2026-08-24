import { getWorkflowMetadata } from "workflow";
import {
  type ImportProcessingSafeErrorCode,
  type ImportWorkflowInput,
} from "../lib/import-processing.ts";
import {
  safeImportProcessingCodeFromWorkflowError,
  throwImportProcessingStepError,
} from "../lib/import-workflow-error-boundary.ts";
import {
  ImportWorkerError,
  acknowledgeImportCancellation,
  completeImportProcessing,
  ensureImportProcessingJob,
  failImportProcessing,
  matchImportIdentities,
  parseAndStageImport,
  prepareImportReview,
  safeImportWorkerErrorCode,
  scanImportSource,
  validateStagedImport,
} from "../lib/import-worker.ts";

const retryableCodes: readonly ImportProcessingSafeErrorCode[] = [
  "DATABASE_TEMPORARY_FAILURE",
  "R2_TEMPORARY_FAILURE",
  "SCANNER_TEMPORARY_FAILURE",
  "WORKFLOW_TEMPORARY_FAILURE",
  "INTERNAL_PROCESSING_FAILURE",
];

function throwForStep(error: unknown): never {
  if (error instanceof ImportWorkerError) {
    throwImportProcessingStepError(error.code, error.retryable);
  }
  const code = safeImportWorkerErrorCode(error);
  throwImportProcessingStepError(code, retryableCodes.includes(code));
}

async function ensureJobStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await ensureImportProcessingJob(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function scanSourceStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await scanImportSource(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function cancellationStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await acknowledgeImportCancellation(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function parseAndStageStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await parseAndStageImport(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function validateStagedStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await validateStagedImport(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function matchIdentitiesStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await matchImportIdentities(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function prepareReviewStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await prepareImportReview(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function completeProcessingStep(input: ImportWorkflowInput, trustedWorkflowRunId: string) {
  "use step";
  try { return await completeImportProcessing(input, trustedWorkflowRunId); }
  catch (error) { throwForStep(error); }
}

async function recordFailureStep(
  input: ImportWorkflowInput,
  trustedWorkflowRunId: string,
  code: ImportProcessingSafeErrorCode,
) {
  "use step";
  return failImportProcessing(input, trustedWorkflowRunId, code);
}

export async function processImportWorkflow(input: ImportWorkflowInput) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  try {
    const ownership = await ensureJobStep(input, workflowRunId);
    if (ownership === "not_owner") return { status: "duplicate_owner" as const };
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await scanSourceStep(input, workflowRunId);
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await parseAndStageStep(input, workflowRunId);
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await validateStagedStep(input, workflowRunId);
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await matchIdentitiesStep(input, workflowRunId);
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await prepareReviewStep(input, workflowRunId);
    if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    await completeProcessingStep(input, workflowRunId);
    return { status: "ready_for_review" as const };
  } catch (error) {
    try {
      if (await cancellationStep(input, workflowRunId)) return { status: "cancelled" as const };
    } catch {
      // A cancellation probe can fail for the same dependency that caused the
      // workflow error. Failure persistence must still get its own step retry
      // opportunity so the owned job is not left indefinitely in `running`.
    }
    const code = safeImportProcessingCodeFromWorkflowError(error);
    await recordFailureStep(input, workflowRunId, code);
    throw error;
  }
}
