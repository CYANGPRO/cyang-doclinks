import "server-only";

export type ImportApprovalErrorCode =
  | "FORBIDDEN"
  | "IMPORT_NOT_FOUND"
  | "IMPORT_NOT_RESOLVABLE"
  | "INVALID_RESOLUTION"
  | "IDENTIFIER_CONFLICT"
  | "STALE_RESOLUTION"
  | "INVALID_DATE"
  | "DUPLICATE_SOURCE_ACK_REQUIRED"
  | "SOURCE_FILE_AMBIGUOUS"
  | "SERVICE_UNAVAILABLE";

const publicMessages: Record<ImportApprovalErrorCode, string> = {
  FORBIDDEN: "You do not have permission to change import approval readiness.",
  IMPORT_NOT_FOUND: "The import batch or row was not found.",
  IMPORT_NOT_RESOLVABLE: "This import row cannot be resolved.",
  INVALID_RESOLUTION: "The requested row resolution is not valid.",
  IDENTIFIER_CONFLICT: "Authoritative identifiers conflict and require a corrected source import.",
  STALE_RESOLUTION: "Authoritative identity data changed; refresh the review before continuing.",
  INVALID_DATE: "Provide a valid ISO calendar date for this import type.",
  DUPLICATE_SOURCE_ACK_REQUIRED: "An identical approved source must be acknowledged before readiness.",
  SOURCE_FILE_AMBIGUOUS: "The import batch must contain exactly one source file.",
  SERVICE_UNAVAILABLE: "Import approval readiness is temporarily unavailable.",
};

const publicStatuses: Record<ImportApprovalErrorCode, number> = {
  FORBIDDEN: 403,
  IMPORT_NOT_FOUND: 404,
  IMPORT_NOT_RESOLVABLE: 409,
  INVALID_RESOLUTION: 400,
  IDENTIFIER_CONFLICT: 409,
  STALE_RESOLUTION: 409,
  INVALID_DATE: 400,
  DUPLICATE_SOURCE_ACK_REQUIRED: 409,
  SOURCE_FILE_AMBIGUOUS: 409,
  SERVICE_UNAVAILABLE: 503,
};

export class ControlledImportApprovalError extends Error {
  readonly code: ImportApprovalErrorCode;
  readonly status: number;

  constructor(code: ImportApprovalErrorCode) {
    super(publicMessages[code]);
    this.name = "ControlledImportApprovalError";
    this.code = code;
    this.status = publicStatuses[code];
  }
}

export function publicImportApprovalError(error: unknown) {
  if (error instanceof ControlledImportApprovalError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  return {
    code: "SERVICE_UNAVAILABLE" as const,
    message: publicMessages.SERVICE_UNAVAILABLE,
    status: publicStatuses.SERVICE_UNAVAILABLE,
  };
}
