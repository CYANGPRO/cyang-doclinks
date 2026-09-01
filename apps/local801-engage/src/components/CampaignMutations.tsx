"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Option = { handle: string; label: string; detail: string | null };
type Feedback = { tone: "error" | "success"; message: string } | null;

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString();
}

async function sendJson(url: string, method: "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: string };
  if (!response.ok) throw new Error(payload.message || "We couldn’t save that campaign change.");
  return payload;
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <div
    className={`form-message${feedback.tone === "success" ? " success" : ""}`}
    role={feedback.tone === "error" ? "alert" : "status"}
  >{feedback.message}</div>;
}

export function CampaignCreateForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await sendJson("/api/campaigns", "POST", {
        name: String(data.get("name") ?? ""),
        startsOn: String(data.get("startsOn") ?? "") || null,
        endsOn: String(data.get("endsOn") ?? "") || null,
      });
      const handle = typeof result.handle === "string" ? result.handle : null;
      setFeedback({ tone: "success", message: "Campaign created." });
      if (handle) router.push(`/campaigns/${handle}`);
      else router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t create the campaign." });
    } finally {
      setPending(false);
    }
  }

  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <div className="field">
        <label htmlFor="new-campaign-name">Campaign name</label>
        <input id="new-campaign-name" name="name" required maxLength={160} />
      </div>
      <div className="field">
        <label htmlFor="new-campaign-start">Start date</label>
        <input id="new-campaign-start" name="startsOn" type="date" />
      </div>
      <div className="field">
        <label htmlFor="new-campaign-end">End date</label>
        <input id="new-campaign-end" name="endsOn" type="date" />
      </div>
    </div>
    <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Creating…" : "Create campaign"}</button></div>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CampaignEditForm({
  campaignHandle,
  initialName,
  initialStatus,
  initialStartsOn,
  initialEndsOn,
}: {
  campaignHandle: string;
  initialName: string;
  initialStatus: "draft" | "active" | "closed";
  initialStartsOn: string | null;
  initialEndsOn: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState(initialStatus);
  const [startsOn, setStartsOn] = useState(initialStartsOn ?? "");
  const [endsOn, setEndsOn] = useState(initialEndsOn ?? "");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (name.trim() !== initialName) payload.name = name;
    if (status !== initialStatus) payload.status = status;
    if (startsOn !== (initialStartsOn ?? "")) payload.startsOn = startsOn || null;
    if (endsOn !== (initialEndsOn ?? "")) payload.endsOn = endsOn || null;
    if (Object.keys(payload).length === 0) {
      setFeedback({ tone: "error", message: "Make a change before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    if (status !== initialStatus) {
      const confirmed = status === "active"
        ? window.confirm("Activate this campaign? Its participant list will be frozen and it cannot return to draft status.")
        : status === "closed"
          ? window.confirm("Close this campaign? Its settings and assignments will become read-only.")
          : true;
      if (!confirmed) {
        setPending(false);
        return;
      }
    }
    try {
      await sendJson(`/api/campaigns/${campaignHandle}`, "PATCH", payload);
      setFeedback({ tone: "success", message: "Campaign updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t update the campaign." });
    } finally {
      setPending(false);
    }
  }

  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <div className="field">
        <label htmlFor="edit-campaign-name">Campaign name</label>
        <input id="edit-campaign-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
      </div>
      <div className="field">
        <label htmlFor="edit-campaign-status">Status</label>
        <select id="edit-campaign-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          {initialStatus === "draft" ? <option value="draft">Draft</option> : null}
          <option value="active">Active</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="edit-campaign-start">Start date</label>
        <input id="edit-campaign-start" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="edit-campaign-end">End date</label>
        <input id="edit-campaign-end" type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
      </div>
    </div>
    <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save campaign"}</button></div>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CampaignDeleteButton({ campaignHandle, campaignName }: { campaignHandle: string; campaignName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function remove() {
    if (!window.confirm(`Delete “${campaignName}”? It will be removed from campaign views and current work lists. This cannot be undone in CAT, but its audit history will be retained.`)) return;
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/campaigns/${campaignHandle}`, "DELETE");
      router.push("/campaigns");
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t delete the campaign." });
      setPending(false);
    }
  }

  return <div className="stack">
    <div className="form-actions compact-actions"><button className="button danger" type="button" onClick={remove} disabled={pending}>{pending ? "Deleting…" : "Delete campaign"}</button></div>
    <FeedbackMessage feedback={feedback} />
  </div>;
}

export function CampaignAssignmentForm({
  campaignHandle,
  personHandle,
  currentAssigneeHandle,
  currentAssigneeName,
  currentDueAt,
  assignees,
  selfAssigneeHandle,
  canAssignOrganizationWide,
}: {
  campaignHandle: string;
  personHandle: string;
  currentAssigneeHandle: string | null;
  currentAssigneeName: string | null;
  currentDueAt: string | null;
  assignees: Option[];
  selfAssigneeHandle: string;
  canAssignOrganizationWide: boolean;
}) {
  const router = useRouter();
  const initialDue = useMemo(() => localDateTime(currentDueAt), [currentDueAt]);
  const assignedToSelf = currentAssigneeHandle === selfAssigneeHandle;
  const assignedToAnother = Boolean(currentAssigneeHandle && !assignedToSelf);
  const [assignee, setAssignee] = useState(
    canAssignOrganizationWide || currentAssigneeHandle ? "__keep__" : selfAssigneeHandle,
  );
  const [dueAt, setDueAt] = useState(initialDue);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (assignee !== "__keep__") payload.assigneeHandle = assignee === "__unassigned__" ? null : assignee;
    if (dueAt !== initialDue) {
      const parsed = isoDateTime(dueAt);
      if (parsed === "invalid") {
        setFeedback({ tone: "error", message: "Enter a valid due date and time." });
        return;
      }
      payload.dueAt = parsed;
    }
    if (Object.keys(payload).length === 0) {
      setFeedback({ tone: "error", message: "Change the organizer or due date before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/campaigns/${campaignHandle}/participants/${personHandle}/assignment`, "PATCH", payload);
      setAssignee("__keep__");
      setFeedback({ tone: "success", message: "Assignment updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t update the assignment." });
    } finally {
      setPending(false);
    }
  }

  if (!canAssignOrganizationWide && assignedToAnother) {
    return <span className="muted">Assigned to another organizer. Ask an LCAT to reassign.</span>;
  }

  const summary = canAssignOrganizationWide
    ? "Assign or reschedule"
    : assignedToSelf
      ? "Update or remove my assignment"
      : "Assign to me";

  return <details className="inline-disclosure">
    <summary>{summary}</summary>
    <form className="stack inline-disclosure-content" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`campaign-assignee-${personHandle}`}>CAT organizer</label>
          <select id={`campaign-assignee-${personHandle}`} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="__keep__">Keep current{currentAssigneeName ? ` · ${currentAssigneeName}` : " · unassigned"}</option>
            {currentAssigneeHandle ? <option value="__unassigned__">Remove assignment</option> : null}
            {assignees.map((option) => <option key={option.handle} value={option.handle}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`campaign-due-${personHandle}`}>Due</label>
          <input id={`campaign-due-${personHandle}`} type="datetime-local" step={60} value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </div>
      </div>
      <div className="form-actions"><button className="button secondary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save assignment"}</button></div>
      <FeedbackMessage feedback={feedback} />
    </form>
  </details>;
}
