"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

export function EmployeeDeleteControl({ displayName, personHandle }: { displayName: string; personHandle: string }) {
  const router = useRouter();
  const confirmationId = useId();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (confirmation !== "REMOVE") return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/directory/${personHandle}`, { method: "DELETE" });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "The employee could not be removed.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The employee could not be removed.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="employee-delete-control">
    <button className="button tertiary employee-delete-open" type="button" aria-expanded={open}
      onClick={() => { setOpen((value) => !value); setConfirmation(""); setError(""); }}>
      {open ? "Cancel" : "Delete employee"}
    </button>
    {open ? <div className="employee-delete-confirmation">
      <strong>Remove {displayName} from active CAT records?</strong>
      <p>This is a recoverable archive. CAT retains audit and historical activity.</p>
      <div className="field"><label htmlFor={confirmationId}>Type REMOVE to confirm</label><input id={confirmationId} value={confirmation} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} /></div>
      <button className="button danger" type="button" disabled={busy || confirmation !== "REMOVE"} onClick={remove}>{busy ? "Removing…" : "Confirm removal"}</button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </div> : null}
  </div>;
}
