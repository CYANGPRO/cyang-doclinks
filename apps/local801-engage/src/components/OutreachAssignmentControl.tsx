"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type AssigneeOption = { handle: string; label: string; current?: boolean };

export function OutreachAssignmentControl({
  memberHandle,
  memberName,
  assignees,
}: {
  memberHandle: string;
  memberName: string;
  assignees: AssigneeOption[];
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

  if (assignees.length === 0) {
    return <p className="muted">No active LCAT or CAT accounts are available to assign.</p>;
  }

  return <div className="stack">
    <div className="form-grid">
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
    </div>
    <div className="form-actions">
      <button className="button secondary" type="button" disabled={busy || !selected} onClick={assign}>
        {busy ? "Assigning…" : "Assign organizer"}
      </button>
    </div>
    {message ? <div className="form-message success" role="status">{message}</div> : null}
    {error ? <div className="form-message" role="alert">{error}</div> : null}
  </div>;
}
