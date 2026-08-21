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

export function ImportExecutionControl({ batchId, fingerprint, fingerprintShort, mode = "synthetic_preview" }: Props) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const protectedMode = mode === "protected";
  const noun = protectedMode ? "protected authoritative import" : "synthetic Preview import";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation.trim().toUpperCase() !== fingerprintShort) {
      setFeedback({ tone: "error", message: `Type ${fingerprintShort} exactly to confirm this execution set.` });
      return;
    }
    if (!window.confirm(`Execute this ${noun} now? All authoritative writes, the approval record, and audit event must commit together or the transaction will roll back.`)) return;

    setPending(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/imports/${batchId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message || "Authoritative import execution failed.");
      setFeedback({ tone: "success", message: protectedMode ? "Protected authoritative import executed atomically." : "Synthetic Preview import executed atomically." });
      setConfirmation("");
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Authoritative import execution failed." });
    } finally {
      setPending(false);
    }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field">
      <label htmlFor="execution-confirmation">Type execution fingerprint {fingerprintShort}</label>
      <input
        id="execution-confirmation"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        required
      />
    </div>
    <button className="button" type="submit" disabled={pending}>
      {pending ? "Executing…" : protectedMode ? "Execute protected import" : "Execute synthetic Preview import"}
    </button>
    {feedback ? <p
      className={feedback.tone === "error" ? "error-text" : undefined}
      style={feedback.tone === "success" ? { color: "var(--success)", fontWeight: 700 } : undefined}
      role={feedback.tone === "error" ? "alert" : "status"}
    >{feedback.message}</p> : null}
  </form>;
}
