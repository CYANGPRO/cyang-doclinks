"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EmployeeActionDefinition, EmployeeActionResponse, EmployeeActionResponseOption } from "@/lib/employee-actions";

const levels = [
  [1, "Level 1 · Quick follow-up or information"],
  [2, "Level 2 · Conversation or meeting"],
  [3, "Level 3 · Public commitment"],
  [4, "Level 4 · Leadership or external advocacy"],
  [5, "Level 5 · Collective workforce action"],
] as const;

const responseMeaning: Record<string, string> = {
  willing: "Willing response",
  considering: "Considering response",
  declined: "Declined response",
  completed: "Completed response",
};

function responseMeaningFor(option: EmployeeActionResponseOption) {
  return option.value.startsWith("custom:") ? "Additional custom response" : responseMeaning[option.value];
}

export function ActionResponseEditor({ action }: { action: EmployeeActionDefinition }) {
  const router = useRouter();
  const [responses, setResponses] = useState(() => action.responseOptions.map((option) => ({ ...option })));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabledCount = responses.filter((option) => option.enabled).length;
  const customCount = responses.filter((option) => option.value.startsWith("custom:")).length;
  const labelsValid = responses.every((option) => option.label.trim().length > 0);

  function change(value: EmployeeActionResponse, update: Partial<EmployeeActionResponseOption>) {
    setResponses((current) => current.map((option) => option.value === value ? { ...option, ...update } : option));
    setMessage(null);
    setError(null);
  }

  function addCustomResponse() {
    if (customCount >= 8) return;
    const value = `custom:${crypto.randomUUID().replaceAll("-", "")}` as EmployeeActionResponse;
    setResponses((current) => [...current, { value, label: "", enabled: true }]);
    setMessage(null);
    setError(null);
  }

  function removeUnsavedResponse(value: EmployeeActionResponse) {
    if (action.responseOptions.some((option) => option.value === value)) return;
    setResponses((current) => current.filter((option) => option.value !== value));
  }

  async function save() {
    if (busy || enabledCount === 0 || !labelsValid) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/action-readiness/catalog", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionHandle: action.handle, responses }),
      });
      const body = await response.json().catch(() => ({})) as { message?: unknown };
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "CAT couldn’t update these response choices.");
        return;
      }
      setMessage("Response choices updated.");
      router.refresh();
    } catch {
      setError("CAT couldn’t update these response choices. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <details className="action-response-editor">
    <summary>Customize responses</summary>
    <div className="action-response-editor-content">
      <p className="field-help">Rename or hide a standard choice, or use the plus button to add an action-specific response. Saved custom choices remain distinct in history and reports.</p>
      <div className="action-response-options">
        {responses.map((option) => {
          const checkboxId = `${action.handle}-${option.value}-enabled`;
          const labelId = `${action.handle}-${option.value}-label`;
          return <div className={`action-response-option${option.enabled ? " enabled" : ""}`} key={option.value}>
            <label className="choice-field" htmlFor={checkboxId}>
              <input id={checkboxId} type="checkbox" checked={option.enabled} onChange={(event) => change(option.value, { enabled: event.target.checked })} />
              <span><strong>{option.enabled ? "Available" : "Hidden"}</strong><span className="choice-help">{responseMeaningFor(option)}</span></span>
            </label>
            <div className="field"><label htmlFor={labelId}>Label shown to CAT users</label><input id={labelId} value={option.label} maxLength={40} onChange={(event) => change(option.value, { label: event.target.value })} /></div>
            {option.value.startsWith("custom:") && !action.responseOptions.some((saved) => saved.value === option.value)
              ? <button className="button tertiary" type="button" onClick={() => removeUnsavedResponse(option.value)}>Cancel</button>
              : null}
          </div>;
        })}
      </div>
      {enabledCount === 0 ? <div className="form-message" role="alert">Keep at least one response available.</div> : null}
      {!labelsValid ? <div className="form-message" role="alert">Give every response choice a label before saving.</div> : null}
      <div className="form-actions">
        <button className="button tertiary" type="button" onClick={addCustomResponse} disabled={busy || customCount >= 8}>+ Add response choice</button>
        <button className="button secondary" type="button" onClick={save} disabled={busy || enabledCount === 0 || !labelsValid}>{busy ? "Saving…" : "Save response choices"}</button>
      </div>
      {customCount >= 8 ? <p className="field-help">This action has reached the limit of eight additional response choices.</p> : null}
      {message ? <div className="form-message success" role="status">{message}</div> : null}
      {error ? <div className="form-message" role="alert">{error}</div> : null}
    </div>
  </details>;
}

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
        setError(typeof body.message === "string" ? body.message : "CAT couldn’t add the custom action.");
        return;
      }
      form.reset();
      setMessage("Custom action added to the catalog.");
      router.refresh();
    } catch {
      setError("CAT couldn’t add the custom action. Try again.");
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
    <p className="field-help">Custom actions are organization-wide and are added in addition to the existing catalog. Each one starts with Willing, Considering, Declined, and Completed; those labels can be customized afterward. Use a clear verb, avoid duplicates, and select the lowest accurate commitment level.</p>
    <div className="form-actions"><button className="button" type="submit" disabled={busy}>{busy ? "Adding…" : "Add custom action"}</button></div>
    {message ? <div className="form-message success" role="status">{message}</div> : null}
    {error ? <div className="form-message" role="alert">{error}</div> : null}
  </form>;
}
