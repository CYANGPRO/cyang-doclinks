"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertBanner, SectionCard } from "@/components/DesignSystem";

export type DocumentUploadVisibilityOption = Readonly<{ value: string; label: string; description: string }>;

export function DocumentUploadForm({ visibilityOptions }: { visibilityOptions: readonly DocumentUploadVisibilityOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedVisibility, setSelectedVisibility] = useState(visibilityOptions[0]?.value ?? "");
  const selectedOption = visibilityOptions.find((option) => option.value === selectedVisibility) ?? visibilityOptions[0];

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
      setMessage("Document uploaded successfully. It was scanned, encrypted, and is ready for approval by an authorized viewer.");
      formElement.reset();
      setSelectedVisibility(visibilityOptions[0]?.value ?? "");
      router.refresh();
    } catch {
      setMessage("The document could not be uploaded securely. Nothing was shared. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      title="Upload a document"
      description="Choose a file and its visibility. New files remain under review until an approved user confirms them."
    >
      <AlertBanner title="Files are scanned before they’re stored">
        A file must pass the malware scan before Engaging Local 801 encrypts it and saves it in private storage.
      </AlertBanner>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="document-title">Title</label>
            <input id="document-title" name="title" type="text" maxLength={255} required />
          </div>
          <div className="field">
            <label htmlFor="document-category">Category</label>
            <input id="document-category" name="category" type="text" maxLength={100} placeholder="Member communications" required />
          </div>
          <div className="field">
            <label htmlFor="document-visibility">Who can view it</label>
            <select
              id="document-visibility"
              name="visibility"
              required
              defaultValue={visibilityOptions[0]?.value ?? ""}
              onChange={(event) => setSelectedVisibility(event.currentTarget.value)}
              aria-describedby="document-visibility-description"
            >
              {visibilityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <div className="field-help" id="document-visibility-description">
              {selectedOption?.description ?? "No sharing option is available."}
            </div>
          </div>
          <div className="field">
            <label htmlFor="document-file">File</label>
            <input id="document-file" name="file" type="file" accept=".pdf,.docx,.xlsx,.csv,.txt" required />
            <div className="field-help">PDF, Word, Excel, CSV, or text. The normal upload-size limit still applies.</div>
          </div>
        </div>
        <div className="form-actions">
          <button className="button" disabled={busy || visibilityOptions.length === 0} type="submit">
            {busy ? "Scanning and uploading…" : "Upload document"}
          </button>
        </div>
      </form>
      {message ? (
        <p className={`form-message${success ? " success" : ""}`} role={success ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
    </SectionCard>
  );
}
