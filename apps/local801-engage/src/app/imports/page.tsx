import Link from "next/link";
import { redirect } from "next/navigation";
import { DataTable, EmptyState, PageHeader, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ImportPreviewForm } from "@/components/ImportPreviewForm";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { listImportBatches } from "@/lib/import-persistence";
import { hydrateImportBatchQueueFromProtectedPii } from "@/lib/pii-protected-import-read";
import { getPiiProtectedReadMode } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { importProcessingSafeFailureMessage, importProcessingStages, importProcessingStatus } from "@/lib/import-processing";

export const dynamic = "force-dynamic";
function tone(state: string) { return state === "rejected" ? "danger" : state === "validated" ? "ready" : state === "under_review" ? "pending" : "neutral" as const; }
function processingLabel(stage: string | null) {
  if (!stage || !importProcessingStages.includes(stage as (typeof importProcessingStages)[number])) return "Legacy batch";
  return importProcessingStatus({ stage: stage as (typeof importProcessingStages)[number], processedRowCount: null, totalRowCount: null }).label;
}

export default async function ImportsPage() {
  const user = await getPreviewUser(); if (!user) redirect("/sign-in"); if (!can(user.role, "manageImports")) redirect("/unauthorized");
  let queue: Awaited<ReturnType<typeof listImportBatches>> = []; let unavailable = false; let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  try {
    const context = await resolveWorkspaceContext(user);
    protectedReadMode = getPiiProtectedReadMode();
    const legacyQueue = await listImportBatches({ organizationId: context.organizationId, role: context.role, userId: context.userId });
    queue = await hydrateImportBatchQueueFromProtectedPii(context.organizationId, legacyQueue);
  } catch { unavailable = true; }
  const badge = protectedReadMode === "preview"
    ? `Protected-read Preview · ${queue.length} latest`
    : protectedReadMode === "protected"
      ? `Protected PII · ${queue.length} latest`
      : "20 latest batches";
  return <ProtectedPage permission="manageImports"><div className="content">
    <PageHeader eyebrow="Members" title="Data imports" description="Encrypted source intake, persistent validation, set-based identity matching, exception review, and bounded batch decisions. Authoritative execution remains separately gated." />
    <SectionCard title="Review queue" badge={<StatusBadge tone="info">{badge}</StatusBadge>}>
      {unavailable ? <UnavailableState title="Import queue unavailable" description="No synthetic queue is substituted. Existing encrypted batches remain unchanged." /> : queue.length === 0 ? <EmptyState title="No import batches" description="Upload an authorized CSV or XLSX workbook to begin persistent review." /> : <DataTable caption="Import review queue" headers={["Batch", "Type", "Rows", "Processing result", "State"]}>{queue.map((item) => <tr key={item.id}><td><strong><Link href={`/imports/${item.id}`}>{item.original_filename ?? "Import batch"}</Link></strong></td><td>{item.import_kind.replaceAll("_", " ")}</td><td>{item.total_row_count ?? item.total_rows}<div className="muted">{item.error_count} errors</div></td><td>{processingLabel(item.processing_stage)}<div className="muted">{item.processing_stage === "failed" ? importProcessingSafeFailureMessage(item.processing_error_code) : item.processed_row_count != null && item.total_row_count != null ? `${item.processed_row_count} of ${item.total_row_count} source rows processed` : "Progress will appear after parsing begins"}</div></td><td><StatusBadge tone={tone(item.state)}>{item.state.replaceAll("_", " ")}</StatusBadge></td></tr>)}</DataTable>}
    </SectionCard>
    <ImportPreviewForm />
  </div></ProtectedPage>;
}