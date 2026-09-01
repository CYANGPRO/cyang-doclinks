"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Feedback = { tone: "error" | "success"; message: string } | null;

type Props = {
  batchId: string;
  importKind: string | null;
  snapshotDate: string | null;
  effectiveDate: string | null;
  duplicateSourceNeedsAck: boolean;
  largeShrinkNeedsAck: boolean;
  removalCount: number;
  migrationPending: boolean;
  fingerprint: string | null;
};

async function jsonRequest(url: string, method: "PUT" | "POST", body?: Record<string, unknown>) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The execution preflight change could not be saved.");
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <div className={`form-message${feedback.tone === "success" ? " success" : ""}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>;
}

export function ImportExecutionPreflightControls(props: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("plan");
    setFeedback(null);
    const data = new FormData(event.currentTarget);
    try {
      await jsonRequest(`/api/imports/${props.batchId}/approval-plan`, "PUT", {
        snapshotDate: props.importKind === "current_roster" ? String(data.get("snapshotDate") ?? "") || null : null,
        effectiveDate: props.importKind !== "current_roster" ? String(data.get("effectiveDate") ?? "") || null : null,
      });
      setFeedback({ tone: "success", message: "Execution date plan saved." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Plan save failed." });
    } finally {
      setPending(null);
    }
  }

  async function acknowledgeDuplicate() {
    setPending("duplicate");
    setFeedback(null);
    try {
      await jsonRequest(`/api/imports/${props.batchId}/duplicate-source-ack`, "POST");
      setFeedback({ tone: "success", message: "Duplicate source acknowledged." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Acknowledgement failed." });
    } finally {
      setPending(null);
    }
  }

  async function acknowledgeShrink() {
    if (!props.fingerprint) return;
    if (!window.confirm(`This import would reduce the approved roster by at least 20% and archive ${props.removalCount} active ${props.removalCount === 1 ? "person" : "people"} who no longer appear. Confirm that you reviewed this exact set of changes.`)) return;
    setPending("shrink");
    setFeedback(null);
    try {
      await jsonRequest(`/api/imports/${props.batchId}/large-shrink-ack`, "POST", { fingerprint: props.fingerprint });
      setFeedback({ tone: "success", message: "The large roster decrease was acknowledged for this set of changes." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Acknowledgement failed." });
    } finally {
      setPending(null);
    }
  }

  return <div className="stack">
    {props.importKind === "current_roster" ? (
      <form className="stack" onSubmit={savePlan}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="execution-snapshot-date">Roster snapshot date</label>
            <input id="execution-snapshot-date" name="snapshotDate" type="date" defaultValue={props.snapshotDate ?? ""} required />
            <span className="field-help">Use the date represented by the roster, not the upload date.</span>
          </div>
        </div>
        <div className="form-actions"><button className="button secondary" type="submit" disabled={pending !== null}>{pending === "plan" ? "Saving…" : "Save snapshot date"}</button></div>
      </form>
    ) : props.importKind && props.importKind !== "legacy_cat" ? (
      <form className="stack" onSubmit={savePlan}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="execution-effective-date">Batch effective date</label>
            <input id="execution-effective-date" name="effectiveDate" type="date" defaultValue={props.effectiveDate ?? ""} required />
            <span className="field-help">This date anchors the approved lifecycle event when the source does not provide a row-specific date.</span>
          </div>
        </div>
        <div className="form-actions"><button className="button secondary" type="submit" disabled={pending !== null}>{pending === "plan" ? "Saving…" : "Save effective date"}</button></div>
      </form>
    ) : null}

    {(props.duplicateSourceNeedsAck || props.largeShrinkNeedsAck) ? <div className="form-actions compact-actions">
      {props.duplicateSourceNeedsAck ? (
        <button className="button secondary" type="button" onClick={acknowledgeDuplicate} disabled={pending !== null}>
          {pending === "duplicate" ? "Acknowledging…" : "Acknowledge duplicate approved source"}
        </button>
      ) : null}

      {props.largeShrinkNeedsAck ? (
        <button className="button secondary" type="button" onClick={acknowledgeShrink} disabled={pending !== null || props.migrationPending || !props.fingerprint}>
          {pending === "shrink" ? "Acknowledging…" : `Acknowledge ${props.removalCount} roster removals`}
        </button>
      ) : null}
    </div> : null}

    <FeedbackMessage feedback={feedback} />
  </div>;
}
