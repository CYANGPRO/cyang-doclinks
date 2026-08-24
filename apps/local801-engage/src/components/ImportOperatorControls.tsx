"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function operate(batchId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/imports/${batchId}/operator`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The operator action could not be completed.");
}

export function ImportOperatorControls({ batchId, state, cancellationRequestedAt }: { batchId: string; state: string; cancellationRequestedAt: string | null }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [message, setMessage] = useState(""); const [reason, setReason] = useState("operator_cancelled");
  const active = state === "queued" || state === "running";
  const retryable = state === "failed" || state === "cancelled";
  async function cancel() {
    if (!window.confirm("Cancel this import? No authoritative roster changes have been made by background processing.")) return;
    setPending(true); setMessage("");
    try { await operate(batchId, { action: "cancel", reason }); setMessage(state === "running" ? "Cancellation requested. The worker will stop at the next safe boundary." : "Queued import cancelled."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Cancellation failed."); }
    finally { setPending(false); }
  }
  async function requeue() {
    setPending(true); setMessage("");
    try { await operate(batchId, { action: "requeue" }); setMessage("Import requeued in a new durable workflow run."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Requeue failed."); }
    finally { setPending(false); }
  }
  return <div className="grid">
    {active && !cancellationRequestedAt ? <div className="form-grid"><div className="field"><label htmlFor="import-cancel-reason">Reason</label><select id="import-cancel-reason" value={reason} onChange={(event) => setReason(event.target.value)}><option value="operator_cancelled">Operator cancelled</option><option value="superseded_source">Superseded source</option><option value="incorrect_source">Incorrect source</option><option value="maintenance">Maintenance</option></select></div><div className="form-actions"><button className="button danger" disabled={pending} onClick={() => void cancel()} type="button">{pending ? "Working…" : "Cancel processing"}</button></div></div> : null}
    {cancellationRequestedAt && state === "running" ? <p className="muted">Cancellation requested. A running step may finish, but the next stage will not begin.</p> : null}
    {retryable ? <div className="form-actions"><button className="button" disabled={pending} onClick={() => void requeue()} type="button">{pending ? "Starting…" : "Requeue processing"}</button></div> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </div>;
}
