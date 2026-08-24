import "server-only";

import { can } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import type { ImportReviewActor } from "./import-review.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ImportExecutionLifecycleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ImportExecutionLifecycleError";
    this.code = code;
    this.status = status;
  }
}

/**
 * A clean durable import finishes processing in `validated`. Protected apply is
 * intentionally stricter and only mutates authoritative data from
 * `under_review`. Move into that state only after the caller has completed the
 * current execution preflight/fingerprint confirmation.
 */
export async function enterImportReviewForProtectedExecution(
  actor: ImportReviewActor,
  batchId: string,
  query: DatabaseQuery = queryLocal801,
) {
  if (!can(actor.role, "approveImports")) {
    throw new ImportExecutionLifecycleError("FORBIDDEN", "Authoritative import execution is not authorized.", 403);
  }
  if (!UUID_RE.test(batchId)) {
    throw new ImportExecutionLifecycleError("IMPORT_NOT_FOUND", "Import batch not found.", 404);
  }

  const [row] = await query<{ id: string; state: string }>(`
    UPDATE local801.import_batches batch
    SET state = 'under_review'
    WHERE batch.organization_id = $1::uuid
      AND batch.id = $2::uuid
      AND batch.processing_stage = 'ready_for_review'
      AND batch.state IN ('validated', 'under_review')
    RETURNING batch.id::text, batch.state
  `, [actor.organizationId, batchId]);

  if (!row || row.state !== "under_review") {
    throw new ImportExecutionLifecycleError(
      "BATCH_NOT_REVIEWABLE",
      "The import batch is no longer ready for authoritative execution.",
    );
  }
  return { state: "under_review" as const };
}
