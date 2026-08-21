import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertBanner, DataTable, EmptyState, PageHeader, Pagination, ReviewSummary, SectionCard, StatCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ImportExecutionControl } from "@/components/ImportExecutionControl";
import { ImportExecutionPreflightControls } from "@/components/ImportExecutionPreflightControls";
import { ImportReviewDecisionButton } from "@/components/ImportReviewDecisions";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getImportExecutionPreflight } from "@/lib/import-execution-preflight";
import { getImportBatch } from "@/lib/import-persistence";
import { getImportReviewDetail, getImportReviewSummary, type ImportReviewCategory } from "@/lib/import-review";
import { hydrateImportBatchFromProtectedPii, hydrateImportReviewDetailFromProtectedPii } from "@/lib/pii-protected-import-read";
import { getPiiProtectedReadMode } from "@/lib/pii-protected-read";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { ImportProcessingRefresh } from "@/components/ImportProcessingRefresh";
import { importProcessingSafeFailureMessage, importProcessingStages, importProcessingStatus } from "@/lib/import-processing";

const sections: Array<{ value: ImportReviewCategory; label: string }> = [
  { value: "needs_attention", label: "Needs attention" }, { value: "existing_with_changes", label: "Existing changes" },
  { value: "proposed_new", label: "New people" }, { value: "unchanged_existing", label: "Unchanged" }, { value: "rejected", label: "Rejected" },
];
function selectedCategory(value: unknown): ImportReviewCategory { const raw = Array.isArray(value) ? value[0] : value; return sections.some((item) => item.value === raw) ? raw as ImportReviewCategory : "needs_attention"; }
function detailHref(batchId: string, category: ImportReviewCategory, search: string, cursor?: string | null) { const query = new URLSearchParams({ section: category }); if (search) query.set("q", search); if (cursor) query.set("cursor", cursor); return `/imports/${batchId}?${query}`; }

