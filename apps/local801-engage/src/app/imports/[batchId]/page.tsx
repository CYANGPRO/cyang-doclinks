import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AlertBanner, DisclosureCard, EmptyState, PageHeader, Pagination, ReviewSummary, SectionCard, StatCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ImportExecutionControl } from "@/components/ImportExecutionControl";
import { ImportExecutionPreflightControls } from "@/components/ImportExecutionPreflightControls";
import { ImportReviewDecisionButton } from "@/components/ImportReviewDecisions";
import { ImportReviewDetailTable } from "@/components/ImportReviewDetailTable";
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
import { ImportOperatorControls } from "@/components/ImportOperatorControls";
import { importProcessingSafeFailureMessage, importProcessingStages, importProcessingStatus } from "@/lib/import-processing";
import { getImportOperatorState } from "@/lib/import-operator-controls";

const sections: Array<{ value: ImportReviewCategory; label: string }> = [
  { value: "needs_attention", label: "Needs attention" }, { value: "existing_with_changes", label: "Existing changes" },
  { value: "proposed_new", label: "New people" }, { value: "unchanged_existing", label: "Unchanged" }, { value: "rejected", label: "Rejected" },
];
function selectedCategory(value: unknown): ImportReviewCategory { const raw = Array.isArray(value) ? value[0] : value; return sections.some((item) => item.value === raw) ? raw as ImportReviewCategory : "needs_attention"; }
function detailHref(batchId: string, category: ImportReviewCategory, search: string, pageSize: number, cursor?: string | null) { const query = new URLSearchParams({ section: category, limit: String(pageSize) }); if (search) query.set("q", search); if (cursor) query.set("cursor", cursor); return `/imports/${batchId}?${query}`; }

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
  let operatorState: Awaited<ReturnType<typeof getImportOperatorState>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user); const actor = { organizationId: context.organizationId, userId: context.userId, role: context.role };
    protectedReadMode = getPiiProtectedReadMode();
    const legacyBatch = await getImportBatch(actor, batchId);
    batchFound = Boolean(legacyBatch);
    if (legacyBatch) batch = await hydrateImportBatchFromProtectedPii(context.organizationId, legacyBatch);
    if (legacyBatch) operatorState = await getImportOperatorState(context, batchId);
    if (batch?.processing_stage === "ready_for_review" && can(user.role, "approveImports")) {
      const [loadedSummary, legacyDetail] = await Promise.all([
        getImportReviewSummary(actor, batchId),
        getImportReviewDetail(actor, batchId, { category, search, cursor: queryValues.cursor, pageSize: queryValues.limit }),
      ]);
      summary = loadedSummary;
      [detail, preflight] = await Promise.all([
        hydrateImportReviewDetailFromProtectedPii(context.organizationId, batchId, legacyDetail),
        getImportExecutionPreflight(actor, batchId, undefined, loadedSummary),
      ]);
    }
  } catch { unavailable = true; batch = null; }
  if (!batchFound && !unavailable) notFound();
  if (!batch) {
    return <ProtectedPage permission="manageImports"><div className="content import-detail-page import-detail-unavailable-page">
      <PageHeader eyebrow="Data imports" title="Import batch unavailable" description="The batch file, processing state, and protected review rows could not be loaded safely." actions={<Link className="button secondary" href="/imports">Back to imports</Link>} />
      <SectionCard><UnavailableState title="Import detail unavailable" description={unavailable ? "The batch and protected import-PII context could not be loaded." : "The import batch is unavailable."} /></SectionCard>
    </div></ProtectedPage>;
  }
  const reviewReady = summary && summary.blockers === 0 && summary.decisions.proposedNew && summary.decisions.existingChanges && !summary.decisions.migrationPending;
  const shrink = summary?.snapshot?.percentChange != null && summary.snapshot.percentChange <= -20;
  const stage = batch.processing_stage && importProcessingStages.includes(batch.processing_stage as (typeof importProcessingStages)[number])
    ? batch.processing_stage as (typeof importProcessingStages)[number] : null;
  const processing = stage ? importProcessingStatus({ stage, processedRowCount: batch.processed_row_count, totalRowCount: batch.total_row_count }) : null;
  const processingActive = Boolean(stage && !["ready_for_review", "failed", "cancelled"].includes(stage));
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

  return <ProtectedPage permission="manageImports"><div className="content import-detail-page">
    <ImportProcessingRefresh active={processingActive} batchId={batchId} />
    <PageHeader eyebrow="Data imports" title={batch.original_filename ?? "Import batch"} description="Review validation exceptions, approve the current decision sets, and verify the exact execution plan before applying authorized roster changes." actions={<div className="page-actions import-detail-header-actions"><Link className="button secondary import-detail-return-action" href="/imports">Back to imports</Link><a className="button secondary import-detail-errors-action" href={`/api/imports/${batch.id}/errors.csv`}>Download errors</a></div>} />
    {processing ? <SectionCard className="import-processing-status" title="Batch processing" description={`Current state: ${processing.label}.`}>
      <p>{stage === "failed" ? importProcessingSafeFailureMessage(batch.processing_error_code) : stage === "cancelled" ? "Processing was cancelled safely. No authoritative roster changes were made." : processing.detail ?? "The encrypted source and progress are tracked in the database. You may close this page safely."}</p>
      {operatorState ? <ImportOperatorControls batchId={batchId} state={operatorState.state} cancellationRequestedAt={operatorState.cancellationRequestedAt} /> : null}
    </SectionCard> : null}
    {!summary ? <SectionCard>{processingActive ? <EmptyState title="Review is being prepared" description="This page refreshes from Neon-backed processing state. Closing the browser does not stop the worker." /> : <UnavailableState title="Review summary unavailable" description={stage === "failed" ? "Processing failed safely. No authoritative roster data was changed." : stage === "cancelled" ? "Processing was cancelled. Requeue it when the source is ready." : "The batch remains unchanged."} />}</SectionCard> : <>
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

      <SectionCard className="import-review-detail-card" title="Rows requiring review" description="Filter the batch by validation category, search visible fields, and inspect up to the selected number of rows per page." badge={protectedReadMode !== "legacy" ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}>
        <nav className="toolbar import-review-section-tabs" aria-label="Import review sections">{sections.map((item) => <Link aria-current={category === item.value ? "page" : undefined} className={`button ${category === item.value ? "" : "secondary"}`} href={detailHref(batchId, item.value, search, detail?.pageSize ?? 50)} key={item.value}>{item.label}</Link>)}</nav>
        <form className="filter-bar import-review-filter" action={`/imports/${batchId}`} method="get"><input type="hidden" name="section" value={category} /><div className="field"><label htmlFor="review-search">Search this batch</label><input id="review-search" name="q" maxLength={100} defaultValue={search} /></div><div className="field"><label htmlFor="review-limit">Rows per page</label><select id="review-limit" name="limit" defaultValue={String(detail?.pageSize ?? 50)}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div><button className="button" type="submit">Apply</button></form>
        {!detail || detail.rows.length === 0 ? <EmptyState title="No rows in this review set" description="Try another category or search term." /> : <>
          <ImportReviewDetailTable batchId={batchId} detail={detail} />
          <Pagination label={`Showing up to ${detail.pageSize} rows`} nextHref={detail.nextCursor ? detailHref(batchId, category, search, detail.pageSize, detail.nextCursor) : null} />
        </>}
      </SectionCard>

      <DisclosureCard className="import-safeguards-disclosure" title="How this import is protected" description="Review the safeguards that protect member information and prevent unapproved roster changes.">
        {protectedReadMode === "preview" ? <AlertBanner title="Protected-read Preview" tone="preview">The source filename and visible review-row names/work email on this page are resolved from encrypted import PII companions while the database remains in dual-write acceptance mode.</AlertBanner> : null}
        {protectedReadMode === "protected" ? <AlertBanner title="Member information is protected">Names, email addresses, identifiers, and matching information remain encrypted and are accessed only through protected records.</AlertBanner> : null}
        <AlertBanner title="Approval required before changes are applied" tone="info">Uploading or reviewing a file does not change the member roster. The file must pass its security checks, the review must be complete, and an authorized user must confirm the exact reviewed changes before they are applied.</AlertBanner>
      </DisclosureCard>

      {summary.snapshot ? <DisclosureCard className="import-snapshot-disclosure" title="Roster snapshot comparison" description={summary.snapshot.percentChange == null ? "This is the first approved roster snapshot available for comparison." : `The proposed roster changes the approved snapshot by ${summary.snapshot.percentChange.toFixed(1)}%.`} defaultOpen={shrink}>
        {shrink ? <AlertBanner title="Large roster shrink requires explicit acknowledgement" tone="danger">Absence from this file is not a membership drop, employment separation, archive, or deletion. The acknowledgement is bound to the exact current execution fingerprint.</AlertBanner> : null}
        <ReviewSummary>
          <StatCard label="Previous" value={summary.snapshot.previous} detail={summary.snapshot.previousDate ?? "No approved snapshot"} />
          <StatCard label="Proposed" value={summary.snapshot.proposed} detail="Eligible current set" />
          <StatCard label="Entering" value={summary.snapshot.entering} detail="Matched/new vs previous" />
          <StatCard label="Leaving" value={summary.snapshot.leaving} detail="Absence only; no mutation" tone={shrink ? "danger" : "default"} />
          <StatCard label="Net" value={summary.snapshot.net > 0 ? `+${summary.snapshot.net}` : summary.snapshot.net} detail="Proposed minus previous" />
        </ReviewSummary>
      </DisclosureCard> : null}

      <SectionCard className="import-review-decisions" title="Batch review decisions" description={reviewReady ? "All required batch-level review decisions are complete." : "One or more required batch-level review decisions are still incomplete."}>
        {summary.decisions.migrationPending ? <AlertBanner title="Review-decision migration is not available" tone="warning">Decision controls remain unavailable until the forward migration is reviewed and separately applied.</AlertBanner> : null}
        <div className="grid two-grid">
          <div className="section-card"><h3>Proposed new people · {summary.counts.proposedNew}</h3><p className="muted">The decision is bound to the current server-derived set hash. A changed identity set makes it stale.</p>{summary.counts.proposedNew ? <ImportReviewDecisionButton accepted={summary.decisions.proposedNew} batchId={batchId} decisionType="allow_proposed_new" disabled={summary.decisions.migrationPending} expectedHash={summary.hashes.proposedNew} label="Allow current proposed-new set" /> : <StatusBadge tone="ready">No decision needed</StatusBadge>}</div>
          <div className="section-card"><h3>Existing changes · {summary.counts.existingWithChanges}</h3><p className="muted">One acknowledgement covers the current change set; unchanged exact matches require no clicks.</p>{summary.counts.existingWithChanges ? <ImportReviewDecisionButton accepted={summary.decisions.existingChanges} batchId={batchId} decisionType="acknowledge_existing_changes" disabled={summary.decisions.migrationPending} expectedHash={summary.hashes.existingChanges} label="Acknowledge current change set" /> : <StatusBadge tone="ready">No decision needed</StatusBadge>}</div>
        </div>
        <p className="muted">Routine review requires at most {summary.clicksRequired} batch decisions, regardless of row count. Conflicts and rejected rows remain blockers.</p>
      </SectionCard>

      <DisclosureCard className="import-execution-disclosure" title="Final approval and apply" description={preflight?.ready ? "The reviewed changes are ready for final confirmation and application." : "Complete each listed requirement before applying the reviewed changes."} defaultOpen={Boolean(preflight?.ready)}>
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
          {preflight.reasons.length ? <div className="section-card"><h3>Requirements still to complete</h3><ul>{preflight.reasons.map((item) => <li key={item.code}><strong>{item.code.replaceAll("_", " ")}</strong> — {item.message}</li>)}</ul></div> : <AlertBanner title="Ready to apply">The current reviewed changes have passed all required checks.</AlertBanner>}

          {preflight.ready && preflight.fingerprint && preflight.fingerprintShort ? (
            executionMode ? (
              <div className="section-card">
                <h3>{executionMode === "protected" ? "Protected authoritative execution" : "Synthetic Preview execution"}</h3>
                <p className="muted">The server independently rechecks organization, role, clean scan, review decisions, dates, duplicate acknowledgement, shrink acknowledgement, idempotency, and the exact current fingerprints. In protected mode it additionally prepares target-bound encrypted mutations and applies them under row locks in one transaction.</p>
                <ImportExecutionControl batchId={batchId} fingerprint={preflight.fingerprint} fingerprintShort={preflight.fingerprintShort} mode={executionMode} />
              </div>
            ) : (
              <AlertBanner title="Applying changes is temporarily unavailable" tone="warning">Your review has been saved and no member records have changed. An 801 Administrator must complete the protected import setup before this batch can be applied.</AlertBanner>
            )
          ) : null}
        </div>}
      </DisclosureCard>
    </>}
  </div></ProtectedPage>;
}
