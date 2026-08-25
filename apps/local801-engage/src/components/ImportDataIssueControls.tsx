"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ImportDataIssue } from "@/lib/import-data-issues";

export function ImportDataIssueControls({ issue }: { issue: ImportDataIssue }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function change(action: "link_existing" | "create_new" | "clear" | "exclude", personHandle?: string) {
    const confirmation = action === "link_existing"
      ? "Attach this import row to the selected employee? The exact work-email match, if one exists, will still take priority."
      : action === "create_new"
        ? "Mark this row to create a new employee when the reviewed import is approved? No employee is created yet."
        : action === "exclude"
          ? "Remove this row from this import? The source and audit history will be retained."
          : null;
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(`${action}:${personHandle ?? ""}`);
    setError("");
    try {
      const response = await fetch(`/api/data-issues/imports/${issue.batchId}/rows/${issue.rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(personHandle ? { personHandle } : {}) }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "This data issue could not be updated.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This data issue could not be updated.");
    } finally {
      setBusy("");
    }
  }

  return <div className="import-data-issue-controls">
    {issue.exactWorkEmailMatch ? <div className="data-issue-email-lock">
      <strong>Exact work-email match protected</strong>
      <span>CAT will keep the active employee matched by work email. Manual choices cannot override it.</span>
    </div> : <>
      <div className="possible-match-heading">
        <strong>Possible employee matches</strong>
        <span className="muted">Review the evidence. CAT never attaches a possible match automatically.</span>
      </div>
      {issue.candidates.length ? <div className="possible-match-list">
        {issue.candidates.map((candidate) => <article className={`possible-match${candidate.selected ? " selected" : ""}`} key={candidate.personHandle}>
          <div>
            <div className="possible-match-name"><strong>{candidate.displayName}</strong><span>{candidate.employeeReference}</span></div>
            <div className="possible-match-work">{[candidate.department, candidate.classification, candidate.workLocation].filter(Boolean).join(" · ") || "Work details unavailable"}</div>
            <div className="possible-match-reasons">{candidate.reasons.join(" · ")} <span>{candidate.score}% possible match</span></div>
          </div>
          <button className="button secondary" type="button" disabled={Boolean(busy) || candidate.selected}
            onClick={() => change("link_existing", candidate.personHandle)}>
            {candidate.selected ? "Attached" : busy === `link_existing:${candidate.personHandle}` ? "Attaching…" : "Attach employee"}
          </button>
        </article>)}
      </div> : <p className="muted possible-match-empty">No reasonable name-and-workplace matches were found. Search the Directory before creating a new record if you are unsure.</p>}
    </>}

    <div className="import-data-issue-actions">
      {!issue.exactWorkEmailMatch && issue.category !== "rejected" ? <button className="button" type="button" disabled={Boolean(busy) || issue.decision === "create_new"} onClick={() => change("create_new")}> 
        {issue.decision === "create_new" ? "New employee selected" : busy === "create_new:" ? "Saving…" : "Create new on approval"}
      </button> : null}
      {issue.decision ? <button className="button tertiary" type="button" disabled={Boolean(busy)} onClick={() => change("clear")}>
        {busy === "clear:" ? "Clearing…" : "Clear decision"}
      </button> : null}
      <button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => change("exclude")}>
        {busy === "exclude:" ? "Removing…" : "Remove from import"}
      </button>
    </div>
    <p className="muted import-data-issue-footnote">Creating a new employee happens only after the full import review and approval. Removing a row keeps the original source and audit history.</p>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </div>;
}
