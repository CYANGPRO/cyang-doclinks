"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCatDateTime } from "@/lib/date-format";

type PopulationCriteria = {
  membershipStatus: string;
  department: string;
  classification: string;
  workLocation: string;
  search: string;
  includeHandles: string[];
  excludeHandles: string[];
};
type PopulationRequest = { operation: "add" | "remove"; criteria: PopulationCriteria };
type PopulationPreview = {
  operation: "add" | "remove";
  matched: number;
  alreadyPresent: number;
  wouldChange: number;
  excluded: number;
  unavailable: number;
  protectedActivity: number;
  confirmationToken: string;
  expiresAt: string;
};
type Feedback = { tone: "error" | "success"; message: string } | null;
type PopulationFilterOptions = {
  departments: string[];
  classifications: string[];
  workLocations: string[];
};

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: string };
  if (!response.ok) throw new Error(payload.message || "CAT could not finish the campaign update. Check the current campaign before trying again.");
  return payload;
}

function criteriaFromForm(data: FormData): PopulationCriteria {
  return {
    membershipStatus: String(data.get("membershipStatus") ?? ""),
    department: String(data.get("department") ?? ""),
    classification: String(data.get("classification") ?? ""),
    workLocation: String(data.get("workLocation") ?? ""),
    search: String(data.get("search") ?? ""),
    includeHandles: [],
    excludeHandles: [],
  };
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <div className={`form-message${feedback.tone === "success" ? " success" : ""}`}
    role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>;
}

function CriteriaFields({ prefix, options }: { prefix: string; options: PopulationFilterOptions }) {
  return <div className="form-grid campaign-bulk-criteria">
    <div className="field">
      <label htmlFor={`${prefix}-membership`}>Membership status</label>
      <select id={`${prefix}-membership`} name="membershipStatus" defaultValue="">
        <option value="">Any status</option>
        <option value="member">Member</option>
        <option value="nonmember">Nonmember</option>
        <option value="unknown">Unknown</option>
      </select>
    </div>
    <div className="field">
      <label htmlFor={`${prefix}-department`}>Department</label>
      <select id={`${prefix}-department`} name="department" defaultValue="">
        <option value="">Any department</option>
        {options.departments.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
    <div className="field">
      <label htmlFor={`${prefix}-classification`}>Classification</label>
      <select id={`${prefix}-classification`} name="classification" defaultValue="">
        <option value="">Any classification</option>
        {options.classifications.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
    <div className="field">
      <label htmlFor={`${prefix}-location`}>Office / work location</label>
      <select id={`${prefix}-location`} name="workLocation" defaultValue="">
        <option value="">Any office</option>
        {options.workLocations.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor={`${prefix}-search`}>Name or exact work email</label><input id={`${prefix}-search`} name="search" type="search" maxLength={100} placeholder="Optional employee search" /></div>
  </div>;
}

function PopulationBuilder({ campaignHandle, filterOptions }: { campaignHandle: string; filterOptions: PopulationFilterOptions }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [prepared, setPrepared] = useState<{ request: PopulationRequest; preview: PopulationPreview } | null>(null);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    setPrepared(null);
    const data = new FormData(event.currentTarget);
    const request: PopulationRequest = {
      operation: "add",
      criteria: criteriaFromForm(data),
    };
    try {
      const payload = await postJson(`/api/campaigns/${campaignHandle}/population/bulk/preview`, request);
      const result = payload.preview as PopulationPreview | undefined;
      if (!result || typeof result.confirmationToken !== "string") throw new Error("CAT couldn’t prepare a complete preview. Try again.");
      setPrepared({ request, preview: result });
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT couldn’t preview the population change." });
    } finally {
      setPending(false);
    }
  }

  async function confirm() {
    if (!prepared) return;
    setPending(true);
    setFeedback(null);
    try {
      await postJson(`/api/campaigns/${campaignHandle}/population/bulk`, {
        ...prepared.request,
        confirmationToken: prepared.preview.confirmationToken,
      });
      setPrepared(null);
      setFeedback({ tone: "success", message: `Added ${prepared.preview.wouldChange} ${prepared.preview.wouldChange === 1 ? "employee" : "employees"} to the campaign.` });
      router.refresh();
    } catch (error) {
      setPrepared(null);
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT couldn’t update the campaign population." });
    } finally {
      setPending(false);
    }
  }

  return <div className="campaign-operation">
    <div className="stack campaign-operation-content">
      <h3>Add employees by group</h3>
      <p className="muted">Choose one or more filters. Combined filters narrow the group—for example, members in one department and office. Previewing does not add anyone.</p>
      <form className="stack" onSubmit={preview}>
        <CriteriaFields prefix="population" options={filterOptions} />
        <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Calculating…" : "Preview employees to add"}</button></div>
      </form>
      {prepared ? <div className="confirmation-panel" aria-live="polite">
        <h3>Confirm these employees</h3>
        <dl className="compact-facts">
          <div><dt>Matched</dt><dd>{prepared.preview.matched}</dd></div>
          <div><dt>Would change</dt><dd>{prepared.preview.wouldChange}</dd></div>
          <div><dt>Already present</dt><dd>{prepared.preview.alreadyPresent}</dd></div>
          <div><dt>Protected activity</dt><dd>{prepared.preview.protectedActivity}</dd></div>
          <div><dt>Unavailable</dt><dd>{prepared.preview.unavailable}</dd></div>
        </dl>
        <p className="muted">Confirmation expires at {formatCatDateTime(prepared.preview.expiresAt)} and fails if the live set changes.</p>
        <div className="form-actions"><button className="button" type="button" onClick={confirm} disabled={pending}>{pending ? "Adding…" : `Add ${prepared.preview.wouldChange} to campaign`}</button><button className="button secondary" type="button" onClick={() => setPrepared(null)} disabled={pending}>Cancel</button></div>
      </div> : null}
      <FeedbackMessage feedback={feedback} />
    </div>
  </div>;
}

export function CampaignBulkOperations({
  campaignHandle,
  status,
  filterOptions,
}: {
  campaignHandle: string;
  status: "draft" | "active" | "closed";
  filterOptions: PopulationFilterOptions;
}) {
  if (status !== "draft") return null;
  return <div className="campaign-operations-grid">
    <PopulationBuilder campaignHandle={campaignHandle} filterOptions={filterOptions} />
  </div>;
}
