"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const levels = [
  [1, "Level 1 · Quick follow-up or information"],
  [2, "Level 2 · Conversation or meeting"],
  [3, "Level 3 · Public commitment"],
  [4, "Level 4 · Leadership or external advocacy"],
  [5, "Level 5 · Collective workforce action"],
] as const;

export function ActionCatalogManager() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/action-readiness/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: data.get("label"), engagementLevel: Number(data.get("engagementLevel")) }),
      });
      const body = await response.json().catch(() => ({})) as { message?: unknown };
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The custom action could not be created.");
        return;
      }
      form.reset();
      setMessage("Custom action added to the catalog.");
      router.refresh();
    } catch {
      setError("The custom action could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <div className="field">
        <label htmlFor="custom-action-label">Action name</label>
        <input id="custom-action-label" name="label" required maxLength={120} placeholder="Describe one observable action" />
      </div>
      <div className="field">
        <label htmlFor="custom-action-level">Escalation level</label>
        <select id="custom-action-level" name="engagementLevel" defaultValue="1" required>
          {levels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
    </div>
    <p className="field-help">Custom actions are organization-wide. Use a clear verb, avoid duplicate actions, and select the lowest level that accurately reflects the commitment.</p>
    <div className="form-actions"><button className="button" type="submit" disabled={busy}>{busy ? "Adding…" : "Add custom action"}</button></div>
    {message ? <div className="form-message success" role="status">{message}</div> : null}
    {error ? <div className="form-message" role="alert">{error}</div> : null}
  </form>;
}
