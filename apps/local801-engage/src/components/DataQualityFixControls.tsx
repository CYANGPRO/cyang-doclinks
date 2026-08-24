"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DataQualityIssueCode } from "@/lib/data-quality";

type Props = {
  displayName: string;
  personHandle: string;
  issues: DataQualityIssueCode[];
};

const directIssues = new Set<DataQualityIssueCode>([
  "missing_identifier",
  "missing_work_email",
  "missing_department",
  "missing_classification",
  "missing_work_location",
  "unknown_membership",
]);

export function DataQualityFixControls({ displayName, personHandle, issues }: Props) {
  const router = useRouter();
  const panelId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canFixDirectly = issues.some((issue) => directIssues.has(issue));

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const firstField = panelRef.current?.querySelector<HTMLElement>("input, select");
      firstField?.focus();
      panelRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const body: Record<string, string> = {};
    for (const key of ["identifierType", "identifierValue", "workEmail", "department", "classification", "workLocation", "membershipStatus"] as const) {
      const value = form.get(key);
      if (typeof value === "string" && value.trim()) body[key] = value.trim();
    }
    if (!Object.keys(body).length) {
      setError("Enter at least one missing value before saving.");
      setSaving(false);
      return;
    }
    if (Boolean(body.identifierType) !== Boolean(body.identifierValue)) {
      setError("Choose an identifier type and enter its value together.");
      setSaving(false);
      return;
    }
    try {
      const response = await fetch(`/api/data-quality/${personHandle}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "These fixes could not be saved.");
      setOpen(false);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "These fixes could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  if (!canFixDirectly) return null;

  return <div className="data-quality-fix-controls">
    <button aria-controls={panelId} aria-expanded={open} aria-label={open ? `Close fixes for ${displayName}` : `Fix ${displayName} now`} className="button secondary data-quality-fix-toggle" type="button" onClick={() => { setOpen((value) => !value); setError(""); }}>
      {open ? "Close" : "Fix now"}
    </button>
    {open ? <form className="data-quality-fix-panel" id={panelId} onSubmit={save} ref={panelRef}>
      <div className="data-quality-fix-grid">
        {issues.includes("missing_identifier") ? <div className="data-quality-fix-pair">
          <div className="field"><label htmlFor={`identifier-type-${personHandle}`}>Identifier type</label><select id={`identifier-type-${personHandle}`} name="identifierType" defaultValue=""><option value="">Choose type</option><option value="employee_identifier">Employee ID</option><option value="member_identifier">Member ID</option></select></div>
          <div className="field"><label htmlFor={`identifier-value-${personHandle}`}>Identifier</label><input id={`identifier-value-${personHandle}`} name="identifierValue" autoComplete="off" /></div>
        </div> : null}
        {issues.includes("missing_work_email") ? <div className="field"><label htmlFor={`work-email-${personHandle}`}>Work email</label><input id={`work-email-${personHandle}`} name="workEmail" type="email" autoComplete="off" /></div> : null}
        {issues.includes("missing_department") ? <div className="field"><label htmlFor={`department-${personHandle}`}>Department</label><input id={`department-${personHandle}`} name="department" autoComplete="off" /></div> : null}
        {issues.includes("missing_classification") ? <div className="field"><label htmlFor={`classification-${personHandle}`}>Classification</label><input id={`classification-${personHandle}`} name="classification" autoComplete="off" /></div> : null}
        {issues.includes("missing_work_location") ? <div className="field"><label htmlFor={`work-location-${personHandle}`}>Work location</label><input id={`work-location-${personHandle}`} name="workLocation" autoComplete="off" /></div> : null}
        {issues.includes("unknown_membership") ? <div className="field"><label htmlFor={`membership-${personHandle}`}>Membership status</label><select id={`membership-${personHandle}`} name="membershipStatus" defaultValue=""><option value="">Choose status</option><option value="member">Member</option><option value="nonmember">Nonmember</option></select></div> : null}
      </div>
      <div className="data-quality-fix-footer">
        <p className="muted">Only missing or unresolved fields can be filled here. Existing values are not overwritten.</p>
        <button className="button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save fixes"}</button>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form> : null}
  </div>;
}
