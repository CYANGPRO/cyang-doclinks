import "server-only";

export type ImportPublicErrorCode =
  | "MISSING_FILE"
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "ROW_LIMIT_EXCEEDED"
  | "EMPTY_FILE"
  | "MALFORMED_FILE"
  | "IMPORT_VALIDATION_FAILED"
  | "IMPORT_PERSISTENCE_FAILED"
  | "SERVICE_UNAVAILABLE";

export type ImportRejectedReason =
  | "unsupported_file"
  | "file_too_large"
  | "empty_file"
  | "malformed_file"
  | "row_limit_exceeded"
  | "validation_failed"
  | "storage_failed"
  | "audit_failed"
  | "persistence_failed"
  | "service_unavailable";

const publicMessages: Record<ImportPublicErrorCode, string> = {
  MISSING_FILE: "Select an .xlsx or .csv file to import.",
  UNSUPPORTED_FILE: "Only .xlsx and .csv files are accepted.",
  FILE_TOO_LARGE: "The import file exceeds the configured size limit.",
  ROW_LIMIT_EXCEEDED: "The import exceeds the configured row limit.",
  EMPTY_FILE: "The import file is empty or has no usable header row.",
  MALFORMED_FILE: "The import file could not be parsed safely.",
  IMPORT_VALIDATION_FAILED: "The import could not be validated.",
  IMPORT_PERSISTENCE_FAILED: "The import could not be persisted.",
  SERVICE_UNAVAILABLE: "The import service is temporarily unavailable.",
};

const publicStatuses: Record<ImportPublicErrorCode, number> = {
  MISSING_FILE: 400,
  UNSUPPORTED_FILE: 400,
  FILE_TOO_LARGE: 413,
  ROW_LIMIT_EXCEEDED: 413,
  EMPTY_FILE: 400,
  MALFORMED_FILE: 400,
  IMPORT_VALIDATION_FAILED: 400,
  IMPORT_PERSISTENCE_FAILED: 500,
  SERVICE_UNAVAILABLE: 503,
};

export class ControlledImportError extends Error {
  readonly code: ImportPublicErrorCode;
  readonly reason: ImportRejectedReason;
  readonly status: number;

  constructor(code: ImportPublicErrorCode, reason: ImportRejectedReason) {
    super(publicMessages[code]);
    this.name = "ControlledImportError";
    this.code = code;
    this.reason = reason;
    this.status = publicStatuses[code];
  }
}

export function publicImportError(error: unknown) {
  if (error instanceof ControlledImportError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return {
    code: "IMPORT_PERSISTENCE_FAILED" as const,
    message: publicMessages.IMPORT_PERSISTENCE_FAILED,
    status: publicStatuses.IMPORT_PERSISTENCE_FAILED,
  };
}
