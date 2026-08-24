"use client";

import { useState, type FormEvent } from "react";
import { roleLabels, type Role } from "@/lib/access";

const previewRoles: Role[] = [
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
];

const roleSummaries: Record<Role, string> = {
  system_owner: "Full Preview access, including administration.",
  local_admin: "Run the local workspace, people data, programs, and administration.",
  membership_data_manager: "Manage membership, imports, data quality, and reports.",
  cat_admin: "Coordinate organizing work, programs, documents, and reports.",
  cat_lead: "Manage team assignments, follow-ups, documents, and reports.",
  cat_member: "Work assigned people, follow-ups, and shared documents.",
  report_viewer: "Open the authorized reporting workspace.",
};

export function PreviewRoleForm({
  currentRole,
  csrfToken,
  nextPath,
  switching,
}: {
  currentRole: Role;
  csrfToken: string;
  nextPath: string;
  switching: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const formData = new FormData(event.currentTarget);
      const body = new URLSearchParams();
      for (const [name, value] of formData.entries()) if (typeof value === "string") body.append(name, value);
      const response = await fetch("/api/auth/preview", {
        method: "POST",
        body,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "follow",
      });
      if (!response.ok) throw new Error("Preview role selection failed.");
      window.location.assign(response.url || nextPath);
    } catch {
      setError("We couldn’t start that Preview session. Try again.");
      setPending(false);
    }
  }

  return <form className="stack sign-in-form" onSubmit={submit}>
    <input type="hidden" name="csrfToken" value={csrfToken} />
    <input type="hidden" name="next" value={nextPath} />
    <div className="stack" role="radiogroup" aria-label="Preview role">
      <div className="grid two-grid">
        {previewRoles.map((role) => <label className="choice-field" key={role}>
          <input defaultChecked={currentRole === role} disabled={pending} name="role" type="radio" value={role} />
          <span className="stack compact-stack">
            <strong>{roleLabels[role]}</strong>
            <span className="field-help">{roleSummaries[role]}</span>
          </span>
        </label>)}
      </div>
    </div>
    {error ? <p className="form-message" role="alert">{error}</p> : null}
    <div className="form-actions">
      <button className="button" disabled={pending} type="submit">{pending ? "Starting Preview…" : switching ? "Switch role and continue" : "Continue to Preview"}</button>
      {switching ? <a className="button secondary" href={nextPath}>Return to current workspace</a> : null}
    </div>
  </form>;
}
