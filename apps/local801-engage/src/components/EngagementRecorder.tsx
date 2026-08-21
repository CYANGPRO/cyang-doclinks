"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type {
  EngagementAssigneeOption,
  EngagementAssignmentOption,
} from "@/lib/engagement-recording";
import type { EmployeeActionDefinition, EmployeeActionProfileItem } from "@/lib/employee-actions";

const contactMethods = [
  ["in_person", "In person"],
  ["phone", "Phone"],
  ["text", "Text message"],
  ["email", "Email"],
  ["video_call", "Video call"],
  ["other", "Other"],
] as const;

const outcomes = [
  ["contacted", "Contacted"],
  ["no_answer", "No answer"],
  ["left_message", "Left message"],
  ["declined_conversation", "Declined conversation"],
  ["wrong_contact", "Wrong contact information"],
  ["not_available", "Not available"],
] as const;

const noteVisibilities = [
  ["assigned_scope", "Assigned outreach team"],
  ["writer_only", "Only me"],
  ["cat_members", "All CAT members"],
  ["cat_leads", "CAT leads and administrators"],
  ["administrators", "Administrators only"],
] as const;


function localDateTimeToIso(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

type Props = {
  employeeHandle: string;
  assignments: EngagementAssignmentOption[];
  assignees: EngagementAssigneeOption[];
  actionDefinitions: EmployeeActionDefinition[];
  currentActions: EmployeeActionProfileItem[];
  organizationWide: boolean;
};

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<{ message?: unknown; engagementHandle?: unknown }>;
}

