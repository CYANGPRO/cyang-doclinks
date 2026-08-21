"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { FollowupAssigneeOption } from "@/lib/follow-ups";

function toLocalInputValue(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function FollowupEditForm({
  employeeHandle,
  followupHandle,
  dueAt,
  assignedToHandle,
  assigneeOptions,
}: {
  employeeHandle: string;
  followupHandle: string;
  dueAt: string;
  assignedToHandle: string | null;
  assigneeOptions: FollowupAssigneeOption[];
}) {
  const router = useRouter();
  const initialDueValue = useMemo(() => toLocalInputValue(dueAt), [dueAt]);
  const [dueValue, setDueValue] = useState(initialDueValue);
  const [assigneeHandle, setAssigneeHandle] = useState(assignedToHandle ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canReassign = assigneeOptions.length > 1
    || (assigneeOptions.length === 1 && assigneeOptions[0]?.handle !== assignedToHandle);

  async function save() {
    if (busy) return;
    setMessage(null);
    setError(null);

    const payload: Record<string, string> = {};
    if (dueValue !== initialDueValue) {
      const parsed = new Date(dueValue);
      if (Number.isNaN(parsed.getTime())) {
        setError("Choose a valid due date and time.");
        return;
      }
      payload.dueAt = parsed.toISOString();
    }
    if (assigneeHandle && assigneeHandle !== (assignedToHandle ?? "")) {
      payload.assigneeHandle = assigneeHandle;
    }
    if (Object.keys(payload).length === 0) {
      setError("Change the due date or CAT organizer before saving.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        `/api/outreach/${encodeURIComponent(employeeHandle)}/followups/${encodeURIComponent(followupHandle)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The follow-up could not be updated.");
        return;
      }
      setMessage("Follow-up updated.");
      router.refresh();
    } catch {
      setError("The follow-up could not be updated. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <details className="section-card">
    <summary><strong>Reschedule or reassign</strong></summary>
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="field">
        <label htmlFor={`followup-due-${followupHandle}`}>Due date and time</label>
        <input
          id={`followup-due-${followupHandle}`}
          type="datetime-local"
          value={dueValue}
          onChange={(event) => setDueValue(event.target.value)}
          disabled={busy}
        />
      </div>

      <div className="field">
        <label htmlFor={`followup-assignee-${followupHandle}`}>Assigned CAT organizer</label>
        <select
          id={`followup-assignee-${followupHandle}`}
          value={assigneeHandle}
          onChange={(event) => setAssigneeHandle(event.target.value)}
          disabled={busy || !canReassign}
        >
          {assigneeOptions.map((option) => <option key={option.handle} value={option.handle}>{option.label}</option>)}
        </select>
        {!canReassign ? <span className="muted">Your role cannot broaden this follow-up beyond the current authorized organizer.</span> : null}
      </div>

      <div className="page-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save follow-up changes"}
        </button>
      </div>
      {message ? <div className="form-message" role="status" style={{ color: "var(--success)" }}>{message}</div> : null}
      {error ? <div className="form-message" role="alert">{error}</div> : null}
    </div>
  </details>;
}

export const __testing = { toLocalInputValue };
