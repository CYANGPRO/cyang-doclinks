import { FatalError, RetryableError } from "workflow";
import {
  isImportProcessingSafeErrorCode,
  type ImportProcessingSafeErrorCode,
} from "./import-processing.ts";

const safeCodeMarker = "LOCAL801_IMPORT_SAFE_CODE:";

function safeStepErrorMessage(code: ImportProcessingSafeErrorCode) {
  return `${safeCodeMarker}${code}`;
}

export function throwImportProcessingStepError(
  code: ImportProcessingSafeErrorCode,
  retryable: boolean,
): never {
  const message = safeStepErrorMessage(code);
  if (retryable) throw new RetryableError(message, { retryAfter: "15s" });
  throw new FatalError(message);
}

/**
 * Workflow SDK 4.8.2 recreates terminal step failures as cross-realm
 * FatalErrors. Retry exhaustion also prefixes the original step message.
 */
export function safeImportProcessingCodeFromWorkflowError(error: unknown): ImportProcessingSafeErrorCode {
  if (!FatalError.is(error) || typeof error.message !== "string") return "INTERNAL_PROCESSING_FAILURE";
  const markerIndex = error.message.lastIndexOf(safeCodeMarker);
  if (markerIndex < 0) return "INTERNAL_PROCESSING_FAILURE";
  const sdkPrefix = error.message.slice(0, markerIndex);
  if (sdkPrefix && !/^Step ".+" failed after [0-9]+ (?:retry|retries): $/.test(sdkPrefix)) {
    return "INTERNAL_PROCESSING_FAILURE";
  }
  const candidate = error.message.slice(markerIndex + safeCodeMarker.length);
  return isImportProcessingSafeErrorCode(candidate) ? candidate : "INTERNAL_PROCESSING_FAILURE";
}
