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
  if (!response.ok) throw new Error(payload.message || "The campaign change could not be completed.");
  return payload;
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <p
    className={feedback.tone === "error" ? "error-text" : undefined}
    style={feedback.tone === "success" ? { color: "var(--success)", fontWeight: 700 } : undefined}
    role={feedback.tone === "error" ? "alert" : "status"}
  >{feedback.message}</p>;
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
        status: String(data.get("status") ?? "draft"),
        startsOn: String(data.get("startsOn") ?? "") || null,
        endsOn: String(data.get("endsOn") ?? "") || null,
      });
      const handle = typeof result.handle === "string" ? result.handle : null;
      setFeedback({ tone: "success", message: "Campaign created." });
      if (handle) router.push(`/campaigns/${handle}`);
      else router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Campaign creation failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field">
      <label htmlFor="new-campaign-name">Campaign name</label>
      <input id="new-campaign-name" name="name" required maxLength={160} />
    </div>
    <div className="field">
      <label htmlFor="new-campaign-status">Starting status</label>
      <select id="new-campaign-status" name="status" defaultValue="draft">
        <option value="draft">Draft</option>
        <option value="active">Active</option>
      </select>
    </div>
    <div className="field">
      <label htmlFor="new-campaign-start">Start date</label>
      <input id="new-campaign-start" name="startsOn" type="date" />
    </div>
    <div className="field">
      <label htmlFor="new-campaign-end">End date</label>
      <input id="new-campaign-end" name="endsOn" type="date" />
    </div>
    <button className="button" type="submit" disabled={pending}>{pending ? "Creating…" : "Create campaign"}</button>
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
      setFeedback({ tone: "error", message: "Choose a campaign change before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/campaigns/${campaignHandle}`, "PATCH", payload);
      setFeedback({ tone: "success", message: "Campaign updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Campaign update failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
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
    <button className="button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save campaign"}</button>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CampaignArchiveButton({ campaignHandle, campaignName }: { campaignHandle: string; campaignName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function archive() {
    if (!window.confirm(`Archive ${campaignName}? Open campaign assignments will also leave the active outreach queues.`)) return;
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/campaigns/${campaignHandle}`, "DELETE");
      router.push("/campaigns");
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Campaign archive failed." });
      setPending(false);
    }
  }

  return <div className="grid">
    <button className="button secondary" type="button" onClick={archive} disabled={pending}>{pending ? "Archiving…" : "Archive closed campaign"}</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}

export function CampaignAssignmentForm({
  campaignHandle,
  personHandle,
  currentAssigneeName,
  currentDueAt,
  assignees,
}: {
  campaignHandle: string;
  personHandle: string;
  currentAssigneeName: string | null;
  currentDueAt: string | null;
  assignees: Option[];
}) {
  const router = useRouter();
  const initialDue = useMemo(() => localDateTime(currentDueAt), [currentDueAt]);
  const [assignee, setAssignee] = useState("__keep__");
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
        setFeedback({ tone: "error", message: "The assignment due date is invalid." });
        return;
      }
      payload.dueAt = parsed;
    }
    if (Object.keys(payload).length === 0) {
      setFeedback({ tone: "error", message: "Choose an organizer or due-date change before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/campaigns/${campaignHandle}/participants/${personHandle}/assignment`, "PATCH", payload);
      setAssignee("__keep__");
      setFeedback({ tone: "success", message: "Campaign assignment updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Campaign assignment update failed." });
    } finally {
      setPending(false);
    }
  }

  return <details>
    <summary>Assign or reschedule</summary>
    <form className="grid" onSubmit={submit} style={{ marginTop: 10, minWidth: 240 }}>
      <div className="field">
        <label htmlFor={`campaign-assignee-${personHandle}`}>CAT organizer</label>
        <select id={`campaign-assignee-${personHandle}`} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="__keep__">Keep current{currentAssigneeName ? ` · ${currentAssigneeName}` : " · unassigned"}</option>
          <option value="__unassigned__">Unassigned</option>
          {assignees.map((option) => <option key={option.handle} value={option.handle}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`campaign-due-${personHandle}`}>Assignment due</label>
        <input id={`campaign-due-${personHandle}`} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
      </div>
      <button className="button secondary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save assignment"}</button>
      <FeedbackMessage feedback={feedback} />
    </form>
  </details>;
}
