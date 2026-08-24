"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ImportReviewDecisionType } from "@/lib/import-review";

export function ImportReviewDecisionButton({ batchId, decisionType, expectedHash, accepted, label, disabled = false }: {
  batchId: string; decisionType: ImportReviewDecisionType; expectedHash: string; accepted: boolean; label: string; disabled?: boolean;
}) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function mutate() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/imports/${encodeURIComponent(batchId)}/review-decisions/${decisionType}`, {
        method: accepted ? "DELETE" : "PUT",
        headers: accepted ? undefined : { "Content-Type": "application/json" },
        body: accepted ? undefined : JSON.stringify({ expectedHash }),
      });
      if (!response.ok) { setMessage("The current review set could not be updated. No roster changes were made."); return; }
      router.refresh();
    } catch { setMessage("The current review set could not be updated. No roster changes were made."); }
    finally { setBusy(false); }
  }
  return <div className="inline-actions vertical-actions"><button className={`button ${accepted ? "secondary" : ""}`.trim()} disabled={busy || disabled} onClick={mutate} type="button">{busy ? "Saving…" : accepted ? "Clear decision" : label}</button>{message ? <div className="form-message compact-message" role="alert">{message}</div> : null}</div>;
}
