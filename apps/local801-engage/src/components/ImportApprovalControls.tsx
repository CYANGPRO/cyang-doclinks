"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ImportApprovalReview, ResolutionType } from "@/lib/import-approval";

type SavedResolution = {
  resolutionType: ResolutionType;
} | null;

type MutationResponse = { message?: string };

async function responseMessage(response: Response) {
  try {
    const body = await response.json() as MutationResponse;
    return body.message ?? "The approval review could not be updated.";
  } catch {
    return "The approval review could not be updated.";
  }
}

export function ImportResolutionControl({
  batchId,
  rowId,
  status,
  rowState,
  hasAuthoritativeIdentifier,
  hasRequiredNames,
  savedResolution,
}: {
  batchId: string;
  rowId: string;
  status: "exact_match" | "no_exact_match" | "conflicting_match" | "rejected";
  rowState: string;
  hasAuthoritativeIdentifier: boolean;
  hasRequiredNames: boolean;
  savedResolution: SavedResolution;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function mutate(method: "PUT" | "DELETE", resolutionType?: ResolutionType) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/imports/${encodeURIComponent(batchId)}/rows/${encodeURIComponent(rowId)}/resolution`,
        {
          method,
          headers: resolutionType ? { "Content-Type": "application/json" } : undefined,
          body: resolutionType ? JSON.stringify({ resolutionType }) : undefined,
        },
      );
      if (!response.ok) {
        setMessage(await responseMessage(response));
        return;
      }
      router.refresh();
    } catch {
      setMessage("The approval review could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  if (savedResolution) {
    return (
      <div className="section">
        <strong>Resolution saved</strong>
        <div className="muted">
          {savedResolution.resolutionType === "confirm_existing"
            ? "Confirm the persisted exact existing-person match."
            : "Create a new person only when a later approval is executed."}
        </div>
        <div className="toolbar">
          <button className="button secondary" disabled={busy} onClick={() => mutate("DELETE")} type="button">
            {busy ? "Clearing..." : "Clear resolution"}
          </button>
        </div>
        {message ? <p className="muted">{message}</p> : null}
      </div>
    );
  }

  const rejected = status === "rejected" || rowState === "rejected";
  const canCreate = status === "no_exact_match" && hasAuthoritativeIdentifier && hasRequiredNames && !rejected;
  return (
    <div className="section">
      <strong>Resolution</strong>
      {status === "conflicting_match" ? (
        <p className="muted">Blocked. Authoritative identifiers conflict; correct and re-upload the source.</p>
      ) : rejected ? (
        <p className="muted">Blocked. A validation issue must be corrected and re-uploaded.</p>
      ) : status === "exact_match" ? (
        <div className="toolbar">
          <button className="button secondary" disabled={busy} onClick={() => mutate("PUT", "confirm_existing")} type="button">
            {busy ? "Saving..." : "Confirm existing match"}
          </button>
        </div>
      ) : canCreate ? (
        <div className="toolbar">
          <button className="button secondary" disabled={busy} onClick={() => mutate("PUT", "create_new")} type="button">
            {busy ? "Saving..." : "Create new person on approval"}
          </button>
        </div>
      ) : (
        <p className="muted">Blocked. First name, last name, and an employee identifier, member identifier, or work email are required.</p>
      )}
      {message ? <p className="muted">{message}</p> : null}
    </div>
  );
}

function kindLabel(kind: NonNullable<ImportApprovalReview["batch"]>["importKind"]) {
  return kind.replaceAll("_", " ");
}

export function ImportApprovalPanel({ batchId, review }: { batchId: string; review: ImportApprovalReview | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!review?.batch) {
    return (
      <section className="section card">
        <div className="section-heading"><h2>Approval readiness</h2><span className="badge">Unavailable</span></div>
        <p className="muted">Approval planning is temporarily unavailable. No roster changes have been made.</p>
      </section>
    );
  }

  const { batch, readiness, preview } = review;

  async function mutate(path: string, method: "PUT" | "POST", body?: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        setMessage(await responseMessage(response));
        return;
      }
      router.refresh();
    } catch {
      setMessage("The approval review could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  function savePlan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutate(`/api/imports/${encodeURIComponent(batchId)}/approval-plan`, "PUT", {
      snapshotDate: form.get("snapshotDate"),
      effectiveDate: form.get("effectiveDate"),
    });
  }

  const dateControl = batch.importKind === "current_roster"
    ? { name: "snapshotDate", label: "Snapshot date", value: batch.snapshotDate, help: "Required; never inferred from the filename or upload time." }
    : batch.importKind === "new_hires"
      ? { name: "effectiveDate", label: "Fallback effective date", value: batch.effectiveDate, help: "Used only when a row does not provide a hire date." }
      : batch.importKind === "membership_additions" || batch.importKind === "membership_drops"
        ? { name: "effectiveDate", label: "Effective date", value: batch.effectiveDate, help: "Required for membership event planning." }
        : null;

  return (
    <>
      <section className="section card">
        <div className="section-heading"><h2>Approval plan</h2><span className="badge">{kindLabel(batch.importKind)}</span></div>
        {batch.importKind === "legacy_cat" ? (
          <p className="muted">Approval is not supported for Legacy CAT imports.</p>
        ) : dateControl ? (
          <form className="grid" onSubmit={savePlan}>
            <div className="field">
              <label htmlFor={dateControl.name}>{dateControl.label}</label>
              <input defaultValue={dateControl.value ?? ""} id={dateControl.name} name={dateControl.name} type="date" />
              <div className="muted">{dateControl.help}</div>
            </div>
            <button className="button secondary" disabled={busy} type="submit">{busy ? "Saving..." : "Save approval plan"}</button>
          </form>
        ) : null}
        {batch.duplicateSourceExists ? (
          <div className="section">
            <strong>An identical source file was previously approved.</strong>
            {batch.duplicateSourceAcknowledged ? (
              <p className="muted">Duplicate source acknowledged for this batch.</p>
            ) : (
              <div className="toolbar">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => mutate(`/api/imports/${encodeURIComponent(batchId)}/duplicate-source-ack`, "POST")}
                  type="button"
                >
                  {busy ? "Saving..." : "Acknowledge duplicate source"}
                </button>
              </div>
            )}
          </div>
        ) : null}
        {message ? <p className="muted">{message}</p> : null}
      </section>

      <section className="section card">
        <div className="section-heading">
          <h2>Approval readiness</h2>
          <span className="badge">{readiness.ready ? "READY FOR APPROVAL EXECUTION" : "BLOCKED"}</span>
        </div>
        {readiness.ready ? (
          <p><strong>Ready for approval execution.</strong> Phase 2B-2 is not enabled yet.</p>
        ) : (
          <div>
            {readiness.reasons.map((reason) => (
              <div className="status-row" key={reason.code}>
                <div>{reason.message}</div>
                <span className="badge">{reason.count ?? reason.code}</span>
              </div>
            ))}
          </div>
        )}
        {preview.fingerprint ? <p className="muted">Approval fingerprint: {preview.fingerprint}</p> : null}
      </section>

      <section className="section card">
        <div className="section-heading"><h2>Approval change preview</h2><span className="badge">50-row detail maximum</span></div>
        <p><strong>This is a preview only. No roster changes have been made.</strong></p>
        <div className="grid metrics-grid">
          <div className="metric"><div className="metric-label">Existing confirmed</div><div className="metric-value">{preview.counts.confirmedExisting}</div></div>
          <div className="metric"><div className="metric-label">New people planned</div><div className="metric-value">{preview.counts.plannedNewPeople}</div></div>
          <div className="metric"><div className="metric-label">Profile fields</div><div className="metric-value">{preview.counts.profileFieldUpdates}</div></div>
          <div className="metric"><div className="metric-label">Work email changes</div><div className="metric-value">{preview.counts.workEmailChanges}</div></div>
          <div className="metric"><div className="metric-label">Identifier attachments</div><div className="metric-value">{preview.counts.identifierAttachments}</div></div>
          <div className="metric"><div className="metric-label">Membership changes</div><div className="metric-value">{preview.counts.membershipStatusChanges}</div></div>
          <div className="metric"><div className="metric-label">Employment events</div><div className="metric-value">{preview.counts.employmentEvents}</div></div>
          <div className="metric"><div className="metric-label">Membership events</div><div className="metric-value">{preview.counts.membershipEvents}</div></div>
        </div>
        {batch.importKind === "current_roster" ? (
          <div className="muted">
            <p>
              Snapshot {preview.snapshotDate ?? "date not set"}: {preview.counts.snapshotRows} planned rows,
              {` ${preview.counts.enteringSnapshot} entering and ${preview.counts.leavingSnapshot} leaving the snapshot.`}
              {" "}Snapshot absence never plans a drop, separation, archive, or deletion.
            </p>
            <p>
              {preview.previousSnapshot
                ? `Previous approved snapshot: ${preview.previousSnapshot.date} with ${preview.previousSnapshot.rowCount} rows.`
                : "No previous approved snapshot is available for comparison."}
            </p>
          </div>
        ) : null}
        {batch.importKind === "membership_drops" ? <p className="muted">No person is planned for archive or deletion.</p> : null}
        {preview.rows.map((row) => (
          <div className="status-row" key={row.importRowId}>
            <div>
              <strong>{row.sheetName} · Row {row.sourceRowNumber} · {row.displayName}</strong>
              <div className="muted">{row.resolutionType === "confirm_existing" ? "Confirm existing person" : "Create new person on approval"}</div>
              {row.profileChanges.map((change) => (
                <div key={change.field}>{change.field.replaceAll("_", " ")}: {change.from ?? "blank"} → {change.to}</div>
              ))}
              {row.workEmailAction === "create_primary" ? <div>Work email: create the imported primary email.</div> : null}
              {row.workEmailAction === "replace_primary" ? (
                <div>Work email: archive the old primary as history, then create/set the imported primary email.</div>
              ) : null}
              {row.identifierActions.map((action) => <div key={action}>Identifier: {action.replaceAll("_", " ")}</div>)}
              {row.plannedMembershipStatus ? <div>Planned membership status: {row.plannedMembershipStatus}</div> : null}
              {batch.importKind === "membership_additions" && row.membershipAction === "none" ? (
                <div>Membership: already a member; no status change or duplicate addition event.</div>
              ) : null}
              {batch.importKind === "membership_drops" && row.membershipAction === "none" ? (
                <div>Membership: already a nonmember; no status change or duplicate drop event.</div>
              ) : null}
              {row.eventAction !== "none" ? <div>Planned {row.eventAction} event{row.eventDate ? ` on ${row.eventDate}` : ""}</div> : null}
            </div>
            <span className="badge">preview</span>
          </div>
        ))}
        <p className="muted">The entire batch was evaluated server-side; detailed rows are limited to {preview.detailLimit}.</p>
      </section>
    </>
  );
}
