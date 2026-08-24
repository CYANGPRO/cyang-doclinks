"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AssigneeOption = { handle: string; label: string; current?: boolean };

export function OutreachAssignmentControl({
  memberHandle,
  memberName,
  assignees,
  canDelete,
  returnHref,
}: {
  memberHandle: string;
  memberName: string;
  assignees: AssigneeOption[];
  canDelete: boolean;
  returnHref: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (!selected || busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(memberHandle)}/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeHandle: selected }),
      });
      const body = await response.json().catch(() => ({})) as { message?: unknown; unchanged?: unknown };
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The outreach assignment could not be saved.");
        return;
      }
      setMessage(body.unchanged === true ? "This organizer is already assigned." : "Primary outreach organizer assigned.");
      setSelected("");
      router.refresh();
    } catch {
      setError("The outreach assignment could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !canDelete) return;
    const confirmed = window.confirm(`Delete ${memberName} from member outreach? The direct assignment will close. Campaign assignments, follow-ups, conversations, and audit history will be retained.`);
    if (!confirmed) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(memberHandle)}/assignment`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({})) as { message?: unknown };
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The member outreach assignment could not be deleted.");
        return;
      }
      router.push(returnHref);
      router.refresh();
    } catch {
      setError("The member outreach assignment could not be deleted. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="stack">
    {assignees.length > 0 ? <div className="form-grid">
        <div className="field">
          <label htmlFor="outreach-primary-organizer">Primary organizer</label>
          <select
            id="outreach-primary-organizer"
            aria-label={`Assign outreach for ${memberName}`}
            value={selected}
            disabled={busy}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose an LCAT or CAT</option>
            {assignees.map((assignee) => <option key={assignee.handle} value={assignee.handle}>
              {assignee.label}{assignee.current ? " (you)" : ""}
            </option>)}
          </select>
        </div>
      </div> : <p className="muted">No active LCAT or CAT accounts are available to assign.</p>}
    <div className="form-actions">
      {assignees.length > 0 ? <button className="button secondary" type="button" disabled={busy || !selected} onClick={assign}>
          {busy ? "Saving…" : "Assign organizer"}
        </button> : null}
      {canDelete ? <button className="button danger" type="button" disabled={busy} onClick={remove}>
          {busy ? "Working…" : "Delete from member outreach"}
        </button> : null}
    </div>
    {message ? <div className="form-message success" role="status">{message}</div> : null}
    {error ? <div className="form-message" role="alert">{error}</div> : null}
  </div>;
}
