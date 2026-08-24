"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DocumentDeleteButton({ handle, title }: { handle: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(`Delete "${title}"? This permanently removes the encrypted document and its metadata. This cannot be undone.`)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(handle)}/delete`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The document could not be deleted securely.");
        return;
      }
      router.refresh();
    } catch {
      setError("The document could not be deleted securely. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-actions vertical-actions document-delete-control">
      <button className="button danger compact-button" type="button" onClick={remove} disabled={busy}>
        {busy ? "Deleting..." : "Delete"}
      </button>
      {error ? <div className="form-message compact-message" role="alert">{error}</div> : null}
    </div>
  );
}
