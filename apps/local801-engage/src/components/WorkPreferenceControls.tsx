"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

function messageFrom(value: unknown, fallback: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function SaveCurrentView({
  destination,
  queryParams,
}: {
  destination: string;
  queryParams: Record<string, string>;
}) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      const response = await fetch("/api/work-preferences/views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, destination, queryParams }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(messageFrom(body, "We couldn’t save this view."));
      setLabel("");
      setMessage("View saved.");
      router.refresh();
    } catch (failure) {
      setError(true);
      setMessage(failure instanceof Error ? failure.message : "We couldn’t save this view.");
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={submit} className="form-grid" aria-label="Save this work view">
    <div className="field">
      <label htmlFor={`saved-view-label-${destination.replace(/[^a-z]/gi, "-")}`}>Name this view</label>
      <input
        id={`saved-view-label-${destination.replace(/[^a-z]/gi, "-")}`}
        value={label}
        maxLength={80}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Example: My overdue follow-ups"
        required
      />
      <span className="field-help">Saved views remember the filters, but never save search text, member names, or person identifiers.</span>
    </div>
    <div className="form-actions">
      <button className="button" type="submit" disabled={busy || !label.trim()}>{busy ? "Saving…" : "Save this view"}</button>
    </div>
    {message ? <p className={`form-message ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{message}</p> : null}
  </form>;
}

export function DismissNotificationButton({ notificationKey }: { notificationKey: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function dismiss() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/work-preferences/notifications/${encodeURIComponent(notificationKey)}`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(messageFrom(body, "We couldn’t dismiss this notification."));
      router.refresh();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "We couldn’t dismiss this notification.");
      setBusy(false);
    }
  }

  return <div>
    <button className="button secondary" type="button" onClick={dismiss} disabled={busy}>{busy ? "Dismissing…" : "Dismiss"}</button>
    {message ? <p className="form-message error" role="alert">{message}</p> : null}
  </div>;
}

export function DeleteSavedViewButton({ handle }: { handle: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function remove() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/work-preferences/views/${encodeURIComponent(handle)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(messageFrom(body, "We couldn’t delete this saved view."));
      router.refresh();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "We couldn’t delete this saved view.");
      setBusy(false);
    }
  }

  return <div>
    <button className="button secondary" type="button" onClick={remove} disabled={busy}>{busy ? "Deleting…" : "Delete"}</button>
    {message ? <p className="form-message error" role="alert">{message}</p> : null}
  </div>;
}
