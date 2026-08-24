"use client";

import { useEffect, useId, useRef } from "react";
import type { UserFacingProblem } from "@/lib/user-facing-errors";

export function UserFacingErrorDialog({ problem, onClose, onRetry }: {
  problem: UserFacingProblem | null;
  onClose: () => void;
  onRetry?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !problem) return;
    if (!dialog.open) dialog.showModal();
  }, [problem]);

  if (!problem) return null;

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="problem-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      ref={dialogRef}
    >
      <div className={`problem-dialog-accent problem-${problem.category}`} aria-hidden="true" />
      <div className="problem-dialog-body">
        <p className="problem-dialog-kicker">We can help you recover</p>
        <h2 id={titleId}>{problem.title}</h2>
        <p id={descriptionId}>{problem.description}</p>
        <h3>What to do</h3>
        <ol className="step-list">{problem.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="problem-dialog-reference"><strong>Support reference:</strong> <code>{problem.reference}</code></p>
        <p className="problem-dialog-safety">Never send anyone your password, MFA code, recovery code, or encryption key.</p>
        <div className="page-actions">
          {onRetry ? <button className="button" onClick={() => { dialogRef.current?.close(); onRetry(); }} type="button">Try again</button> : null}
          <button className={onRetry ? "button secondary" : "button"} onClick={() => { dialogRef.current?.close(); onClose(); }} type="button">Close</button>
        </div>
      </div>
    </dialog>
  );
}
