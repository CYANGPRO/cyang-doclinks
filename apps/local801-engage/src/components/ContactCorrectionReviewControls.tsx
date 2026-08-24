"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ContactCorrectionReviewControls({ correctionHandle, revision }: { correctionHandle: string; revision: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState("");

  async function decide(decision: "approved" | "rejected") {
    if (decision === "approved" && !window.confirm("Approve this contact update and change the official member record?")) return;
    setSaving(decision);
    setError("");
    try {
      const response = await fetch(`/api/contact-corrections/${correctionHandle}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, revision }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message || "This contact update could not be reviewed.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This contact update could not be reviewed.");
    } finally {
      setSaving(null);
    }
  }

  return <div className="stack compact-stack contact-update-actions">
    <div className="page-actions">
      <button className="button" type="button" disabled={saving !== null} onClick={() => decide("approved")}>{saving === "approved" ? "Approving…" : "Approve"}</button>
      <button className="button secondary" type="button" disabled={saving !== null} onClick={() => decide("rejected")}>{saving === "rejected" ? "Rejecting…" : "Reject"}</button>
    </div>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </div>;
}
