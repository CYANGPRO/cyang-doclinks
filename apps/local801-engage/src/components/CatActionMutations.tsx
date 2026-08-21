"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Option = { handle: string; label: string; detail: string | null };
type Task = {
  handle: string;
  title: string;
  status: string;
  assigneeName: string | null;
  dueAt: string | null;
};

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
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The CAT action change could not be completed.");
  return payload;
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <p className={feedback.tone === "error" ? "error-text" : "muted"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>;
}

export function CatActionCreateForm({ cycles }: { cycles: Option[] }) {
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
      await sendJson("/api/cat-actions", "POST", {
        name: String(data.get("name") ?? ""),
        status: String(data.get("status") ?? "draft"),
        contractCycleHandle: String(data.get("contractCycleHandle") ?? "") || null,
      });
      form.reset();
      setFeedback({ tone: "success", message: "CAT action created." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT action creation failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field">
      <label htmlFor="new-cat-action-name">Action name</label>
      <input id="new-cat-action-name" name="name" required maxLength={160} />
    </div>
    <div className="field">
      <label htmlFor="new-cat-action-status">Starting status</label>
      <select id="new-cat-action-status" name="status" defaultValue="draft">
        <option value="draft">Draft</option>
        <option value="active">Active</option>
      </select>
    </div>
    <div className="field">
      <label htmlFor="new-cat-action-cycle">Contract cycle</label>
      <select id="new-cat-action-cycle" name="contractCycleHandle" defaultValue="">
        <option value="">No contract cycle</option>
        {cycles.map((cycle) => <option key={cycle.handle} value={cycle.handle}>{cycle.label}{cycle.detail ? ` · ${cycle.detail}` : ""}</option>)}
      </select>
    </div>
    <button className="button" type="submit" disabled={pending}>{pending ? "Creating…" : "Create CAT action"}</button>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CatActionEditForm({
  actionHandle,
  initialName,
  initialStatus,
  cycles,
}: {
  actionHandle: string;
  initialName: string;
  initialStatus: "draft" | "active" | "closed";
  cycles: Option[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState(initialStatus);
  const [cycle, setCycle] = useState("__keep__");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (name.trim() !== initialName) payload.name = name;
    if (status !== initialStatus) payload.status = status;
    if (cycle !== "__keep__") payload.contractCycleHandle = cycle === "__none__" ? null : cycle;
    if (Object.keys(payload).length === 0) {
      setFeedback({ tone: "error", message: "Choose a CAT action change before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/cat-actions/${actionHandle}`, "PATCH", payload);
      setCycle("__keep__");
      setFeedback({ tone: "success", message: "CAT action updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT action update failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field">
      <label htmlFor="edit-cat-action-name">Action name</label>
      <input id="edit-cat-action-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
    </div>
    <div className="field">
      <label htmlFor="edit-cat-action-status">Status</label>
      <select id="edit-cat-action-status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
        <option value="draft">Draft</option>
        <option value="active">Active</option>
        <option value="closed">Closed</option>
      </select>
    </div>
    <div className="field">
      <label htmlFor="edit-cat-action-cycle">Contract cycle</label>
      <select id="edit-cat-action-cycle" value={cycle} onChange={(event) => setCycle(event.target.value)}>
        <option value="__keep__">Keep current cycle</option>
        <option value="__none__">Remove contract cycle</option>
        {cycles.map((option) => <option key={option.handle} value={option.handle}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}
      </select>
    </div>
    <button className="button" type="submit" disabled={pending}>{pending ? "Saving…" : "Save action"}</button>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CatActionArchiveButton({ actionHandle, actionName }: { actionHandle: string; actionName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function archive() {
    if (!window.confirm(`Archive ${actionName}? The action and its tasks will leave the active operational views.`)) return;
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/cat-actions/${actionHandle}`, "DELETE");
      router.push("/cat-actions");
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT action archive failed." });
      setPending(false);
    }
  }

  return <div className="grid">
    <button className="button secondary" type="button" onClick={archive} disabled={pending}>{pending ? "Archiving…" : "Archive closed action"}</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}

export function CatActionTaskCreateForm({ actionHandle, assignees }: { actionHandle: string; assignees: Option[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const due = String(data.get("dueAt") ?? "");
    const dueAt = isoDateTime(due);
    if (dueAt === "invalid") {
      setFeedback({ tone: "error", message: "The task due date is invalid." });
      setPending(false);
      return;
    }
    try {
      await sendJson(`/api/cat-actions/${actionHandle}/tasks`, "POST", {
        title: String(data.get("title") ?? ""),
        assigneeHandle: String(data.get("assigneeHandle") ?? "") || null,
        ...(due ? { dueAt } : {}),
      });
      form.reset();
      setFeedback({ tone: "success", message: "CAT task created." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT task creation failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field">
      <label htmlFor="new-cat-task-title">Task</label>
      <input id="new-cat-task-title" name="title" required maxLength={240} />
    </div>
    <div className="field">
      <label htmlFor="new-cat-task-assignee">Assignee</label>
      <select id="new-cat-task-assignee" name="assigneeHandle" defaultValue="">
        <option value="">Unassigned</option>
        {assignees.map((option) => <option key={option.handle} value={option.handle}>{option.label}</option>)}
      </select>
    </div>
    <div className="field">
      <label htmlFor="new-cat-task-due">Due date and time</label>
      <input id="new-cat-task-due" name="dueAt" type="datetime-local" />
    </div>
    <button className="button" type="submit" disabled={pending}>{pending ? "Creating…" : "Create task"}</button>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function CatActionTaskEditForm({ actionHandle, task, assignees }: { actionHandle: string; task: Task; assignees: Option[] }) {
  const router = useRouter();
  const initialDue = useMemo(() => localDateTime(task.dueAt), [task.dueAt]);
  const [title, setTitle] = useState(task.title);
  const [status, setStatus] = useState(task.status === "complete" ? "complete" : "open");
  const [dueAt, setDueAt] = useState(initialDue);
  const [assignee, setAssignee] = useState("__keep__");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, unknown> = {};
    if (title.trim() !== task.title) payload.title = title;
    if (status !== task.status) payload.status = status;
    if (dueAt !== initialDue) {
      const parsed = isoDateTime(dueAt);
      if (parsed === "invalid") {
        setFeedback({ tone: "error", message: "The task due date is invalid." });
        return;
      }
      payload.dueAt = parsed;
    }
    if (assignee !== "__keep__") payload.assigneeHandle = assignee === "__unassigned__" ? null : assignee;
    if (Object.keys(payload).length === 0) {
      setFeedback({ tone: "error", message: "Choose a CAT task change before saving." });
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      await sendJson(`/api/cat-actions/${actionHandle}/tasks/${task.handle}`, "PATCH", payload);
      setAssignee("__keep__");
      setFeedback({ tone: "success", message: "CAT task updated." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT task update failed." });
    } finally {
      setPending(false);
    }
  }

  return <details>
    <summary>Edit task</summary>
    <form className="grid" onSubmit={submit} style={{ marginTop: 10 }}>
      <div className="field">
        <label htmlFor={`cat-task-title-${task.handle}`}>Task</label>
        <input id={`cat-task-title-${task.handle}`} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={240} />
      </div>
      <div className="field">
        <label htmlFor={`cat-task-status-${task.handle}`}>Status</label>
        <select id={`cat-task-status-${task.handle}`} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="open">Open</option>
          <option value="complete">Complete</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={`cat-task-assignee-${task.handle}`}>Assignee</label>
        <select id={`cat-task-assignee-${task.handle}`} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="__keep__">Keep current assignee{task.assigneeName ? ` · ${task.assigneeName}` : ""}</option>
          <option value="__unassigned__">Unassigned</option>
          {assignees.map((option) => <option key={option.handle} value={option.handle}>{option.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`cat-task-due-${task.handle}`}>Due date and time</label>
        <input id={`cat-task-due-${task.handle}`} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
      </div>
      <button className="button secondary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save task"}</button>
      <FeedbackMessage feedback={feedback} />
    </form>
  </details>;
}
