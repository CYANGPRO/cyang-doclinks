import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { can, type Permission, type Role } from "./access.ts";
import { getAppConfig } from "./config.ts";
import { queryLocal801 } from "./db.ts";
import { decryptEnvelope, encryptEnvelope } from "./encryption.ts";
import { deleteObject, generateStorageKey, getObject, putObject, type StorageKind } from "./r2.ts";
import { writeSecuritySignal } from "./security-signal.ts";

const DOCUMENT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);
const IMPORT_MEDIA_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);
const REPORT_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);

export const DOCUMENT_VISIBILITIES = [
  "local_admin_only",
  "membership_management",
  "cat_admin_only",
  "cat_lead_scope",
  "cat_member_scope",
] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];
const documentVisibilitySet = new Set<string>(DOCUMENT_VISIBILITIES);
const documentVisibilityPermissions: Record<DocumentVisibility, Permission> = {
  local_admin_only: "viewLocalAdminDocuments",
  membership_management: "viewPersonLevelReports",
  cat_admin_only: "viewRestrictedStrategy",
  cat_lead_scope: "viewTeamScope",
  cat_member_scope: "viewCatMemberDocuments",
};

export type StorageActor = { organizationId: string; role: Role };
export type EncryptedStorageResult = {
  id: string;
  storageKey: string;
  sha256: string;
  encryptionKeyVersion: string;
  byteSize: number;
};

export class StorageCleanupPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageCleanupPendingError";
  }
}

type StoredObjectRow = {
  id: string;
  storage_key: string;
  encryption_key_version: string | null;
  sha256: string;
  media_type: string | null;
  original_filename?: string | null;
  visibility?: string | null;
  requires_person_level_permission?: boolean;
};

function authorize(actor: StorageActor, organizationId: string, permission: Permission) {
  if (actor.organizationId !== organizationId || !can(actor.role, permission)) {
    throw new Error("Forbidden.");
  }
}

export function parseDocumentVisibility(value: unknown): DocumentVisibility {
  if (typeof value !== "string" || !documentVisibilitySet.has(value)) {
    throw new Error("Unsupported document visibility.");
  }
  return value as DocumentVisibility;
}

function authorizeDocumentVisibility(actor: StorageActor, visibilityValue: unknown) {
  const visibility = parseDocumentVisibility(visibilityValue);
  if (!can(actor.role, documentVisibilityPermissions[visibility])) throw new Error("Forbidden.");
  return visibility;
}

async function assertCreatedByBelongsToOrganization(createdBy: string, organizationId: string) {
  const [result] = await queryLocal801<{ belongs: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1 FROM local801.users
        WHERE id = $1 AND organization_id = $2 AND deactivated_at IS NULL
      ) AS belongs
    `,
    [createdBy, organizationId],
  );
  if (!result?.belongs) throw new Error("Document creator does not belong to the organization.");
}

async function assertImportBatchBelongsToOrganization(importBatchId: string, organizationId: string) {
  const [result] = await queryLocal801<{ belongs: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1 FROM local801.import_batches WHERE id = $1 AND organization_id = $2
      ) AS belongs
    `,
    [importBatchId, organizationId],
  );
  if (!result?.belongs) throw new Error("Import batch does not belong to the organization.");
}

async function getReportRunAuthorization(reportRunId: string, organizationId: string) {
  const [result] = await queryLocal801<{
    belongs: boolean;
    requires_person_level_permission: boolean;
  }>(
    `
      SELECT
        true AS belongs,
        rd.requires_person_level_permission
      FROM local801.report_runs rr
      JOIN local801.report_definitions rd
        ON rd.id = rr.report_definition_id AND rd.organization_id = rr.organization_id
      WHERE rr.id = $1 AND rr.organization_id = $2
    `,
    [reportRunId, organizationId],
  );
  if (!result?.belongs) throw new Error("Report run does not belong to the organization.");
  return result;
}

