"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function FollowupCompleteButton({ employeeHandle, followupHandle }: { employeeHandle: string; followupHandle: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/outreach/${encodeURIComponent(employeeHandle)}/followups/${encodeURIComponent(followupHandle)}`, { method: "PUT" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The follow-up could not be completed.");
        return;
      }
      router.refresh();
    } catch {
      setError("The follow-up could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div style={{ display: "grid", gap: 4 }}>
    <button className="button secondary" type="button" disabled={busy} onClick={complete}>{busy ? "Completing…" : "Mark complete"}</button>
    {error ? <div className="form-message" role="alert">{error}</div> : null}
  </div>;
}
