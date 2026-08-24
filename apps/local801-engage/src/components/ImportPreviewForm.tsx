"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertBanner, SectionCard, StatusBadge } from "@/components/DesignSystem";

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

export function ImportPreviewForm({ durablePreviewAvailable = false }: { durablePreviewAvailable?: boolean }) {
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
        setMessage(body.message ?? "Import validation failed. No roster changes were made.");
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
        setMessage("The error file is temporarily unavailable. The import review remains unchanged.");
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
      setMessage("The error file is temporarily unavailable. The import review remains unchanged.");
    }
  }

  return (
    <SectionCard title="Upload for persistent review" description="Upload an authorized roster workbook for encrypted, malware-scanned review before any approved roster changes." badge={<StatusBadge tone="preview">No automatic roster changes</StatusBadge>}>
      <AlertBanner title="Review before execution">Uploads are scanned, encrypted, and retained for exception review. No authoritative roster change occurs until an authorized approver confirms the reviewed execution set.</AlertBanner>
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="file">Workbook or CSV</label>
          <input id="file" name="file" type="file" accept=".xlsx,.csv" required />
        </div>
        <div className="field">
          <label htmlFor="processingMode">Processing mode</label>
          <select id="processingMode" name="processingMode" defaultValue="synchronous">
            <option value="synchronous">Encrypted protected review</option>
            {durablePreviewAvailable ? <option value="durable_preview">Durable Preview worker · synthetic CSV only</option> : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="importKind">Source type</label>
          <select id="importKind" name="importKind" defaultValue="current_roster">
            <option value="current_roster">Current roster</option>
            <option value="new_hires">New hires</option>
            <option value="membership_additions">Membership additions</option>
            <option value="membership_drops">Membership drops</option>
            <option value="legacy_cat">Legacy CAT workbook</option>
          </select>
        </div>
        <button className="button" disabled={busy} type="submit">
          {busy ? "Uploading securely..." : "Upload for review"}
        </button>
      </form>
      {message ? <p className="form-message" role="alert">{message}</p> : null}
      {summary ? (
        <div className="section">
          <div className="grid metrics-grid">
            <div className="metric import-summary">
              <div className="metric-label">Rows</div>
              <div className="metric-value">{summary.totalRows}</div>
              <div className="metric-foot">{summary.sourceFilename}</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Included</div>
              <div className="metric-value">{summary.includedRows}</div>
              <div className="metric-foot">Persisted review rows</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Rejected</div>
              <div className="metric-value">{summary.rejectedRows}</div>
              <div className="metric-foot">Persisted validation errors</div>
            </div>
            <div className="metric import-summary">
              <div className="metric-label">Validation errors</div>
              <div className="metric-value">{summary.errorCount}</div>
              <div className="metric-foot">Requires review</div>
            </div>
          </div>
          <div className="toolbar">
            <Link className="button secondary" href={`/imports/${summary.batchId}`}>Open review</Link>
            <button className="button secondary" disabled={summary.errorCount === 0} onClick={downloadErrors} type="button">
              Download errors
            </button>
          </div>
          <div className="section">
            {summary.previewRows.slice(0, 8).map((row) => (
              <div className="status-row" key={`${row.sheetName}-${row.rowNumber}`}>
                <div>
                  <strong>{row.sheetName} · Row {row.rowNumber}</strong>
                  <div className="muted">Normalized row retained for review</div>
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
