"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DocumentApprovalButton({ handle, title }: { handle: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(handle)}/approve`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(typeof body.message === "string" ? body.message : "The document could not be approved.");
        return;
      }
      router.refresh();
    } catch {
      setMessage("The document could not be approved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button
      className="button compact-button"
      disabled={busy}
      onClick={approve}
      type="button"
      aria-label={`Approve ${title}`}
    >
      {busy ? "Approving…" : "Approve"}
    </button>
    {message ? <span className="form-message" role="alert">{message}</span> : null}
  </>;
}
