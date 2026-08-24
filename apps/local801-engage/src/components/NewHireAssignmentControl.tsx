"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./NewHireAssignmentControl.module.css";

type AssigneeOption = { handle: string; label: string; current?: boolean };

export function NewHireAssignmentControl({
  employeeHandle,
  employeeName,
  assignees,
}: {
  employeeHandle: string;
  employeeName: string;
  assignees: AssigneeOption[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (busy || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/new-hires/${encodeURIComponent(employeeHandle)}/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeHandle: selected }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.message === "string" ? body.message : "The assignment could not be saved.");
        return;
      }
      setSelected("");
      router.refresh();
    } catch {
      setError("The assignment could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (assignees.length === 0) {
    return <div className={styles.unavailable}>No CATs are available to assign.</div>;
  }

  return <div className={styles.control}>
    <div className={styles.actions}>
      <select
        className={styles.select}
        aria-label={`Assign ${employeeName} to a CAT member`}
        value={selected}
        disabled={busy}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Select CAT member</option>
        {assignees.map((assignee) => <option key={assignee.handle} value={assignee.handle}>
          {assignee.label}{assignee.current ? " (you)" : ""}
        </option>)}
      </select>
      <button className={`button secondary ${styles.button}`} type="button" disabled={busy || !selected} onClick={assign}>
        {busy ? "Assigning…" : "Assign"}
      </button>
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
  </div>;
}