export default async function ImportDetailPage({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ batchId }, queryValues] = await Promise.all([params, searchParams]);
  const user = await getPreviewUser(); if (!user) redirect("/sign-in"); if (!can(user.role, "manageImports")) redirect("/unauthorized");
  const category = selectedCategory(queryValues.section); const search = typeof queryValues.q === "string" ? queryValues.q : "";
  let batch: Awaited<ReturnType<typeof getImportBatch>> | null = null;
  let summary: Awaited<ReturnType<typeof getImportReviewSummary>> | null = null;
  let detail: Awaited<ReturnType<typeof getImportReviewDetail>> | null = null;
  let preflight: Awaited<ReturnType<typeof getImportExecutionPreflight>> | null = null;
  let batchFound = false;
  let unavailable = false;
  let protectedReadMode: "legacy" | "preview" | "protected" = "legacy";
  try {
    const context = await resolveWorkspaceContext(user); const actor = { organizationId: context.organizationId, userId: context.userId, role: context.role };
    protectedReadMode = getPiiProtectedReadMode();
    const legacyBatch = await getImportBatch(actor, batchId);
    batchFound = Boolean(legacyBatch);
    if (legacyBatch) batch = await hydrateImportBatchFromProtectedPii(context.organizationId, legacyBatch);
    if (batch?.processing_stage === "ready_for_review" && can(user.role, "approveImports")) {
      const [loadedSummary, legacyDetail, loadedPreflight] = await Promise.all([
        getImportReviewSummary(actor, batchId),
        getImportReviewDetail(actor, batchId, { category, search, cursor: queryValues.cursor, pageSize: queryValues.limit }),
        getImportExecutionPreflight(actor, batchId),
      ]);
      summary = loadedSummary;
      detail = await hydrateImportReviewDetailFromProtectedPii(context.organizationId, batchId, legacyDetail);
      preflight = loadedPreflight;
    }
  } catch { unavailable = true; batch = null; }
  if (!batchFound && !unavailable) notFound();
  if (!batch) {
    return <ProtectedPage permission="manageImports"><div className="content">
      <PageHeader eyebrow="Exception-based import review" title="Import batch" description="Protected import review detail." actions={<Link className="button secondary" href="/imports">Back to imports</Link>} />
      <SectionCard><UnavailableState title="Import detail unavailable" description={unavailable ? "The batch and protected import-PII context could not be loaded." : "The import batch is unavailable."} /></SectionCard>
    </div></ProtectedPage>;
  }
  const reviewReady = summary && summary.blockers === 0 && summary.decisions.proposedNew && summary.decisions.existingChanges && !summary.decisions.migrationPending;
  const shrink = summary?.snapshot?.percentChange != null && summary.snapshot.percentChange <= -20;
  const stage = batch.processing_stage && importProcessingStages.includes(batch.processing_stage as (typeof importProcessingStages)[number])
    ? batch.processing_stage as (typeof importProcessingStages)[number] : null;
  const processing = stage ? importProcessingStatus({ stage, processedRowCount: batch.processed_row_count, totalRowCount: batch.total_row_count }) : null;
  const processingActive = Boolean(stage && !["ready_for_review", "failed"].includes(stage));
  const duplicateNeedsAck = Boolean(preflight?.source.duplicateApprovedSource && !preflight.plan.duplicateSourceAcknowledged);
  const shrinkNeedsAck = Boolean(preflight?.shrink.required && !preflight.plan.largeRosterShrinkAcknowledged);
  const protectedExecutionEnabled = process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"
    && process.env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"
    && process.env.LOCAL801_PII_BACKFILL_ENABLED !== "1"
    && process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"
    && process.env.LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"
    && process.env.LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1";
  const previewExecutionEnabled = protectedReadMode !== "protected"
    && process.env.VERCEL_ENV !== "production"
    && process.env.LOCAL801_PREVIEW_AUTH_ENABLED === "1"
    && process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1";
  const executionMode = protectedExecutionEnabled ? "protected" as const : previewExecutionEnabled ? "synthetic_preview" as const : null;

  return <ProtectedPage permission="manageImports"><div className="content">
    <ImportProcessingRefresh active={processingActive} />
    <PageHeader eyebrow="Exception-based import review" title={batch.original_filename ?? "Import batch"} description="The batch is classified server-side against the current protected identity set. Authoritative execution is disabled by default and requires an exact reviewed fingerprint plus the environment-specific execution gates." actions={<a className="button secondary" href={`/api/imports/${batch.id}/errors.csv`}>Download errors</a>} />
    {protectedReadMode === "preview" ? <AlertBanner title="Protected-read Preview" tone="preview">The source filename and visible review-row names/work email on this page are resolved from encrypted import PII companions while the database remains in dual-write acceptance mode.</AlertBanner> : null}
    {protectedReadMode === "protected" ? <AlertBanner title="Protected PII mode">The source filename, review-row direct PII, matching, and authoritative execution path use protected companions and blind indexes. Legacy direct-PII placeholders are not used for review decisions.</AlertBanner> : null}
    <AlertBanner title="Authoritative execution remains explicitly gated" tone="preview">No import executes merely because this code is deployed. Execution still requires the separate authoritative flag, a clean immutable source, current review decisions, an exact fingerprint confirmation, and either the synthetic Preview gate or the fully verified protected-only database gates.</AlertBanner>
    {processing ? <SectionCard title="Processing status" badge={<StatusBadge tone={stage === "failed" ? "danger" : stage === "ready_for_review" ? "ready" : "pending"}>{processing.label}</StatusBadge>}>
      <p>{stage === "failed" ? importProcessingSafeFailureMessage(batch.processing_error_code) : processing.detail ?? "The encrypted source and progress are tracked in the database. You may close this page safely."}</p>
    </SectionCard> : null}
    {!summary ? <SectionCard>{processingActive ? <EmptyState title="Review is being prepared" description="This page refreshes from Neon-backed processing state. Closing the browser does not stop the worker." /> : <UnavailableState title="Review summary unavailable" description={stage === "failed" ? "Processing failed safely. No authoritative roster data was changed." : "The batch remains unchanged."} />}</SectionCard> : <>
      <section className="metrics-grid" aria-label="Import classification summary">
        <StatCard label={summary.counts.metadataComplete ? "Total source rows" : "Persisted review rows"} value={summary.counts.total} detail={summary.counts.metadataComplete ? "Included plus excluded" : "Legacy batch · excluded count unavailable"} tone="brand" />
        <StatCard label="Unchanged existing" value={summary.counts.unchangedExisting} detail="Zero manual confirmations" />
        <StatCard label="Existing with changes" value={summary.counts.existingWithChanges} detail="One set acknowledgement" tone="attention" />
        <StatCard label="Proposed new" value={summary.counts.proposedNew} detail="One set decision" tone="attention" />
        <StatCard label="Needs attention" value={summary.counts.needsAttention} detail="Blocking exceptions" tone={summary.counts.needsAttention ? "danger" : "default"} />
        <StatCard label="Excluded" value={summary.counts.excluded ?? "—"} detail={summary.counts.excluded == null ? "Unavailable for legacy batch" : "Not included in review"} />
        <StatCard label="Rejected" value={summary.counts.rejected} detail="Correct and re-upload" tone={summary.counts.rejected ? "danger" : "default"} />
      </section>

      {summary.counts.blockingErrors ? <AlertBanner title="Blocking validation errors" tone="danger">{summary.counts.blockingErrors} batch-scoped error{summary.counts.blockingErrors === 1 ? "" : "s"} must be resolved. File-level errors and malformed row links block readiness even when no review row can display them.</AlertBanner> : null}

      {summary.snapshot ? <SectionCard title="Snapshot change" badge={<StatusBadge tone={shrink ? "danger" : "info"}>{summary.snapshot.percentChange == null ? "First snapshot" : `${summary.snapshot.percentChange.toFixed(1)}%`}</StatusBadge>}>
        {shrink ? <AlertBanner title="Large roster shrink requires explicit acknowledgement" tone="danger">Absence from this file is not a membership drop, employment separation, archive, or deletion. The acknowledgement is bound to the exact current execution fingerprint.</AlertBanner> : null}
        <ReviewSummary>
          <StatCard label="Previous" value={summary.snapshot.previous} detail={summary.snapshot.previousDate ?? "No approved snapshot"} />
          <StatCard label="Proposed" value={summary.snapshot.proposed} detail="Eligible current set" />
          <StatCard label="Entering" value={summary.snapshot.entering} detail="Matched/new vs previous" />
          <StatCard label="Leaving" value={summary.snapshot.leaving} detail="Absence only; no mutation" tone={shrink ? "danger" : "default"} />
          <StatCard label="Net" value={summary.snapshot.net > 0 ? `+${summary.snapshot.net}` : summary.snapshot.net} detail="Proposed minus previous" />
        </ReviewSummary>
      </SectionCard> : null}

      <SectionCard title="Batch review decisions" badge={<StatusBadge tone={reviewReady ? "ready" : "blocked"}>{reviewReady ? "Review complete" : "Review incomplete"}</StatusBadge>}>
        {summary.decisions.migrationPending ? <AlertBanner title="Review-decision migration is not available" tone="warning">Decision controls remain unavailable until the forward migration is reviewed and separately applied.</AlertBanner> : null}
        <div className="grid two-grid">
          <div className="section-card"><h3>Proposed new people · {summary.counts.proposedNew}</h3><p className="muted">The decision is bound to the current server-derived set hash. A changed identity set makes it stale.</p>{summary.counts.proposedNew ? <ImportReviewDecisionButton accepted={summary.decisions.proposedNew} batchId={batchId} decisionType="allow_proposed_new" disabled={summary.decisions.migrationPending} expectedHash={summary.hashes.proposedNew} label="Allow current proposed-new set" /> : <StatusBadge tone="ready">No decision needed</StatusBadge>}</div>
          <div className="section-card"><h3>Existing changes · {summary.counts.existingWithChanges}</h3><p className="muted">One acknowledgement covers the current change set; unchanged exact matches require no clicks.</p>{summary.counts.existingWithChanges ? <ImportReviewDecisionButton accepted={summary.decisions.existingChanges} batchId={batchId} decisionType="acknowledge_existing_changes" disabled={summary.decisions.migrationPending} expectedHash={summary.hashes.existingChanges} label="Acknowledge current change set" /> : <StatusBadge tone="ready">No decision needed</StatusBadge>}</div>
        </div>
        <p className="muted">Routine review requires at most {summary.clicksRequired} batch decisions, regardless of row count. Conflicts and rejected rows remain blockers.</p>
      </SectionCard>

      <SectionCard title="Authoritative execution preflight" badge={<StatusBadge tone={preflight?.ready ? "ready" : "blocked"}>{preflight?.ready ? "Preflight ready" : "Execution blocked"}</StatusBadge>}>
        {!preflight ? <UnavailableState title="Execution preflight unavailable" description="No authoritative changes are enabled when the current execution set cannot be fingerprinted safely." /> : <div className="grid">
          {preflight.plan.migrationPending ? <AlertBanner title="Execution-plan migration must be applied" tone="warning">The shrink-acknowledgement columns are not available in the connected database. Execution remains blocked.</AlertBanner> : null}
          <div className="grid two-grid">
            <div className="section-card"><h3>Execution fingerprint</h3><p><strong>{preflight.fingerprintShort ?? "Unavailable"}</strong></p><p className="muted">Derived from the immutable source hash, persisted row hashes, current identity-review sets, counts, import kind, and execution dates. The write transaction recomputes the protected source/review/mutation state before any authoritative mutation can commit.</p></div>
            <div className="section-card"><h3>Source gate</h3><p>{preflight.source.fileCount} source file · malware {preflight.source.malwareStatus ?? "unknown"}</p><p className="muted">{preflight.source.duplicateApprovedSource ? "Matches a previously approved source." : "No previously approved source with this SHA-256 was found."}</p></div>
          </div>
          <ImportExecutionPreflightControls
            batchId={batchId}
            importKind={preflight.importKind}
            snapshotDate={preflight.plan.snapshotDate}
            effectiveDate={preflight.plan.effectiveDate}
            duplicateSourceNeedsAck={duplicateNeedsAck}
            largeShrinkNeedsAck={shrinkNeedsAck}
            migrationPending={preflight.plan.migrationPending}
            fingerprint={preflight.fingerprint}
          />
          {preflight.reasons.length ? <div className="section-card"><h3>Blocking conditions</h3><ul>{preflight.reasons.map((item) => <li key={item.code}><strong>{item.code.replaceAll("_", " ")}</strong> — {item.message}</li>)}</ul></div> : <AlertBanner title="Preflight requirements satisfied">The exact current reviewed set satisfies the execution preflight.</AlertBanner>}

          {preflight.ready && preflight.fingerprint && preflight.fingerprintShort ? (
            executionMode ? (
              <div className="section-card">
                <h3>{executionMode === "protected" ? "Protected authoritative execution" : "Synthetic Preview execution"}</h3>
                <p className="muted">The server independently rechecks organization, role, clean scan, review decisions, dates, duplicate acknowledgement, shrink acknowledgement, idempotency, and the exact current fingerprints. In protected mode it additionally prepares target-bound encrypted mutations and applies them under row locks in one transaction.</p>
                <ImportExecutionControl batchId={batchId} fingerprint={preflight.fingerprint} fingerprintShort={preflight.fingerprintShort} mode={executionMode} />
              </div>
            ) : (
              <AlertBanner title="Executor installed but disabled" tone="warning">Keep the authoritative and protected execution flags disabled until the required migrations and synthetic acceptance checks are complete. Deploying this code does not enable roster writes.</AlertBanner>
            )
          ) : null}
        </div>}
      </SectionCard>

      <SectionCard title="Review detail" badge={<StatusBadge tone="info">{protectedReadMode === "preview" ? "Protected-read Preview · 50 rows by default" : protectedReadMode === "protected" ? "Protected PII · 50 rows by default" : "50 rows by default"}</StatusBadge>}>
        <nav className="toolbar" aria-label="Import review sections">{sections.map((item) => <Link aria-current={category === item.value ? "page" : undefined} className={`button ${category === item.value ? "" : "secondary"}`} href={detailHref(batchId, item.value, search)} key={item.value}>{item.label}</Link>)}</nav>
        <form className="filter-bar" action={`/imports/${batchId}`} method="get"><input type="hidden" name="section" value={category} /><div className="field"><label htmlFor="review-search">Search this batch</label><input id="review-search" name="q" maxLength={100} defaultValue={search} /></div><div className="field"><label htmlFor="review-limit">Rows per page</label><select id="review-limit" name="limit" defaultValue={String(detail?.pageSize ?? 50)}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div><button className="button" type="submit">Apply</button></form>
        {!detail || detail.rows.length === 0 ? <EmptyState title="No rows in this review set" description="Try another category or search term." /> : <>
          <DataTable caption={`${category.replaceAll("_", " ")} import rows`} headers={["Source", "Person", "Work", "Status"]}>{detail.rows.map((row, index) => <tr key={`${row.sheet_name}-${row.source_row_number}-${index}`}><td>{row.sheet_name}<div className="muted">Row {row.source_row_number}</div></td><td><strong>{[row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed row"}</strong><div className="muted">{row.work_email || "No work email"}</div></td><td>{row.department || "Department unavailable"}<div className="muted">{row.classification || "Classification unavailable"}</div></td><td><StatusBadge tone={row.category === "needs_attention" || row.category === "rejected" ? "danger" : row.category === "unchanged_existing" ? "ready" : "pending"}>{row.category.replaceAll("_", " ")}</StatusBadge></td></tr>)}</DataTable>
          <Pagination label={`Showing up to ${detail.pageSize} rows`} nextHref={detail.nextCursor ? detailHref(batchId, category, search, detail.nextCursor) : null} />
        </>}
      </SectionCard>
    </>}
  </div></ProtectedPage>;
}
