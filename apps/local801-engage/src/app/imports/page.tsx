import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ImportPreviewForm } from "@/components/ImportPreviewForm";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { formatCatDateTime } from "@/lib/date-format";
import { DEFAULT_IMPORT_BATCH_PAGE_SIZE, getImportBatchesPage, type ImportBatchQueueItem } from "@/lib/import-persistence";
import { hydrateImportBatchQueueFromProtectedPii } from "@/lib/pii-protected-import-read";
import { getPiiProtectedReadMode } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { importProcessingSafeFailureMessage, importProcessingStages, importProcessingStatus } from "@/lib/import-processing";

export const dynamic = "force-dynamic";

type ImportQueueItem = ImportBatchQueueItem;

function processingLabel(stage: string | null) {
  if (!stage || !importProcessingStages.includes(stage as (typeof importProcessingStages)[number])) return "Earlier import";
  return importProcessingStatus({ stage: stage as (typeof importProcessingStages)[number], processedRowCount: null, totalRowCount: null }).label;
}

function statusTone(item: ImportQueueItem) {
  if (item.processing_stage === "failed" || item.state === "rejected") return "danger" as const;
  if (item.state === "approved" || item.state === "validated") return "ready" as const;
  if (item.state === "under_review") return "pending" as const;
  return "neutral" as const;
}

function statusLabel(item: ImportQueueItem) {
  if (item.processing_stage === "failed") return "Needs attention";
  if (item.state === "rejected") return "Rejected";
  if (item.state === "approved") return "Approved";
  if (item.state === "validated") return "Ready to review";
  if (item.state === "under_review") return "Under review";
  if (item.processing_stage && importProcessingStages.includes(item.processing_stage as (typeof importProcessingStages)[number])) {
    return processingLabel(item.processing_stage);
  }
  return "Uploaded";
}

function statusDetail(item: ImportQueueItem) {
  if (item.processing_stage === "failed") return importProcessingSafeFailureMessage(item.processing_error_code);
  if (item.processed_row_count != null && item.total_row_count != null) {
    return `${item.processed_row_count} of ${item.total_row_count} source rows processed`;
  }
  return "Progress appears after processing starts";
}

function importKindLabel(kind: string) {
  const text = kind.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function importedAtLabel(createdAt: string) {
  return `Imported ${formatCatDateTime(createdAt, "date unavailable")}`;
}

function rowCountLabel(count: number) {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}

function errorCountLabel(count: number) {
  return `${count} ${count === 1 ? "error" : "errors"}`;
}

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageImports")) redirect("/unauthorized");

  const input = await searchParams;
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
  let queue: ImportBatchQueueItem[] = [];
  let previousCursor: string | null = null;
  let nextCursor: string | null = null;
  let pageSize = DEFAULT_IMPORT_BATCH_PAGE_SIZE;
  let unavailable = false;
  let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  try {
    const context = await resolveWorkspaceContext(user);
    protectedReadMode = getPiiProtectedReadMode();
    const page = await getImportBatchesPage(
      { organizationId: context.organizationId, role: context.role, userId: context.userId },
      { cursor: input.cursor, pageSize: input.limit },
    );
    queue = await hydrateImportBatchQueueFromProtectedPii(context.organizationId, page.items);
    previousCursor = page.previousCursor;
    nextCursor = page.nextCursor;
    pageSize = page.pageSize;
  } catch {
    unavailable = true;
  }

  const firstPageHref = `/imports?limit=${pageSize}`;
  const previousPageHref = previousCursor ? `${firstPageHref}&cursor=${encodeURIComponent(previousCursor)}` : null;
  const nextPageHref = nextCursor ? `${firstPageHref}&cursor=${encodeURIComponent(nextCursor)}` : null;

  return <ProtectedPage permission="manageImports"><div className="content imports-page">
    <PageHeader
      eyebrow="Members"
      title="Data imports"
      description="Upload roster or membership files, review validation results, and resolve issues before approved changes are applied."
    />

    <DisclosureCard
      className="imports-upload-disclosure route-primary-panel"
      title="Start a new import"
      description="Upload an authorized CSV or Excel roster file. Every batch is scanned, validated, and held for review before roster changes can be applied."
    >
      <div className="imports-upload-workflow">
        <ImportPreviewForm previewMode={user.authentication === "preview"} />
      </div>
    </DisclosureCard>

    <SectionCard
      className="imports-queue-card"
      title="Import history"
      description={unavailable ? "The import history could not be loaded safely." : `${queue.length} ${queue.length === 1 ? "batch is" : "batches are"} shown on this page, with processing and review status.`}
      badge={!unavailable && protectedReadMode !== "legacy" ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
    >
      {unavailable ? (
        <UnavailableState title="Imports unavailable" description="We couldn’t load the import history. Existing encrypted imports are left unchanged." />
      ) : (
        <>
          <form action="/imports" className="imports-page-size" method="get">
            <div className="field">
              <label htmlFor="import-page-size">Imports per page</label>
              <select defaultValue={String(pageSize)} id="import-page-size" name="limit">
                {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
            <button className="button secondary" type="submit">Apply</button>
          </form>
          {queue.length === 0 ? (
            <EmptyState
              title={hasCursor ? "No older imports" : "No imports yet"}
              description={hasCursor ? "You’ve reached the end of the import history." : "Upload an authorized CSV or XLSX file to start a review."}
            />
          ) : (
            <DataTable caption="Recent imports" headers={["File", "Type", "Rows", "Status"]}>
              {queue.map((item) => {
                const rows = item.total_row_count ?? item.total_rows;
                return <tr key={item.id}>
                  <td>
                    <strong><Link href={`/imports/${item.id}`}>{item.original_filename ?? "Import"}</Link></strong>
                    <div className="muted">{importedAtLabel(item.created_at)}</div>
                  </td>
                  <td>{importKindLabel(item.import_kind)}</td>
                  <td>
                    {rowCountLabel(rows)}
                    {item.error_count > 0 ? <div className="muted">{errorCountLabel(item.error_count)}</div> : null}
                  </td>
                  <td>
                    <StatusBadge tone={statusTone(item)}>{statusLabel(item)}</StatusBadge>
                    <div className="muted">{statusDetail(item)}</div>
                  </td>
                </tr>;
              })}
            </DataTable>
          )}
          <Pagination
            label={`Showing up to ${pageSize} imports`}
            nextHref={nextPageHref}
            previousHref={previousPageHref ?? (hasCursor ? firstPageHref : null)}
          />
        </>
      )}
    </SectionCard>
  </div></ProtectedPage>;
}
