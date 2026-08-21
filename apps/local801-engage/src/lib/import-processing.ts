export const IMPORT_PROCESSING_VERSION = "local801-import-v1";

export const importProcessingStages = [
  "uploaded",
  "queued",
  "scanning",
  "parsing",
  "validating",
  "matching",
  "preparing_review",
  "ready_for_review",
  "failed",
] as const;

export type ImportProcessingStage = typeof importProcessingStages[number];

export const importProcessingJobStates = ["queued", "running", "succeeded", "failed"] as const;
export type ImportProcessingJobState = typeof importProcessingJobStates[number];

export const importProcessingSafeErrorCodes = {
  DATABASE_TEMPORARY_FAILURE: "retryable",
  R2_TEMPORARY_FAILURE: "retryable",
  SCANNER_TEMPORARY_FAILURE: "retryable",
  WORKFLOW_TEMPORARY_FAILURE: "retryable",
  MALWARE_REJECTED: "terminal_source",
  UNSUPPORTED_FILE: "terminal_source",
  MALFORMED_FILE: "terminal_source",
  FILE_TOO_LARGE: "terminal_source",
  ROW_LIMIT_EXCEEDED: "terminal_source",
  SOURCE_FILE_MISSING: "terminal_source",
  SOURCE_FILE_AMBIGUOUS: "terminal_source",
  PROCESSING_VERSION_UNSUPPORTED: "operator_review",
  TENANT_INVARIANT_FAILED: "operator_review",
  STAGING_INVARIANT_FAILED: "operator_review",
  WORKFLOW_STALLED: "operator_review",
  INTERNAL_PROCESSING_FAILURE: "operator_review",
  SCANNER_UNAVAILABLE: "operator_review",
} as const;

export type ImportProcessingSafeErrorCode = keyof typeof importProcessingSafeErrorCodes;
export type ImportFailureDisposition = typeof importProcessingSafeErrorCodes[ImportProcessingSafeErrorCode];

export const importScannerOutcomes = [
  "clean",
  "malicious",
  "temporary_failure",
  "terminal_scanner_failure",
] as const;
export type ImportScannerOutcome = typeof importScannerOutcomes[number];

export type ImportWorkflowInput = Readonly<{
  organizationId: string;
  batchId: string;
}>;

export type ImportProcessingProgress = {
  stage: ImportProcessingStage;
  processedRowCount: number | null;
  totalRowCount: number | null;
};

const stageLabels: Record<ImportProcessingStage, string> = {
  uploaded: "Uploaded",
  queued: "Queued",
  scanning: "Scanning",
  parsing: "Parsing",
  validating: "Validating",
  matching: "Matching",
  preparing_review: "Preparing review",
  ready_for_review: "Ready for review",
  failed: "Failed",
};

const safeFailureMessages: Record<ImportProcessingSafeErrorCode, string> = {
  DATABASE_TEMPORARY_FAILURE: "The database was temporarily unavailable. Processing can be retried safely.",
  R2_TEMPORARY_FAILURE: "The encrypted source was temporarily unavailable. Processing can be retried safely.",
  SCANNER_TEMPORARY_FAILURE: "The source scanner was temporarily unavailable. Processing can be retried safely.",
  WORKFLOW_TEMPORARY_FAILURE: "Background processing was temporarily unavailable. Processing can be retried safely.",
  MALWARE_REJECTED: "The source was rejected by malware scanning. Upload a safe replacement file.",
  UNSUPPORTED_FILE: "This durable worker currently accepts CSV files only.",
  MALFORMED_FILE: "The source CSV could not be parsed safely.",
  FILE_TOO_LARGE: "The source exceeds the configured file-size limit.",
  ROW_LIMIT_EXCEEDED: "The source exceeds the configured row limit.",
  SOURCE_FILE_MISSING: "The encrypted source file is missing.",
  SOURCE_FILE_AMBIGUOUS: "More than one source file is attached to this batch.",
  PROCESSING_VERSION_UNSUPPORTED: "This processing version requires operator review.",
  TENANT_INVARIANT_FAILED: "The organization boundary could not be verified.",
  STAGING_INVARIANT_FAILED: "The persisted review staging data failed an integrity check.",
  WORKFLOW_STALLED: "Background processing requires operator review.",
  INTERNAL_PROCESSING_FAILURE: "Background processing failed safely and requires operator review.",
  SCANNER_UNAVAILABLE: "No production malware scanner is configured for this environment.",
};