export function EngagementRecorder({
  employeeHandle,
  assignments,
  assignees,
  actionDefinitions,
  currentActions,
  organizationWide,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [lastEngagementHandle, setLastEngagementHandle] = useState<string | null>(null);
  const currentByAction = useMemo(() => new Map(currentActions.map((item) => [item.handle, item.response])), [currentActions]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const noteText = String(form.get("note") || "");
      const body = {
        assignmentHandle: form.get("assignmentHandle") || null,
        contactMethod: form.get("contactMethod"),
        outcome: form.get("outcome"),
        occurredAt: localDateTimeToIso(form.get("occurredAt")),
        note: noteText.trim() ? { text: noteText, visibility: form.get("noteVisibility") } : null,
        followup: followupEnabled ? {
          dueAt: localDateTimeToIso(form.get("followupDueAt")),
          assigneeHandle: form.get("assigneeHandle") || null,
        } : null,
      };
      const response = await fetch(`/api/outreach/${encodeURIComponent(employeeHandle)}/engagements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await responseBody(response);
      if (!response.ok) {
        setError(typeof result.message === "string" ? result.message : "The engagement could not be recorded.");
        return;
      }
      const engagementHandle = typeof result.engagementHandle === "string" ? result.engagementHandle : null;
      setLastEngagementHandle(engagementHandle);
      setMessage("Engagement recorded. Action Readiness updates made now will be linked to this conversation.");
      setFollowupEnabled(false);
      formElement.reset();
      router.refresh();
    } catch {
      setError("The engagement could not be recorded. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAction(actionHandle: string, responseValue: "willing" | "considering" | "declined" | "completed") {
    if (actionBusy) return;
    setActionBusy(actionHandle);
    setError(null);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(employeeHandle)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionHandle, response: responseValue, engagementHandle: lastEngagementHandle }),
      });
      const result = await responseBody(response);
      if (!response.ok) {
        setError(typeof result.message === "string" ? result.message : "Action Readiness could not be updated.");
        return;
      }
      setMessage("Action Readiness updated.");
      router.refresh();
    } catch {
      setError("Action Readiness could not be updated. Try again.");
    } finally {
      setActionBusy(null);
    }
  }

  async function declineAll() {
    if (actionBusy || !window.confirm("Record that this employee currently declines all organizing actions? Previous history is preserved.")) return;
    setActionBusy("declines_all");
    setError(null);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(employeeHandle)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posture: "declines_all", engagementHandle: lastEngagementHandle }),
      });
      const result = await responseBody(response);
      if (!response.ok) {
        setError(typeof result.message === "string" ? result.message : "Action Readiness could not be updated.");
        return;
      }
      setMessage("Employee posture updated to declines all actions.");
      router.refresh();
    } catch {
      setError("Action Readiness could not be updated. Try again.");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="stack">
      <section className="section-card">
        <div className="section-heading"><div><h3>Record conversation</h3><p>Use standardized outcomes so engagement reporting stays consistent.</p></div></div>
        <form onSubmit={submit} className="stack">
          <div className="review-summary">
            <div className="field"><label htmlFor="contactMethod">Contact method</label><select id="contactMethod" name="contactMethod" defaultValue="in_person" required>{contactMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="outcome">Outcome</label><select id="outcome" name="outcome" defaultValue="contacted" required>{outcomes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="occurredAt">Occurred at</label><input id="occurredAt" name="occurredAt" type="datetime-local" /><small className="muted">Leave blank to use the current time. Entered times use your device time zone.</small></div>
            <div className="field"><label htmlFor="assignmentHandle">Outreach context</label><select id="assignmentHandle" name="assignmentHandle" defaultValue={assignments[0]?.handle || ""} required={!organizationWide}>{organizationWide ? <option value="">General outreach</option> : null}{assignments.map((assignment) => <option key={assignment.handle} value={assignment.handle}>{assignment.label} · {assignment.relationship}</option>)}</select></div>
          </div>

          <div className="field"><label htmlFor="note">Restricted narrative note (optional)</label><textarea id="note" name="note" maxLength={2000} rows={4} placeholder="Keep this factual and operational. Do not enter unnecessary sensitive information." /></div>
          <div className="field"><label htmlFor="noteVisibility">Note visibility</label><select id="noteVisibility" name="noteVisibility" defaultValue="assigned_scope">{noteVisibilities.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={followupEnabled} onChange={(event: { target: { checked: boolean } }) => setFollowupEnabled(event.target.checked)} />Create a follow-up</label>
          {followupEnabled ? <div className="review-summary">
            <div className="field"><label htmlFor="followupDueAt">Follow-up due</label><input id="followupDueAt" name="followupDueAt" type="datetime-local" required /></div>
            <div className="field"><label htmlFor="assigneeHandle">Assign to</label><select id="assigneeHandle" name="assigneeHandle" defaultValue={assignees.find((item) => item.current)?.handle || assignees[0]?.handle || ""} required>{assignees.map((assignee) => <option key={assignee.handle} value={assignee.handle}>{assignee.label}{assignee.current ? " (me)" : ""}</option>)}</select></div>
          </div> : null}
          <button className="button" type="submit" disabled={busy}>{busy ? "Recording…" : "Record engagement"}</button>
        </form>
      </section>

      <section className="section-card">
        <div className="section-heading"><div><h3>Update Action Readiness</h3><p>These are cumulative employee signals. Previous history is preserved.</p></div></div>
        {lastEngagementHandle ? <p className="muted">Updates in this session will be linked to the conversation just recorded.</p> : null}
        {actionDefinitions.length === 0 ? <div className="empty-state"><strong>No employee actions configured</strong><p>Create the organizing action catalog before recording willingness.</p></div> : <div className="stack">
          {actionDefinitions.map((action) => <article className="section-card" key={action.handle}>
            <div className="section-heading"><div><h3>{action.label}</h3><p>Engagement level {action.engagementLevel} · Current: {currentByAction.get(action.handle) || "not recorded"}</p></div></div>
            <div className="page-actions">
              {(["willing", "considering", "declined", "completed"] as const).map((value) => <button key={value} className="button secondary" type="button" disabled={Boolean(actionBusy)} onClick={() => updateAction(action.handle, value)}>{actionBusy === action.handle ? "Saving…" : value[0].toUpperCase() + value.slice(1)}</button>)}
            </div>
          </article>)}
        </div>}
        <div className="page-actions"><button className="button danger" type="button" disabled={Boolean(actionBusy)} onClick={declineAll}>{actionBusy === "declines_all" ? "Saving…" : "Declines all actions"}</button></div>
      </section>

      {message ? <div className="form-message success" role="status">{message}</div> : null}
      {error ? <div className="form-message" role="alert">{error}</div> : null}
    </div>
  );
}