function sha256Hex(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function hashesMatch(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function validateText(value: string, label: string, maxLength = 255) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function normalizeOriginalFilename(filename: string) {
  const normalized = validateText(filename, "Original filename");
  const segments = normalized.replaceAll("\\", "/").split("/");
  const basename = segments.at(-1)?.trim();
  if (!basename || basename === "." || basename === "..") throw new Error("Original filename is invalid.");
  return basename;
}

function preparePayload(content: Buffer | Uint8Array | string, mediaType: string, allowedTypes: ReadonlySet<string>) {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (!allowedTypes.has(normalizedMediaType)) throw new Error("Unsupported media type.");
  const plaintext = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const maxBytes = getAppConfig().LOCAL801_IMPORT_MAX_BYTES;
  if (plaintext.byteLength === 0) throw new Error("Empty files are not supported.");
  if (plaintext.byteLength > maxBytes) throw new Error(`Payload exceeds maximum supported size of ${maxBytes} bytes.`);
  const encrypted = encryptEnvelope(plaintext);
  return {
    plaintext,
    mediaType: normalizedMediaType,
    sha256: sha256Hex(plaintext),
    encryptedPayload: encrypted.payload,
    encryptionKeyVersion: encrypted.keyVersion,
  };
}

async function uploadThenPersist<T extends { id: string }>(
  kind: StorageKind,
  encryptedPayload: Buffer,
  persist: (storageKey: string) => Promise<T[]>,
) {
  const storageKey = generateStorageKey(kind);
  await putObject(storageKey, encryptedPayload);
  try {
    const [row] = await persist(storageKey);
    if (!row) throw new Error("Encrypted object metadata was not stored.");
    return { row, storageKey };
  } catch (error) {
    try {
      await deleteObject(storageKey);
    } catch (cleanupError) {
      throw new StorageCleanupPendingError(
        "Encrypted metadata was not stored and object cleanup remains pending.",
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    throw error;
  }
}

async function decryptStoredObject(row: StoredObjectRow) {
  if (!row.encryption_key_version) throw new Error("Encrypted object metadata is incomplete.");
  const encryptedObject = await getObject(row.storage_key);
  const decrypted = decryptEnvelope(encryptedObject.body);
  if (decrypted.keyVersion !== row.encryption_key_version) {
    writeSecuritySignal("error", "integrity.failure", { component: "object_storage", reason: "key_version_mismatch" });
    throw new Error("Encrypted object key version does not match database metadata.");
  }
  const actualHash = sha256Hex(decrypted.plaintext);
  if (!hashesMatch(actualHash, row.sha256)) {
    writeSecuritySignal("error", "integrity.failure", { component: "object_storage", reason: "plaintext_hash_mismatch" });
    throw new Error("Document integrity check failed.");
  }
  return decrypted.plaintext;
}

export async function storeEncryptedDocument(input: {
  actor: StorageActor;
  organizationId: string;
  category: string;
  title: string;
  originalFilename: string;
  visibility: DocumentVisibility;
  status: "draft" | "active" | "under_review" | "approved" | "superseded" | "archived";
  createdBy: string;
  content: Buffer | Uint8Array | string;
  mediaType: string;
}): Promise<EncryptedStorageResult> {
  authorize(input.actor, input.organizationId, "manageDocuments");
  const visibility = parseDocumentVisibility(input.visibility);
  authorizeDocumentVisibility(input.actor, visibility);
  await assertCreatedByBelongsToOrganization(input.createdBy, input.organizationId);
  const category = validateText(input.category, "Document category", 100);
  const title = validateText(input.title, "Document title");
  const originalFilename = normalizeOriginalFilename(input.originalFilename);
  const prepared = preparePayload(input.content, input.mediaType, DOCUMENT_MEDIA_TYPES);

  const { row, storageKey } = await uploadThenPersist("documents", prepared.encryptedPayload, (key) =>
    queryLocal801<{ id: string }>(
      `
        INSERT INTO local801.documents (
          organization_id, category, title, original_filename, media_type, byte_size,
          visibility, status, created_by, storage_key, encryption_key_version, sha256
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        FROM local801.users creator
        WHERE creator.id = $9 AND creator.organization_id = $1 AND creator.deactivated_at IS NULL
        RETURNING id
      `,
      [
        input.organizationId,
        category,
        title,
        originalFilename,
        prepared.mediaType,
        prepared.plaintext.byteLength,
        visibility,
        input.status,
        input.createdBy,
        key,
        prepared.encryptionKeyVersion,
        prepared.sha256,
      ],
    ),
  );

  return {
    id: row.id,
    storageKey,
    sha256: prepared.sha256,
    encryptionKeyVersion: prepared.encryptionKeyVersion,
    byteSize: prepared.plaintext.byteLength,
  };
}

export async function downloadDocument(input: { actor: StorageActor; organizationId: string; documentId: string }) {
  authorize(input.actor, input.organizationId, "viewDocuments");
  const [row] = await queryLocal801<StoredObjectRow>(
    `
      SELECT id, storage_key, encryption_key_version, sha256, media_type, original_filename, visibility
      FROM local801.documents
      WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
    `,
    [input.documentId, input.organizationId],
  );
  if (!row) throw new Error("Document not found.");
  authorizeDocumentVisibility(input.actor, row.visibility);
  return {
    id: row.id,
    plaintext: await decryptStoredObject(row),
    mediaType: row.media_type,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    encryptionKeyVersion: row.encryption_key_version,
  };
}

export async function deleteEncryptedDocument(input: {
  actor: StorageActor;
  organizationId: string;
  documentId: string;
}) {
  authorize(input.actor, input.organizationId, "manageDocuments");
  const [document] = await queryLocal801<{ organization_id: string; visibility: string }>(
    `
      SELECT organization_id, visibility
      FROM local801.documents
      WHERE id = $1 AND organization_id = $2
    `,
    [input.documentId, input.organizationId],
  );
  if (!document) return { deleted: false as const };
  if (document.organization_id !== input.organizationId) throw new Error("Forbidden.");
  const visibility = authorizeDocumentVisibility(input.actor, document.visibility);

  const [row] = await queryLocal801<{ storage_key: string }>(
    `
      UPDATE local801.documents
      SET
        archived_at = COALESCE(archived_at, now()),
        storage_cleanup_pending_at = COALESCE(storage_cleanup_pending_at, now())
      WHERE id = $1 AND organization_id = $2 AND visibility = $3
      RETURNING storage_key
    `,
    [input.documentId, input.organizationId, visibility],
  );
  if (!row) throw new Error("Document changed before cleanup could begin.");
  try {
    await deleteObject(row.storage_key);
  } catch {
    throw new Error("Document cleanup is pending; the private object could not be deleted.");
  }
  try {
    await queryLocal801(
      `DELETE FROM local801.documents WHERE id = $1 AND organization_id = $2`,
      [input.documentId, input.organizationId],
    );
  } catch {
    throw new Error("Document object was deleted; archived metadata cleanup remains pending.");
  }
  return { deleted: true as const };
}

export async function storeEncryptedImportFile(input: {
  actor: StorageActor;
  organizationId: string;
  importBatchId: string;
  originalFilename: string;
  mediaType: string;
  content: Buffer | Uint8Array | string;
}): Promise<EncryptedStorageResult> {
  authorize(input.actor, input.organizationId, "manageImports");
  await assertImportBatchBelongsToOrganization(input.importBatchId, input.organizationId);
  const originalFilename = normalizeOriginalFilename(input.originalFilename);
  const prepared = preparePayload(input.content, input.mediaType, IMPORT_MEDIA_TYPES);
  const { row, storageKey } = await uploadThenPersist("imports", prepared.encryptedPayload, (key) =>
    queryLocal801<{ id: string }>(
      `
        INSERT INTO local801.import_files (
          organization_id, import_batch_id, original_filename, media_type, byte_size,
          storage_key, encryption_key_version, sha256
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8
        FROM local801.import_batches batch
        WHERE batch.id = $2 AND batch.organization_id = $1
        RETURNING id
      `,
      [
        input.organizationId,
        input.importBatchId,
        originalFilename,
        prepared.mediaType,
        prepared.plaintext.byteLength,
        key,
        prepared.encryptionKeyVersion,
        prepared.sha256,
      ],
    ),
  );
  return {
    id: row.id,
    storageKey,
    sha256: prepared.sha256,
    encryptionKeyVersion: prepared.encryptionKeyVersion,
    byteSize: prepared.plaintext.byteLength,
  };
}

export async function downloadImportFile(input: { actor: StorageActor; organizationId: string; importFileId: string }) {
  authorize(input.actor, input.organizationId, "manageImports");
  const [row] = await queryLocal801<StoredObjectRow>(
    `
      SELECT id, storage_key, encryption_key_version, sha256, media_type, original_filename
      FROM local801.import_files
      WHERE id = $1 AND organization_id = $2
    `,
    [input.importFileId, input.organizationId],
  );
  if (!row) throw new Error("Import file not found.");
  return {
    id: row.id,
    plaintext: await decryptStoredObject(row),
    mediaType: row.media_type,
    originalFilename: row.original_filename,
    sha256: row.sha256,
  };
}

/** Server-only worker loader. It deliberately has no end-user authorization surface. */
export async function loadCanonicalImportSourceForProcessing(organizationId: string, importBatchId: string) {
  const rows = await queryLocal801<StoredObjectRow>(
    `
      SELECT file.id, file.storage_key, file.encryption_key_version, file.sha256,
        file.media_type, file.original_filename
      FROM local801.import_files file
      JOIN local801.import_batches batch
        ON batch.id = file.import_batch_id
       AND batch.organization_id = file.organization_id
      WHERE file.organization_id = $1
        AND file.import_batch_id = $2
        AND batch.organization_id = $1
        AND batch.id = $2
    `,
    [organizationId, importBatchId],
  );
  if (rows.length === 0) {
    throw Object.assign(new Error("Canonical import source is missing."), { code: "SOURCE_FILE_MISSING" as const });
  }
  if (rows.length !== 1) {
    throw Object.assign(new Error("Canonical import source is ambiguous."), { code: "SOURCE_FILE_AMBIGUOUS" as const });
  }
  const row = rows[0];
  return {
    id: row.id,
    plaintext: await decryptStoredObject(row),
    mediaType: row.media_type ?? "",
    originalFilename: row.original_filename ?? "",
    sha256: row.sha256,
  };
}

/** Best-effort compensation for a source accepted before its queue transaction failed. */
export async function discardImportSourceAfterFailedAcceptance(input: {
  organizationId: string;
  importBatchId: string;
  importFileId: string;
  storageKey: string;
}) {
  const [row] = await queryLocal801<{ storage_key: string }>(`
    SELECT file.storage_key FROM local801.import_files file
    JOIN local801.import_batches batch ON batch.id = file.import_batch_id
      AND batch.organization_id = file.organization_id
    WHERE file.id = $1 AND file.organization_id = $2 AND file.import_batch_id = $3
      AND file.storage_key = $4 AND batch.processing_stage = 'uploaded'
      AND NOT EXISTS (SELECT 1 FROM local801.import_processing_jobs job
        WHERE job.organization_id = batch.organization_id AND job.import_batch_id = batch.id)
  `, [input.importFileId, input.organizationId, input.importBatchId, input.storageKey]);
  if (!row) return { discarded: false as const };
  await deleteObject(row.storage_key);
  await queryLocal801(`DELETE FROM local801.import_files
    WHERE id = $1 AND organization_id = $2 AND import_batch_id = $3 AND storage_key = $4`,
  [input.importFileId, input.organizationId, input.importBatchId, input.storageKey]);
  await queryLocal801(`DELETE FROM local801.import_batches batch
    WHERE batch.id = $1 AND batch.organization_id = $2 AND batch.processing_stage = 'uploaded'
      AND NOT EXISTS (SELECT 1 FROM local801.import_files file
        WHERE file.organization_id = batch.organization_id AND file.import_batch_id = batch.id)
      AND NOT EXISTS (SELECT 1 FROM local801.import_processing_jobs job
        WHERE job.organization_id = batch.organization_id AND job.import_batch_id = batch.id)`,
  [input.importBatchId, input.organizationId]);
  return { discarded: true as const };
}

export async function storeGeneratedReport(input: {
  actor: StorageActor;
  organizationId: string;
  reportRunId: string;
  mediaType: string;
  content: Buffer | Uint8Array | string;
  expiresAt?: Date;
}): Promise<EncryptedStorageResult> {
  authorize(input.actor, input.organizationId, "generateReports");
  const reportAuthorization = await getReportRunAuthorization(input.reportRunId, input.organizationId);
  const canViewPersonLevel = can(input.actor.role, "viewPersonLevelReports");
  if (reportAuthorization.requires_person_level_permission && !canViewPersonLevel) {
    throw new Error("Forbidden.");
  }
  const prepared = preparePayload(input.content, input.mediaType, REPORT_MEDIA_TYPES);
  const { row, storageKey } = await uploadThenPersist("reports", prepared.encryptedPayload, (key) =>
    queryLocal801<{ id: string }>(
      `
        INSERT INTO local801.generated_reports (
          organization_id, report_run_id, storage_key, encryption_key_version,
          media_type, byte_size, sha256, expires_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8
        FROM local801.report_runs run
        JOIN local801.report_definitions definition
          ON definition.id = run.report_definition_id
          AND definition.organization_id = run.organization_id
        WHERE run.id = $2
          AND run.organization_id = $1
          AND (NOT definition.requires_person_level_permission OR $9)
        RETURNING id
      `,
      [
        input.organizationId,
        input.reportRunId,
        key,
        prepared.encryptionKeyVersion,
        prepared.mediaType,
        prepared.plaintext.byteLength,
        prepared.sha256,
        input.expiresAt?.toISOString() ?? null,
        canViewPersonLevel,
      ],
    ),
  );
  return {
    id: row.id,
    storageKey,
    sha256: prepared.sha256,
    encryptionKeyVersion: prepared.encryptionKeyVersion,
    byteSize: prepared.plaintext.byteLength,
  };
}

export async function downloadGeneratedReport(input: {
  actor: StorageActor;
  organizationId: string;
  generatedReportId: string;
}) {
  authorize(input.actor, input.organizationId, "viewReports");
  const [row] = await queryLocal801<StoredObjectRow>(
    `
      SELECT
        generated.id,
        generated.storage_key,
        generated.encryption_key_version,
        generated.sha256,
        generated.media_type,
        definition.requires_person_level_permission
      FROM local801.generated_reports generated
      JOIN local801.report_runs run
        ON run.id = generated.report_run_id
        AND run.organization_id = generated.organization_id
      JOIN local801.report_definitions definition
        ON definition.id = run.report_definition_id
        AND definition.organization_id = generated.organization_id
      WHERE generated.id = $1
        AND generated.organization_id = $2
        AND (generated.expires_at IS NULL OR generated.expires_at > now())
    `,
    [input.generatedReportId, input.organizationId],
  );
  if (!row) throw new Error("Generated report not found.");
  if (row.requires_person_level_permission && !can(input.actor.role, "viewPersonLevelReports")) {
    throw new Error("Forbidden.");
  }
  return {
    id: row.id,
    plaintext: await decryptStoredObject(row),
    mediaType: row.media_type,
    sha256: row.sha256,
  };
}