const allowedNextStages: Record<ImportProcessingStage, readonly ImportProcessingStage[]> = {
  uploaded: ["queued", "failed"],
  queued: ["scanning", "failed"],
  scanning: ["parsing", "failed"],
  parsing: ["validating", "failed"],
  validating: ["matching", "failed"],
  matching: ["preparing_review", "failed"],
  preparing_review: ["ready_for_review", "failed"],
  ready_for_review: [],
  failed: ["queued"],
};

const allowedNextJobStates: Record<ImportProcessingJobState, readonly ImportProcessingJobState[]> = {
  queued: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: ["queued"],
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createImportWorkflowInput(organizationId: string, batchId: string): ImportWorkflowInput {
  if (!uuidPattern.test(organizationId) || !uuidPattern.test(batchId)) {
    throw new TypeError("Import workflow identifiers must be UUIDs.");
  }
  return Object.freeze({ organizationId, batchId });
}

export function canAdvanceImportProcessing(
  current: ImportProcessingStage,
  next: ImportProcessingStage,
) {
  return allowedNextStages[current].includes(next);
}

export function canAdvanceImportProcessingJob(
  current: ImportProcessingJobState,
  next: ImportProcessingJobState,
) {
  return allowedNextJobStates[current].includes(next);
}

export function isImportProcessingSafeErrorCode(value: string): value is ImportProcessingSafeErrorCode {
  return Object.hasOwn(importProcessingSafeErrorCodes, value);
}

export function importProcessingFailureDisposition(code: ImportProcessingSafeErrorCode) {
  return importProcessingSafeErrorCodes[code];
}

export function importProcessingSafeFailureMessage(value: string | null | undefined) {
  return value && isImportProcessingSafeErrorCode(value)
    ? safeFailureMessages[value]
    : "Background processing failed safely. No roster changes were made.";
}

export function requireCanonicalImportSource<T>(sources: readonly T[]): T {
  if (sources.length === 0) {
    throw Object.assign(new Error("A durable import requires exactly one source file."), {
      code: "SOURCE_FILE_MISSING" as const,
    });
  }
  if (sources.length !== 1) {
    throw Object.assign(new Error("A durable import requires exactly one source file."), {
      code: "SOURCE_FILE_AMBIGUOUS" as const,
    });
  }
  return sources[0];
}

export function scannerAllowsImportParsing(outcome: ImportScannerOutcome) {
  return outcome === "clean";
}

export type ImportProcessingOwnership = Readonly<{
  state: ImportProcessingJobState;
  workflowRunId: string | null;
}>;

export type ImportProcessingOwnershipDecision = "claim" | "already_owned" | "not_owner";

export function decideImportProcessingOwnership(
  job: ImportProcessingOwnership,
  trustedWorkflowRunId: string,
): ImportProcessingOwnershipDecision {
  if (trustedWorkflowRunId !== trustedWorkflowRunId.trim() || trustedWorkflowRunId.length === 0 || trustedWorkflowRunId.length > 255) {
    throw new TypeError("Trusted workflow run ID is invalid.");
  }
  if (job.state === "queued" && job.workflowRunId === null) return "claim";
  if (job.state === "running" && job.workflowRunId === trustedWorkflowRunId) return "already_owned";
  return "not_owner";
}

export type FailedImportProcessingJob = Readonly<{
  state: "failed";
  attemptCount: number;
  processingVersion: string;
}>;

export function createImportProcessingRequeuePatch(job: FailedImportProcessingJob, now: string) {
  if (!Number.isInteger(job.attemptCount) || job.attemptCount < 0 || Number.isNaN(Date.parse(now))) {
    throw new TypeError("Import requeue state is invalid.");
  }
  return Object.freeze({
    state: "queued" as const,
    workflowRunId: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    safeErrorCode: null,
    lastProgressAt: now,
    updatedAt: now,
    attemptCount: job.attemptCount,
    processingVersion: job.processingVersion,
  });
}

export function importProcessingStatus(progress: ImportProcessingProgress) {
  const processed = progress.processedRowCount;
  const total = progress.totalRowCount;
  const hasUsefulCounts = processed !== null && total !== null && processed >= 0 && total > 0 && processed <= total;

  return {
    label: stageLabels[progress.stage],
    detail: hasUsefulCounts
      ? `${processed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows`
      : null,
  };
}

export function isTerminalImportProcessingStage(stage: ImportProcessingStage) {
  return stage === "ready_for_review" || stage === "failed";
}
