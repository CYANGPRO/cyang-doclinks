"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertBanner, SectionCard } from "@/components/DesignSystem";

type ImportReviewSummary = {
  batchId: string;
  sourceFilename: string;
  importKind: string;
  state: string;
  totalRows: number;
  includedRows: number;
  excludedRows: number;
  rejectedRows: number;
  errorCount: number;
  previewRows: Array<{ rowNumber: number; sheetName: string; state: string; values: Record<string, string | null> }>;
};

type DurableAcceptance = {
  accepted: true;
  batchId: string;
  processingStage: "queued";
  workflowStarted: boolean;
  statusLocation: string;
};

export function ImportPreviewForm({ previewMode }: { previewMode: boolean }) {
  const router = useRouter();
  const [summary, setSummary] = useState<ImportReviewSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setSummary(null);

    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch("/api/imports/validate", {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.message ?? "The file could not be validated. No roster changes were made.");
        return;
      }
      if ((body as DurableAcceptance).accepted) {
        router.push((body as DurableAcceptance).statusLocation);
        return;
      }
      setSummary(body);
      router.refresh();
    } catch {
      setMessage("The upload could not be completed. No roster changes were made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadErrors() {
    if (!summary) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/imports/${summary.batchId}/errors.csv`);
      if (!response.ok) {
        setMessage("The error file is temporarily unavailable. Your import review has not changed.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "local801-import-validation-errors.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage("The error file is temporarily unavailable. Your import review has not changed.");
    }
  }

  return (
    <SectionCard
      title="Upload data"
      description="Choose a CSV or Excel roster file. The app scans and validates it, then requires review before any roster changes can be applied."
    >
      {previewMode ? (
        <AlertBanner title="Preview workspace · generated test files only" tone="preview">
          Preview accepts generated identities ending in example.test only. Files must pass the malware scan before they are opened and processed.
        </AlertBanner>
      ) : (
        <AlertBanner title="Authorized Local 801 files" tone="info">
          Production accepts authorized Local 801 CSV and Excel files. Every upload is malware-scanned, validated, and held for approval before data changes are applied.
        </AlertBanner>
      )}
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="file">Workbook or CSV</label>
            <input id="file" name="file" type="file" accept=".xlsx,.csv" required />
            <span className="field-help">Upload the source file as received. It will be scanned and validated before review.</span>
          </div>
          <div className="field">
            <label htmlFor="importKind">What kind of file is this?</label>
            <select id="importKind" name="importKind" defaultValue="current_roster">
              <option value="current_roster">Current roster</option>
              <option value="new_hires">New hires</option>
              <option value="recent_hires">Hired within the last two weeks</option>
              <option value="membership_additions">Membership additions</option>
              <option value="membership_drops">Membership drops</option>
              <option value="legacy_cat">Legacy CAT workbook</option>
            </select>
            <span className="field-help">Choose the source purpose so the right validation rules are used.</span>
          </div>
        </div>

        {previewMode ? <details className="inline-disclosure import-preview-options">
          <summary>Preview test options</summary>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="processingMode">Processing</label>
              <select id="processingMode" name="processingMode" defaultValue="durable">
                <option value="durable">Secure background processing</option>
                <option value="synchronous">Legacy fallback · pre-cutover only</option>
              </select>
              <span className="field-help">Keep standard Preview processing unless you are specifically testing the older pre-cutover path.</span>
            </div>
          </div>
        </details> : <input name="processingMode" type="hidden" value="durable" />}

        <div className="form-actions">
          <button className="button" disabled={busy} type="submit">
            {busy ? "Uploading…" : "Upload for review"}
          </button>
        </div>
      </form>
      <div className="section compact-list import-source-guidance">
        <h3>Supported source datasets</h3>
        <p className="muted">The importer recognizes the column names used by the current Local 801 reports, including preferred name, MAPE hire date, department, section, classification, office or work location, work email, and personal email.</p>
        <ul>
          <li><strong>Membership and personal-email reports:</strong> match people by work email and stage supported profile fields for review.</li>
          <li><strong>New hires and hired within the last two weeks:</strong> create hire-date review records and use the batch effective date only when a row has no valid hire date.</li>
          <li><strong>CAT assignment workbooks:</strong> remain review-only; CAT/LCAT assignment decisions are not applied automatically.</li>
          <li><strong>Phone and address columns:</strong> stay in the encrypted source file and are not applied automatically.</li>
        </ul>
      </div>
      {message ? <p className="form-message" role="alert">{message}</p> : null}
      {summary ? (
        <div className="section import-result">
          <div className="grid metrics-grid">
            <div className="metric import-summary">
              <div className="metric-label">Rows</div>
              <div className="metric-value">{summary.totalRows}</div>
              <div className="metric-foot">{summary.sourceFilename}</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Ready for review</div>
              <div className="metric-value">{summary.includedRows}</div>
              <div className="metric-foot">Rows kept for review</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Rejected</div>
              <div className="metric-value">{summary.rejectedRows}</div>
              <div className="metric-foot">Rows with validation errors</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Errors</div>
              <div className="metric-value">{summary.errorCount}</div>
              <div className="metric-foot">Needs review</div>
            </div>
          </div>
          <div className="toolbar">
            <Link className="button secondary" href={`/imports/${summary.batchId}`}>Open review</Link>
            <button className="button secondary" disabled={summary.errorCount === 0} onClick={downloadErrors} type="button">
              Download errors
            </button>
          </div>
          <div className="section compact-list">
            {summary.previewRows.slice(0, 8).map((row) => (
              <div className="status-row" key={`${row.sheetName}-${row.rowNumber}`}>
                <div>
                  <strong>{row.sheetName} · Row {row.rowNumber}</strong>
                  <div className="muted">Kept for review</div>
                </div>
                <span className="badge">{row.state}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
