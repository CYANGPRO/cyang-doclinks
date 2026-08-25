"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  batchId: string;
  fingerprint: string;
  fingerprintShort: string;
  mode?: "synthetic_preview" | "protected";
};

type Feedback = { tone: "error" | "success"; message: string } | null;

type ExecutionResponse = {
  message?: unknown;
  recovery?: unknown;
  supportReference?: unknown;
};

const SUPPORT_REFERENCE_RE = /^IMPORT_EXECUTION_[0-9A-F]{12}$/;

function failureMessage(payload: ExecutionResponse) {
  const message = typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim()
    : "CAT did not apply the import. No roster changes were saved.";
  const recovery = Array.isArray(payload.recovery)
    ? payload.recovery.filter((step): step is string => typeof step === "string" && step.trim().length > 0).slice(0, 2)
    : [];
  const supportReference = typeof payload.supportReference === "string" && SUPPORT_REFERENCE_RE.test(payload.supportReference)
    ? payload.supportReference
    : null;
  return [message, ...recovery, supportReference ? `Support reference: ${supportReference}` : ""].filter(Boolean).join(" ");
}

export function ImportExecutionControl({ batchId, fingerprint, fingerprintShort, mode = "synthetic_preview" }: Props) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const protectedMode = mode === "protected";
  const noun = protectedMode ? "approved roster import" : "Preview import";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation.trim().toUpperCase() !== fingerprintShort) {
      setFeedback({ tone: "error", message: `Type ${fingerprintShort} exactly to confirm this execution set.` });
      return;
    }
    if (!window.confirm(`Apply this ${noun} now? CAT will save the roster changes, approval record, and audit event together—or save none of them.`)) return;

    setPending(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/imports/${batchId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
      const payload = await response.json().catch(() => ({})) as ExecutionResponse;
      if (!response.ok) throw new Error(failureMessage(payload));
      setFeedback({ tone: "success", message: protectedMode ? "The approved roster changes were applied." : "The Preview import was applied." });
      setConfirmation("");
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT could not apply the import. No roster changes were saved." });
    } finally {
      setPending(false);
    }
  }

  return <form className="stack execution-confirmation" onSubmit={submit}>
    <div className="form-grid">
      <div className="field">
        <label htmlFor="execution-confirmation">Type confirmation code {fingerprintShort}</label>
        <input
          id="execution-confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
          required
          aria-describedby="execution-confirmation-help"
        />
        <span className="field-help" id="execution-confirmation-help">This confirms that you reviewed the exact preflight execution set shown above.</span>
      </div>
    </div>
    <div className="form-actions">
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Executing…" : protectedMode ? "Execute protected import" : "Execute Preview import"}
      </button>
    </div>
    {feedback ? <div className={`form-message${feedback.tone === "success" ? " success" : ""}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div> : null}
  </form>;
}
