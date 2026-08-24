import { randomUUID } from "node:crypto";

export type ProtectedImportExecutionStage =
  | "request"
  | "workspace"
  | "rate-limit"
  | "preflight"
  | "review-transition"
  | "preparation"
  | "atomic-apply"
  | "legacy-apply";

export type SafeProtectedImportExecutionDiagnostic = {
  event: "local801-protected-import-safe-failure";
  stage: ProtectedImportExecutionStage;
  category: "database" | "timeout" | "runtime" | "unknown";
  code: string;
  supportReference: string;
};

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const SAFE_REFERENCE_RE = /^IMPORT_EXECUTION_[0-9A-F]{12}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function sqlState(error: unknown) {
  let current = record(error);
  for (let depth = 0; current && depth < 3; depth += 1) {
    try {
      const code = current.code;
      if (typeof code === "string" && SQLSTATE_RE.test(code.toUpperCase())) return code.toUpperCase();
      current = record(current.cause);
    } catch {
      return null;
    }
  }
  return null;
}

function timeout(error: unknown) {
  try {
    const name = record(error)?.name;
    return name === "AbortError" || name === "TimeoutError";
  } catch {
    return false;
  }
}

function nativeError(error: unknown) {
  try {
    return error instanceof Error;
  } catch {
    return false;
  }
}

export function createProtectedImportExecutionSupportReference() {
  return `IMPORT_EXECUTION_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

export function safeProtectedImportExecutionDiagnostic(
  stage: ProtectedImportExecutionStage,
  error: unknown,
  supportReference = createProtectedImportExecutionSupportReference(),
): SafeProtectedImportExecutionDiagnostic {
  const safeReference = SAFE_REFERENCE_RE.test(supportReference)
    ? supportReference
    : createProtectedImportExecutionSupportReference();
  const state = sqlState(error);
  if (state) {
    return {
      event: "local801-protected-import-safe-failure",
      stage,
      category: "database",
      code: `SQLSTATE_${state}`,
      supportReference: safeReference,
    };
  }
  if (timeout(error)) {
    return {
      event: "local801-protected-import-safe-failure",
      stage,
      category: "timeout",
      code: "OPERATION_TIMEOUT",
      supportReference: safeReference,
    };
  }
  const isError = nativeError(error);
  return {
    event: "local801-protected-import-safe-failure",
    stage,
    category: isError ? "runtime" : "unknown",
    code: isError ? "UNCLASSIFIED_ERROR" : "UNKNOWN_THROWABLE",
    supportReference: safeReference,
  };
}
