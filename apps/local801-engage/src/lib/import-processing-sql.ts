import "server-only";

// Future worker mutations use these server-only fixtures. Audit inserts will be
// added to the same successful transactions when the worker is implemented.
export const ensureImportProcessingJobSql = `
  /* claim queued import processing job */
  UPDATE local801.import_processing_jobs AS job
  SET state = 'running',
      workflow_run_id = $4,
      attempt_count = job.attempt_count + 1,
      started_at = now(),
      last_progress_at = now(),
      updated_at = now()
  WHERE job.organization_id = $1
    AND job.import_batch_id = $2
    AND job.processing_version = $3
    AND job.state = 'queued'
    AND job.workflow_run_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM local801.import_batches AS batch
      WHERE batch.organization_id = job.organization_id
        AND batch.id = job.import_batch_id
        AND batch.organization_id = $1
        AND batch.id = $2
        AND batch.processing_stage = 'queued'
    )
  RETURNING job.id, job.state, job.workflow_run_id, job.attempt_count
`;

export const readImportProcessingJobOwnershipSql = `
  /* read import processing ownership */
  SELECT state, workflow_run_id, attempt_count
  FROM local801.import_processing_jobs
  WHERE organization_id = $1
    AND import_batch_id = $2
    AND processing_version = $3
`;

export const requeueImportProcessingJobSql = `
  /* reset failed import processing job */
  WITH reset_job AS (
    UPDATE local801.import_processing_jobs AS job
    SET state = 'queued',
        workflow_run_id = NULL,
        started_at = NULL,
        completed_at = NULL,
        failed_at = NULL,
        safe_error_code = NULL,
        last_progress_at = now(),
        updated_at = now()
    WHERE job.organization_id = $1
      AND job.import_batch_id = $2
      AND job.processing_version = $3
      AND job.state = 'failed'
      AND EXISTS (
        SELECT 1
        FROM local801.import_batches AS batch
        WHERE batch.organization_id = job.organization_id
          AND batch.id = job.import_batch_id
          AND batch.organization_id = $1
          AND batch.id = $2
          AND batch.processing_stage = 'failed'
      )
    RETURNING job.*
  ), reset_batch AS (
    UPDATE local801.import_batches AS batch
    SET processing_stage = 'queued',
        processing_error_code = NULL
    FROM reset_job
    WHERE batch.organization_id = reset_job.organization_id
      AND batch.id = reset_job.import_batch_id
    RETURNING batch.id
  )
  SELECT reset_job.*
  FROM reset_job
  CROSS JOIN reset_batch
`;
