"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type {
  EngagementAssigneeOption,
  EngagementAssignmentOption,
} from "@/lib/engagement-recording";
import type { EmployeeActionDefinition, EmployeeActionProfileItem } from "@/lib/employee-actions";
import { followupSuggestionForOutcome, suggestedLocalDateTime } from "@/lib/follow-up-suggestions";

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
  ["cat_members", "All CATs"],
  ["cat_leads", "LCATs and administrators"],
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

type ActionResponse = "willing" | "considering" | "declined" | "completed";

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
  const [outcome, setOutcome] = useState("contacted");
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [followupDueAt, setFollowupDueAt] = useState("");
  const [lastEngagementHandle, setLastEngagementHandle] = useState<string | null>(null);
  const [actionSelections, setActionSelections] = useState<Record<string, ActionResponse | "">>({});
  const currentByAction = useMemo(() => new Map(currentActions.map((item) => [item.handle, item.response])), [currentActions]);
  const followupSuggestion = useMemo(() => followupSuggestionForOutcome(outcome), [outcome]);

  function applyFollowupSuggestion() {
    if (!followupSuggestion) return;
    setFollowupEnabled(true);
    setFollowupDueAt(suggestedLocalDateTime(followupSuggestion.days));
  }

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
        setError(typeof result.message === "string" ? result.message : "The conversation could not be saved.");
        return;
      }
      const engagementHandle = typeof result.engagementHandle === "string" ? result.engagementHandle : null;
      setLastEngagementHandle(engagementHandle);
      setMessage("Conversation saved. Any action-readiness changes you make now will be linked to it.");
      setOutcome("contacted");
      setFollowupEnabled(false);
      setFollowupDueAt("");
      formElement.reset();
      router.refresh();
    } catch {
      setError("The conversation could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function updateAction(actionHandle: string, responseValue: ActionResponse) {
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
        setError(typeof result.message === "string" ? result.message : "Action readiness could not be updated.");
        return;
      }
      setMessage("Action readiness updated.");
      router.refresh();
    } catch {
      setError("Action readiness could not be updated. Try again.");
    } finally {
      setActionBusy(null);
    }
  }

  async function declineAll() {
    if (actionBusy || !window.confirm("Record that this person currently declines all organizing actions? Their earlier history will stay on file.")) return;
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
        setError(typeof result.message === "string" ? result.message : "Action readiness could not be updated.");
        return;
      }
      setMessage("Action readiness updated to declines all actions.");
      router.refresh();
    } catch {
      setError("Action readiness could not be updated. Try again.");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="stack">
      <section className="section-card">
        <div className="section-heading"><div><h3>Record a conversation</h3><p>Choose what happened so the next person can understand the contact at a glance.</p></div></div>
        <form onSubmit={submit} className="stack">
          <div className="form-grid">
            <div className="field"><label htmlFor="contactMethod">Contact method</label><select id="contactMethod" name="contactMethod" defaultValue="in_person" required>{contactMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="outcome">What happened?</label><select id="outcome" name="outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)} required>{outcomes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div className="field"><label htmlFor="occurredAt">When</label><input id="occurredAt" name="occurredAt" type="datetime-local" step={60} /><small>Leave this blank to use the current time. Entered times use your device time zone.</small></div>
            <div className="field"><label htmlFor="assignmentHandle">Context</label><select id="assignmentHandle" name="assignmentHandle" defaultValue={assignments[0]?.handle || ""} required={!organizationWide}>{organizationWide ? <option value="">General outreach</option> : null}{assignments.map((assignment) => <option key={assignment.handle} value={assignment.handle}>{assignment.label} · {assignment.relationship}</option>)}</select></div>
          </div>

          <div className="field"><label htmlFor="note">Note (optional)</label><textarea id="note" name="note" maxLength={2000} rows={4} placeholder="Keep it factual and useful. Leave out sensitive details that are not needed for the work." /></div>
          <div className="field"><label htmlFor="noteVisibility">Who can see this note?</label><select id="noteVisibility" name="noteVisibility" defaultValue="assigned_scope">{noteVisibilities.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>

          {outcome === "wrong_contact" ? <div className="workflow-suggestion" role="note">
            <div><strong>Fix the contact info</strong><div className="muted">Record what happened, then send the corrected phone, email, or address to Membership Data. You can suggest a change, but you can’t replace the official contact information yourself.</div></div>
            <Link className="button secondary" href={`/outreach/${employeeHandle}/contact`}>Open contact info</Link>
          </div> : null}

          {followupSuggestion ? <div className="workflow-suggestion" role="note">
            <div><strong>Suggested next step: {followupSuggestion.label}</strong><div className="muted">{followupSuggestion.reason} Nothing is scheduled unless you use the suggestion and save the conversation.</div></div>
            <button className="button secondary" type="button" onClick={applyFollowupSuggestion}>Use suggestion</button>
          </div> : null}

          <label className="choice-field"><input type="checkbox" checked={followupEnabled} onChange={(event: { target: { checked: boolean } }) => { setFollowupEnabled(event.target.checked); if (!event.target.checked) setFollowupDueAt(""); }} /><span><strong>Create a follow-up</strong><span className="field-help choice-help">Schedule the next contact while you’re recording this conversation.</span></span></label>
          {followupEnabled ? <div className="form-grid">
            <div className="field"><label htmlFor="followupDueAt">Follow-up due</label><input id="followupDueAt" name="followupDueAt" type="datetime-local" step={60} value={followupDueAt} onChange={(event) => setFollowupDueAt(event.target.value)} required /></div>
            <div className="field"><label htmlFor="assigneeHandle">Assign to</label><select id="assigneeHandle" name="assigneeHandle" defaultValue={assignees.find((item) => item.current)?.handle || assignees[0]?.handle || ""} required>{assignees.map((assignee) => <option key={assignee.handle} value={assignee.handle}>{assignee.label}{assignee.current ? " (me)" : ""}</option>)}</select></div>
          </div> : null}
          <div className="form-actions"><button className="button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save conversation"}</button></div>
        </form>
      </section>

      <section className="section-card">
        <div className="section-heading"><div><h3>Action readiness</h3><p>Keep the current response up to date. Earlier responses stay in the history.</p></div></div>
        {lastEngagementHandle ? <p className="muted">Changes you make now will be linked to the conversation you just saved.</p> : null}
        {actionDefinitions.length === 0 ? <div className="empty-state"><strong>No actions are set up yet</strong><p>Create the action catalog before recording willingness.</p></div> : <div className="stack">
          {actionDefinitions.map((action) => {
            const current = currentByAction.get(action.handle) as ActionResponse | undefined;
            const selected = actionSelections[action.handle] ?? current ?? "";
            const fieldId = `action-response-${action.handle}`;
            const currentOption = current ? action.responseOptions.find((option) => option.value === current) : null;
            const availableOptions = action.responseOptions.filter((option) => option.enabled);
            return <article className="section-card" key={action.handle}>
              <div className="section-heading"><div><h3>{action.label}</h3><p>Engagement level {action.engagementLevel} · Current: {currentOption?.label || current || "not recorded"}</p></div></div>
              <div className="form-grid action-readiness-editor">
                <div className="field">
                  <label htmlFor={fieldId}>Response</label>
                  <select id={fieldId} value={selected} onChange={(event) => setActionSelections((previous) => ({ ...previous, [action.handle]: event.target.value as ActionResponse | "" }))}>
                    <option value="">Choose a response</option>
                    {currentOption && !currentOption.enabled ? <option value={currentOption.value} disabled>{currentOption.label} (no longer available)</option> : null}
                    {availableOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="field action-readiness-submit">
                  <button className="button secondary" type="button" disabled={Boolean(actionBusy) || !selected || selected === current} onClick={() => selected && updateAction(action.handle, selected)}>{actionBusy === action.handle ? "Saving…" : "Update response"}</button>
                </div>
              </div>
            </article>;
          })}
        </div>}
        <div className="form-actions"><button className="button danger" type="button" disabled={Boolean(actionBusy)} onClick={declineAll}>{actionBusy === "declines_all" ? "Saving…" : "Declines all actions"}</button></div>
      </section>

      {message ? <div className="form-message success" role="status">{message}</div> : null}
      {error ? <div className="form-message" role="alert">{error}</div> : null}
    </div>
  );
}
