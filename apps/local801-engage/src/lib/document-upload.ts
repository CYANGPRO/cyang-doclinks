import "server-only";

import { can, type Role } from "./access.ts";
import {
  documentUploadVisibilitiesForRole,
  type DocumentUploadVisibility,
} from "./document-access.ts";

export { DOCUMENT_UPLOAD_VISIBILITIES, type DocumentUploadVisibility } from "./document-access.ts";

const mediaTypeExtensions = new Map<string, readonly string[]>([
  ["application/pdf", [".pdf"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".xlsx"]],
  ["text/csv", [".csv"]],
  ["text/plain", [".txt"]],
]);

type UploadFile = Readonly<{
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type MalwareScanner = Readonly<{
  scan(request: Readonly<{ content: Buffer; mediaType: string; originalFilename: string }>): Promise<Readonly<{
    outcome: "clean" | "malicious" | "temporary_failure" | "terminal_scanner_failure";
    providerCode?: string;
  }>>;
}>;

type StoredDocument = Readonly<{ id: string; byteSize: number }>;

type DocumentUploadDependencies = Readonly<{
  maxBytes: number;
  scanner: MalwareScanner;
  store(input: Readonly<{
    actor: { organizationId: string; userId: string; role: Role };
    organizationId: string;
    category: string;
    title: string;
    originalFilename: string;
    visibility: DocumentUploadVisibility;
    status: "under_review";
    createdBy: string;
    content: Buffer;
    mediaType: string;
  }>): Promise<StoredDocument>;
  remove(input: Readonly<{
    actor: { organizationId: string; role: Role };
    organizationId: string;
    documentId: string;
  }>): Promise<unknown>;
  audit(event: Readonly<{
    eventType: "record.create";
    actorId: string;
    organizationId: string;
    subjectType: "document";
    subjectId: string;
    payload: Record<string, unknown>;
  }>): Promise<unknown>;
}>;

export type DocumentUploadActor = Readonly<{
  organizationId: string;
  userId: string;
  role: Role;
}>;

export type DocumentUploadInput = Readonly<{
  actor: DocumentUploadActor;
  file: UploadFile;
  title: unknown;
  category: unknown;
  visibility: unknown;
}>;

export type DocumentUploadErrorCode =
  | "INVALID_UPLOAD"
  | "VISIBILITY_FORBIDDEN"
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "MALWARE_REJECTED"
  | "SCANNER_TEMPORARY_FAILURE"
  | "SCANNER_UNAVAILABLE"
  | "UPLOAD_UNAVAILABLE";

const publicMessages: Record<DocumentUploadErrorCode, string> = {
  INVALID_UPLOAD: "Complete the required document fields and select a valid file.",
  VISIBILITY_FORBIDDEN: "The selected sharing scope is not allowed for your role.",
  UNSUPPORTED_FILE: "Upload a PDF, Word, Excel, CSV, or text file.",
  FILE_TOO_LARGE: "The document exceeds the maximum supported upload size.",
  MALWARE_REJECTED: "The document was rejected by malware scanning and was not stored.",
  SCANNER_TEMPORARY_FAILURE: "Malware scanning is temporarily unavailable. The document was not stored. Try again.",
  SCANNER_UNAVAILABLE: "Malware scanning is unavailable. The document was not stored.",
  UPLOAD_UNAVAILABLE: "The document could not be securely stored. No document was shared.",
};

export class DocumentUploadError extends Error {
  readonly code: DocumentUploadErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: DocumentUploadErrorCode, status: number, retryable = false) {
    super(publicMessages[code]);
    this.name = "DocumentUploadError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function normalizeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeFilename(value: string) {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const basename = value.replaceAll("\\", "/").split("/").at(-1)?.trim();
  return basename && basename !== "." && basename !== ".." ? basename : null;
}

function normalizeMediaType(file: UploadFile) {
  const mediaType = file.type.trim().toLowerCase();
  const allowedExtensions = mediaTypeExtensions.get(mediaType);
  if (!allowedExtensions) return null;
  const lowerName = file.name.toLowerCase();
  return allowedExtensions.some((extension) => lowerName.endsWith(extension)) ? mediaType : null;
}

export function documentUploadVisibilities(role: Role): DocumentUploadVisibility[] {
  return documentUploadVisibilitiesForRole(role);
}

export async function uploadDocument(
  input: DocumentUploadInput,
  dependencies: DocumentUploadDependencies,
) {
  if (!can(input.actor.role, "uploadDocuments")) {
    throw new DocumentUploadError("VISIBILITY_FORBIDDEN", 403);
  }

  const allowedVisibilities = documentUploadVisibilities(input.actor.role);
  const visibility = typeof input.visibility === "string" && allowedVisibilities.includes(input.visibility as DocumentUploadVisibility)
    ? input.visibility as DocumentUploadVisibility
    : null;
  if (!visibility) throw new DocumentUploadError("VISIBILITY_FORBIDDEN", 403);

  const title = normalizeText(input.title, 255);
  const category = normalizeText(input.category, 100);
  const originalFilename = normalizeFilename(input.file.name);
  if (!title || !category || !originalFilename) throw new DocumentUploadError("INVALID_UPLOAD", 400);

  const mediaType = normalizeMediaType(input.file);
  if (!mediaType) throw new DocumentUploadError("UNSUPPORTED_FILE", 415);
  if (!Number.isSafeInteger(dependencies.maxBytes) || dependencies.maxBytes <= 0) {
    throw new DocumentUploadError("UPLOAD_UNAVAILABLE", 503, true);
  }
  if (!Number.isSafeInteger(input.file.size) || input.file.size <= 0) {
    throw new DocumentUploadError("INVALID_UPLOAD", 400);
  }
  if (input.file.size > dependencies.maxBytes) throw new DocumentUploadError("FILE_TOO_LARGE", 413);

  let content: Buffer;
  try {
    content = Buffer.from(await input.file.arrayBuffer());
  } catch {
    throw new DocumentUploadError("INVALID_UPLOAD", 400);
  }
  if (content.byteLength !== input.file.size || content.byteLength === 0) {
    throw new DocumentUploadError("INVALID_UPLOAD", 400);
  }

  let scanResult: Awaited<ReturnType<MalwareScanner["scan"]>>;
  try {
    scanResult = await dependencies.scanner.scan({ content, mediaType, originalFilename });
  } catch {
    throw new DocumentUploadError("SCANNER_UNAVAILABLE", 503, true);
  }
  if (scanResult.outcome === "malicious") throw new DocumentUploadError("MALWARE_REJECTED", 422);
  if (scanResult.outcome === "temporary_failure") {
    throw new DocumentUploadError("SCANNER_TEMPORARY_FAILURE", 503, true);
  }
  if (scanResult.outcome !== "clean") throw new DocumentUploadError("SCANNER_UNAVAILABLE", 503, true);

  const actor = input.actor;
  let stored: StoredDocument;
  try {
    stored = await dependencies.store({
      actor,
      organizationId: input.actor.organizationId,
      category,
      title,
      originalFilename,
      visibility,
      status: "under_review",
      createdBy: input.actor.userId,
      content,
      mediaType,
    });
  } catch {
    throw new DocumentUploadError("UPLOAD_UNAVAILABLE", 503, true);
  }

  try {
    await dependencies.audit({
      eventType: "record.create",
      actorId: input.actor.userId,
      organizationId: input.actor.organizationId,
      subjectType: "document",
      subjectId: stored.id,
      payload: {
        category,
        visibility,
        byteSize: stored.byteSize,
        mediaType,
        malwareScan: "clean",
      },
    });
  } catch {
    try {
      await dependencies.remove({
        actor,
        organizationId: input.actor.organizationId,
        documentId: stored.id,
      });
    } catch {
      // deleteEncryptedDocument archives metadata before object cleanup, so a failed cleanup stays fail-closed.
    }
    throw new DocumentUploadError("UPLOAD_UNAVAILABLE", 503, true);
  }

  return {
    uploaded: true as const,
    title,
    category,
    visibility,
    mediaType,
    byteSize: stored.byteSize,
  };
}

export const __testing = { normalizeMediaType, normalizeFilename, normalizeText };
