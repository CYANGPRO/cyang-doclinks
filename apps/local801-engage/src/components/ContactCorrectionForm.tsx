"use client";

import { useState } from "react";

const fields = [
  ["phone", "Phone number"],
  ["work_email", "Work email"],
  ["personal_email", "Personal email"],
  ["mailing_address", "Mailing address"],
] as const;

export function ContactCorrectionForm({ employeeHandle }: { employeeHandle: string }) {
  const [field, setField] = useState<(typeof fields)[number][0]>("phone");
  const [proposedValue, setProposedValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch(`/api/outreach/${employeeHandle}/contact-corrections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, proposedValue }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message || "We couldn’t send this update for review.");
      setProposedValue("");
      setStatus("saved");
      setMessage("Sent to Membership Data for review. The official contact record has not changed yet.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "We couldn’t send this update for review.");
    }
  }

  return <form onSubmit={submit} className="stack">
    <div className="field">
      <label htmlFor="correction-field">What needs updating?</label>
      <select id="correction-field" value={field} onChange={(event) => setField(event.target.value as typeof field)} disabled={status === "saving"}>
        {fields.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </div>
    <div className="field">
      <label htmlFor="correction-value">Correct information</label>
      <input id="correction-value" value={proposedValue} onChange={(event) => setProposedValue(event.target.value)} maxLength={500} required disabled={status === "saving"} autoComplete="off" />
    </div>
    <div className="page-actions"><button className="button" type="submit" disabled={status === "saving"}>{status === "saving" ? "Sending…" : "Send for review"}</button></div>
    {message ? <p className={status === "error" ? "error-text" : "muted"} role={status === "error" ? "alert" : "status"}>{message}</p> : null}
  </form>;
}
