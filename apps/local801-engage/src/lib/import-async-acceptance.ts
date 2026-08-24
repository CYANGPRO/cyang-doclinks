import "server-only";

import { randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { getAppConfig } from "./config.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import {
  discardImportSourceAfterFailedAcceptance,
  storeEncryptedImportFile,
  type EncryptedStorageResult,
} from "./document-storage.ts";
import { ControlledImportError } from "./import-errors.ts";
import { IMPORT_PROCESSING_VERSION } from "./import-processing.ts";
import { durableImportProcessingEnabled, isStrictSyntheticPreviewCsv } from "./import-scanner.ts";
import { startQueuedImportWorkflow } from "./import-workflow-starter.ts";
import { importKindSchema } from "./imports.ts";
import type { ImportActor } from "./import-persistence.ts";

type AcceptanceDependencies = {
  query?: DatabaseQuery;
  transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  storeFile?: typeof storeEncryptedImportFile;
  startWorkflow?: typeof startQueuedImportWorkflow;
  discardSource?: typeof discardImportSourceAfterFailedAcceptance;
  id?: () => string;
  env?: NodeJS.ProcessEnv;
};

export async function acceptDurableImport(input: {
  actor: ImportActor;
  file: File;
  importKind: unknown;
  dependencies?: AcceptanceDependencies;
}) {
  if (!can(input.actor.role, "manageImports")) throw new Error("Forbidden.");
  const env = input.dependencies?.env ?? process.env;
  if (!durableImportProcessingEnabled(env)) {
    throw new ControlledImportError("SERVICE_UNAVAILABLE", "service_unavailable", "availability");
  }
  const kind = importKindSchema.safeParse(input.importKind || "current_roster");
  if (!kind.success) throw new ControlledImportError("IMPORT_VALIDATION_FAILED", "validation_failed");
  const lowerName = input.file.name.toLowerCase();
  const lowerType = input.file.type.toLowerCase();
  const csv = lowerName.endsWith(".csv") && (!lowerType || lowerType === "text/csv");
  const xlsx = lowerName.endsWith(".xlsx") && (!lowerType
    || lowerType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  if (!csv && !xlsx) {
    throw new ControlledImportError("UNSUPPORTED_FILE", "unsupported_file");
  }
  if (!Number.isSafeInteger(input.file.size) || input.file.size <= 0) throw new ControlledImportError("EMPTY_FILE", "empty_file");
  if (input.file.size > getAppConfig(env).LOCAL801_IMPORT_MAX_BYTES) throw new ControlledImportError("FILE_TOO_LARGE", "file_too_large");
  const content = Buffer.from(await input.file.arrayBuffer());
  // CSV can be validated without opening an archive. XLSX remains opaque until
  // the malware scan succeeds; the worker enforces synthetic identities after scanning.
  if (env.VERCEL_ENV === "preview" && csv && !isStrictSyntheticPreviewCsv(content, "text/csv", input.file.name)) {
    throw new ControlledImportError("IMPORT_VALIDATION_FAILED", "validation_failed");
  }

  const query = input.dependencies?.query ?? queryLocal801;
  const transaction = input.dependencies?.transaction ?? runLocal801Transaction;
  const storeFile = input.dependencies?.storeFile ?? storeEncryptedImportFile;
  const startWorkflow = input.dependencies?.startWorkflow ?? startQueuedImportWorkflow;
  const makeId = input.dependencies?.id ?? randomUUID;
  const batchId = makeId();
  const [batch] = await query<{ id: string }>(`
    INSERT INTO local801.import_batches
      (id, organization_id, import_kind, state, uploaded_by, processing_stage, processed_row_count)
    SELECT $1, $2, $3, 'uploaded', actor.id, 'uploaded', 0
    FROM local801.users actor
    WHERE actor.id = $4 AND actor.organization_id = $2 AND actor.deactivated_at IS NULL
    RETURNING id
  `, [batchId, input.actor.organizationId, kind.data, input.actor.userId]);
  if (!batch) throw new ControlledImportError("SERVICE_UNAVAILABLE", "service_unavailable", "batch_actor_resolution");

  let stored: EncryptedStorageResult | null = null;
  let failureStage: "encrypted_storage" | "queue_and_audit" = "encrypted_storage";
  try {
    stored = await storeFile({
      actor: input.actor,
      organizationId: input.actor.organizationId,
      importBatchId: batchId,
      originalFilename: input.file.name,
      mediaType: csv ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content,
    });
    failureStage = "queue_and_audit";
    const queueStatement: DatabaseStatement = {
      sql: `WITH queued_batch AS (
          UPDATE local801.import_batches batch SET processing_stage = 'queued', processing_error_code = NULL
          WHERE batch.organization_id = $1 AND batch.id = $2 AND batch.processing_stage = 'uploaded'
            AND batch.state = 'uploaded'
            AND (SELECT count(*) FROM local801.import_files file
              WHERE file.organization_id = batch.organization_id AND file.import_batch_id = batch.id) = 1
          RETURNING batch.id, batch.organization_id
        ), queued_job AS (
          INSERT INTO local801.import_processing_jobs
            (organization_id, import_batch_id, processing_version, state)
          SELECT organization_id, id, $3, 'queued' FROM queued_batch RETURNING id
        ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS queued
        FROM queued_job`,
      parameters: [input.actor.organizationId, batchId, IMPORT_PROCESSING_VERSION],
    };
    const audit = await prepareAtomicAuditStatement({
      eventType: "import.upload",
      actorId: input.actor.userId,
      organizationId: input.actor.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: {
        sourceFilename: input.file.name,
        byteSize: stored.byteSize,
        importKind: kind.data,
        processing: csv ? "durable_csv" : "durable_xlsx",
      },
    }, query);
    await transaction([queueStatement, audit]);
  } catch (error) {
    if (stored && !input.dependencies?.storeFile) {
      try {
        await (input.dependencies?.discardSource ?? discardImportSourceAfterFailedAcceptance)({
          organizationId: input.actor.organizationId,
          importBatchId: batchId,
          importFileId: stored.id,
          storageKey: stored.storageKey,
        });
      } catch { /* Encrypted metadata remains for explicit cleanup; no job was queued. */ }
    }
    if (!stored) {
      try { await query(`DELETE FROM local801.import_batches WHERE id = $1 AND organization_id = $2
        AND processing_stage = 'uploaded' AND NOT EXISTS (SELECT 1 FROM local801.import_files
          WHERE organization_id = $2 AND import_batch_id = $1)`, [batchId, input.actor.organizationId]); } catch { /* safe orphan metadata */ }
    }
    if (error instanceof ControlledImportError) throw error;
    throw new ControlledImportError("SERVICE_UNAVAILABLE", "service_unavailable", failureStage);
  }

  let workflowStarted = false;
  try {
    await startWorkflow(input.actor.organizationId, batchId, { env });
    workflowStarted = true;
  } catch {
    // The committed queued/runless job is intentionally left for bounded recovery.
  }
  return {
    accepted: true as const,
    batchId,
    processingStage: "queued" as const,
    workflowStarted,
    statusLocation: `/imports/${batchId}`,
  };
}

/** Compatibility name retained for callers deployed before XLSX support. */
export const acceptDurablePreviewImport = acceptDurableImport;
export const acceptDurablePreviewCsv = acceptDurableImport;
