import { queryLocal801 } from "../src/lib/db.ts";
import { listStorageObjectKeys } from "../src/lib/r2.ts";

if (process.env.LOCAL801_STORAGE_RECONCILIATION_CONFIRM !== "READ_ONLY") {
  console.error("Storage reconciliation refused: set LOCAL801_STORAGE_RECONCILIATION_CONFIRM=READ_ONLY for this read-only operation.");
  process.exit(2);
}

const maximumObjects = Math.min(100_000, Math.max(1, Number(process.env.LOCAL801_STORAGE_RECONCILIATION_MAX_OBJECTS ?? 50_000)));
if (!Number.isSafeInteger(maximumObjects)) {
  console.error("Storage reconciliation refused: the maximum object count is invalid.");
  process.exit(2);
}

const metadata = await queryLocal801(`
  SELECT storage_key, object_kind, cleanup_pending
  FROM (
    SELECT storage_key, 'document'::text AS object_kind,
      storage_cleanup_pending_at IS NOT NULL AS cleanup_pending
    FROM local801.documents
    UNION ALL
    SELECT storage_key, 'import'::text, false FROM local801.import_files
    UNION ALL
    SELECT storage_key, 'report'::text, false FROM local801.generated_reports
  ) objects
  ORDER BY storage_key
  LIMIT $1::integer
`, [maximumObjects + 1]);

if (metadata.length > maximumObjects) {
  console.error("Storage reconciliation refused: database metadata limit exceeded.");
  process.exit(2);
}

const bucketKeys = await listStorageObjectKeys({ maximumObjects });
const expected = new Set(metadata.map((row) => row.storage_key));
const actual = new Set(bucketKeys);
const missingObjects = [...expected].filter((key) => !actual.has(key));
const orphanObjects = [...actual].filter((key) => !expected.has(key));
const cleanupPending = metadata.filter((row) => row.cleanup_pending).length;
const duplicateMetadata = metadata.length - expected.size;

const result = {
  mode: "read-only",
  metadataObjects: metadata.length,
  bucketObjects: bucketKeys.length,
  missingObjects: missingObjects.length,
  orphanObjects: orphanObjects.length,
  cleanupPending,
  duplicateMetadata,
  reconciled: missingObjects.length === 0 && orphanObjects.length === 0
    && cleanupPending === 0 && duplicateMetadata === 0,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.reconciled ? 0 : 2;
