"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertBanner, SectionCard, StatusBadge } from "@/components/DesignSystem";

export type DocumentUploadVisibilityOption = Readonly<{ value: string; label: string }>;

export function DocumentUploadForm({ visibilityOptions }: { visibilityOptions: readonly DocumentUploadVisibilityOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setSuccess(false);
    const formElement = event.currentTarget;

    try {
      const response = await fetch("/api/documents/upload", {
        method: "POST",
        body: new FormData(formElement),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(typeof body.message === "string" ? body.message : "The document could not be uploaded securely.");
        return;
      }
      setSuccess(true);
      setMessage("Document uploaded, malware-scanned, encrypted, and shared with the selected role scope.");
      formElement.reset();
      router.refresh();
    } catch {
      setMessage("The document could not be uploaded securely. Nothing was shared. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Upload document"
      description="Upload a document and choose the authorized role scope that may see and download it."
      badge={<StatusBadge tone="ready">Malware scan required</StatusBadge>}
    >
      <AlertBanner title="Scan before storage">
        Plaintext bytes are sent to the shared malware scanner over HTTPS. Only a clean verdict proceeds to AES-256-GCM encryption and private R2 storage.
      </AlertBanner>
      <form className="grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="document-title">Title</label>
          <input id="document-title" name="title" type="text" maxLength={255} required />
        </div>
        <div className="field">
          <label htmlFor="document-category">Category</label>
          <input id="document-category" name="category" type="text" maxLength={100} placeholder="Member communications" required />
        </div>
        <div className="field">
          <label htmlFor="document-visibility">Share with</label>
          <select id="document-visibility" name="visibility" required defaultValue={visibilityOptions[0]?.value ?? ""}>
            {visibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="document-file">File</label>
          <input id="document-file" name="file" type="file" accept=".pdf,.docx,.xlsx,.csv,.txt" required />
          <div className="muted">PDF, Word, Excel, CSV, or text. Existing server upload-size limits apply.</div>
        </div>
        <button className="button" disabled={busy || visibilityOptions.length === 0} type="submit">
          {busy ? "Scanning and encrypting..." : "Upload document"}
        </button>
      </form>
      {message ? (
        <p
          className="form-message"
          style={success ? { color: "var(--success)" } : undefined}
          role={success ? "status" : "alert"}
        >
          {message}
        </p>
      ) : null}
    </SectionCard>
  );
}
