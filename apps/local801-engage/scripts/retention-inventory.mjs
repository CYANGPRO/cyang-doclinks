import { createHash } from "node:crypto";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { getStorageConfig } from "../src/lib/config.ts";
import { parseProductionInitializationTarget } from "./lib/production-initializer-policy.mjs";
import { findUnreferencedListedObjects, getBoundedListedObjects } from "./lib/retention-inventory-policy.mjs";

if (process.env.LOCAL801_RETENTION_INVENTORY !== "1") throw new Error("Retention inventory requires explicit read-only opt-in.");
const target = parseProductionInitializationTarget(process.env);
const batchSize = Number(process.env.LOCAL801_RETENTION_INVENTORY_BATCH_SIZE ?? "250");
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Retention inventory batch size is invalid.");
const storage = getStorageConfig(process.env);
const sql = postgres(target.databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const r2 = new S3Client({ endpoint: storage.LOCAL801_R2_ENDPOINT, region: "auto", credentials: {
  accessKeyId: storage.LOCAL801_R2_ACCESS_KEY_ID, secretAccessKey: storage.LOCAL801_R2_SECRET_ACCESS_KEY,
} });

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

try {
  const organizations = await sql`select id from local801.organizations where slug = ${target.organizationSlug} and archived_at is null limit 2`;
  if (organizations.length !== 1) throw new Error("Retention inventory could not resolve exactly one CAT organization.");
  const organizationId = organizations[0].id;
  const [cleanupDocuments, expiredReports, importSources, failedJobs, listedResponse] = await Promise.all([
    sql`select id::text from local801.documents where organization_id = ${organizationId} and storage_cleanup_pending_at is not null order by storage_cleanup_pending_at, id limit ${batchSize}`,
    sql`select id::text from local801.generated_reports where organization_id = ${organizationId} and expires_at is not null and expires_at <= now() order by expires_at, id limit ${batchSize}`,
    sql`select id::text from local801.import_files where organization_id = ${organizationId} order by created_at, id limit ${batchSize}`,
    sql`select id::text from local801.import_processing_jobs where organization_id = ${organizationId} and state = 'failed' order by failed_at nulls last, id limit ${batchSize}`,
    r2.send(new ListObjectsV2Command({ Bucket: storage.LOCAL801_R2_BUCKET, Prefix: "local801/", MaxKeys: batchSize })),
  ]);
  const listed = getBoundedListedObjects(listedResponse.Contents ?? [], batchSize);
  const listedKeys = listed.map((entry) => entry.key);
  const storedKeys = listedKeys.length === 0 ? [] : await sql`
    select storage_key from local801.documents
      where organization_id = ${organizationId} and storage_key = any(${listedKeys}::text[])
    union select storage_key from local801.import_files
      where organization_id = ${organizationId} and storage_key = any(${listedKeys}::text[])
    union select storage_key from local801.generated_reports
      where organization_id = ${organizationId} and storage_key = any(${listedKeys}::text[])
  `;
  const orphaned = findUnreferencedListedObjects(listed, storedKeys.map((row) => row.storage_key));
  const output = {
    mode: "inventory-only",
    deletionEnabled: false,
    bounded: true,
    batchSize,
    categories: {
      cleanupPendingDocuments: cleanupDocuments.map((row) => fingerprint(row.id)),
      expiredGeneratedReports: expiredReports.map((row) => fingerprint(row.id)),
      importSourceFiles: importSources.map((row) => fingerprint(row.id)),
      failedTemporaryImportJobs: failedJobs.map((row) => fingerprint(row.id)),
      possibleOrphanedObjects: orphaned.map((entry) => ({ keyFingerprint: fingerprint(entry.key), byteSize: entry.byteSize })),
    },
    orphanClassificationScope: "listed-page-only",
    objectInventoryTruncated: Boolean(listedResponse.IsTruncated),
  };
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(JSON.stringify({ mode: "inventory-only", status: "failed", reason: error instanceof Error ? error.message : "Inventory failed safely." }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 });
  r2.destroy();
}
