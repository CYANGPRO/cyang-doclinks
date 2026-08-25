"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCatDateTime } from "@/lib/date-format";

type Option = { handle: string; label: string; detail: string | null };
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
type AssignmentCriteria = {
  membershipStatus: string;
  department: string;
  classification: string;
  workLocation: string;
  workflowState: string;
};
type AssignmentRequest = { assigneeHandle: string; criteria: AssignmentCriteria };
type AssignmentPreview = {
  matched: number;
  wouldAssign: number;
  alreadyAssigned: number;
  confirmationToken: string;
  expiresAt: string;
};
type Feedback = { tone: "error" | "success"; message: string } | null;

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

function handles(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function criteriaFromForm(data: FormData): PopulationCriteria {
  return {
    membershipStatus: String(data.get("membershipStatus") ?? ""),
    department: String(data.get("department") ?? ""),
    classification: String(data.get("classification") ?? ""),
    workLocation: String(data.get("workLocation") ?? ""),
    search: String(data.get("search") ?? ""),
    includeHandles: handles(data.get("includeHandles")),
    excludeHandles: handles(data.get("excludeHandles")),
  };
}

function assignmentCriteriaFromForm(data: FormData): AssignmentCriteria {
  return {
    membershipStatus: String(data.get("membershipStatus") ?? ""),
    department: String(data.get("department") ?? ""),
    classification: String(data.get("classification") ?? ""),
    workLocation: String(data.get("workLocation") ?? ""),
    workflowState: String(data.get("workflowState") ?? "all"),
  };
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <div className={`form-message${feedback.tone === "success" ? " success" : ""}`}
    role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>;
}

function CriteriaFields({ prefix, includeSearch = false }: { prefix: string; includeSearch?: boolean }) {
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
    <div className="field"><label htmlFor={`${prefix}-department`}>Department</label><input id={`${prefix}-department`} name="department" maxLength={80} /></div>
    <div className="field"><label htmlFor={`${prefix}-classification`}>Classification</label><input id={`${prefix}-classification`} name="classification" maxLength={80} /></div>
    <div className="field"><label htmlFor={`${prefix}-location`}>Work location</label><input id={`${prefix}-location`} name="workLocation" maxLength={80} /></div>
    {includeSearch ? <div className="field"><label htmlFor={`${prefix}-search`}>Directory search</label><input id={`${prefix}-search`} name="search" maxLength={100} placeholder="Name, email, department, classification, or location" /></div> : null}
  </div>;
}

function PopulationBuilder({ campaignHandle }: { campaignHandle: string }) {
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
      operation: data.get("operation") === "remove" ? "remove" : "add",
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
      setFeedback({ tone: "success", message: `Campaign population updated for ${prepared.preview.wouldChange} people.` });
      router.refresh();
    } catch (error) {
      setPrepared(null);
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT couldn’t update the campaign population." });
    } finally {
      setPending(false);
    }
  }

  return <details className="campaign-operation" open>
    <summary>Build or adjust the draft population</summary>
    <div className="stack campaign-operation-content">
      <p className="muted">Choose who should be included. The preview shows counts only, so names and roster details stay protected.</p>
      <form className="stack" onSubmit={preview}>
        <div className="field"><label htmlFor="population-operation">Change</label><select id="population-operation" name="operation" defaultValue="add"><option value="add">Add matching people</option><option value="remove">Remove eligible matching people</option></select></div>
        <CriteriaFields prefix="population" includeSearch />
        <details className="inline-disclosure">
          <summary>Include or exclude specific people</summary>
          <div className="form-grid inline-disclosure-content">
            <div className="field"><label htmlFor="population-includes">Always include</label><textarea id="population-includes" name="includeHandles" maxLength={3300} rows={3} placeholder="Paste up to 50 CAT person IDs, separated by spaces or commas" /></div>
            <div className="field"><label htmlFor="population-excludes">Always exclude</label><textarea id="population-excludes" name="excludeHandles" maxLength={3300} rows={3} placeholder="Paste up to 50 CAT person IDs, separated by spaces or commas" /></div>
          </div>
        </details>
        <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Calculating…" : "Preview population change"}</button></div>
      </form>
      {prepared ? <div className="confirmation-panel" aria-live="polite">
        <h3>Confirm this exact population change</h3>
        <dl className="compact-facts">
          <div><dt>Matched</dt><dd>{prepared.preview.matched}</dd></div>
          <div><dt>Would change</dt><dd>{prepared.preview.wouldChange}</dd></div>
          <div><dt>Already present</dt><dd>{prepared.preview.alreadyPresent}</dd></div>
          <div><dt>Protected activity</dt><dd>{prepared.preview.protectedActivity}</dd></div>
          <div><dt>Unavailable</dt><dd>{prepared.preview.unavailable}</dd></div>
        </dl>
        <p className="muted">Confirmation expires at {formatCatDateTime(prepared.preview.expiresAt)} and fails if the live set changes.</p>
        <div className="form-actions"><button className="button" type="button" onClick={confirm} disabled={pending}>{pending ? "Applying…" : `Confirm ${prepared.request.operation}`}</button><button className="button secondary" type="button" onClick={() => setPrepared(null)} disabled={pending}>Cancel</button></div>
      </div> : null}
      <FeedbackMessage feedback={feedback} />
    </div>
  </details>;
}

function BulkAssignment({ campaignHandle, assignees }: { campaignHandle: string; assignees: Option[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [prepared, setPrepared] = useState<{ request: AssignmentRequest; preview: AssignmentPreview } | null>(null);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    setPrepared(null);
    const data = new FormData(event.currentTarget);
    const request = { assigneeHandle: String(data.get("assigneeHandle") ?? ""), criteria: assignmentCriteriaFromForm(data) };
    try {
      const payload = await postJson(`/api/campaigns/${campaignHandle}/assignments/bulk/preview`, request);
      const result = payload.preview as AssignmentPreview | undefined;
      if (!result || typeof result.confirmationToken !== "string") throw new Error("CAT couldn’t prepare a complete assignment preview. Try again.");
      setPrepared({ request, preview: result });
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT couldn’t preview the assignment." });
    } finally {
      setPending(false);
    }
  }

  async function confirm() {
    if (!prepared) return;
    setPending(true);
    setFeedback(null);
    try {
      await postJson(`/api/campaigns/${campaignHandle}/assignments/bulk`, {
        ...prepared.request,
        confirmationToken: prepared.preview.confirmationToken,
      });
      setPrepared(null);
      setFeedback({ tone: "success", message: `Assigned ${prepared.preview.wouldAssign} people.` });
      router.refresh();
    } catch (error) {
      setPrepared(null);
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "CAT couldn’t assign the matching people." });
    } finally {
      setPending(false);
    }
  }

  return <details className="campaign-operation">
    <summary>Assign an unassigned group</summary>
    <div className="stack campaign-operation-content">
      <p className="muted">Choose the organizer who will own this work. CAT will not select or rank an organizer for you.</p>
      <form className="stack" onSubmit={preview}>
        <div className="field"><label htmlFor="bulk-assignee">Organizer</label><select id="bulk-assignee" name="assigneeHandle" required defaultValue=""><option value="" disabled>Choose an organizer</option>{assignees.map((option) => <option key={option.handle} value={option.handle}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}</select></div>
        <CriteriaFields prefix="assignment" />
        <div className="field"><label htmlFor="assignment-workflow">Contact status</label><select id="assignment-workflow" name="workflowState" defaultValue="all"><option value="all">Any status</option><option value="not_contacted">Not contacted</option><option value="contacted">Contacted</option><option value="not_completed">Not completed</option></select></div>
        <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Calculating…" : "Preview bulk assignment"}</button></div>
      </form>
      {prepared ? <div className="confirmation-panel" aria-live="polite">
        <h3>Confirm this exact assignment</h3>
        <p><strong>{prepared.preview.wouldAssign}</strong> of {prepared.preview.matched} matching people are currently unassigned. {prepared.preview.alreadyAssigned} already have an organizer.</p>
        <div className="form-actions"><button className="button" type="button" onClick={confirm} disabled={pending}>{pending ? "Assigning…" : "Confirm assignment"}</button><button className="button secondary" type="button" onClick={() => setPrepared(null)} disabled={pending}>Cancel</button></div>
      </div> : null}
      <FeedbackMessage feedback={feedback} />
    </div>
  </details>;
}

export function CampaignBulkOperations({
  campaignHandle,
  status,
  assignees,
}: {
  campaignHandle: string;
  status: "draft" | "active" | "closed";
  assignees: Option[];
}) {
  if (status === "closed") return null;
  return <div className="campaign-operations-grid">
    {status === "draft" ? <PopulationBuilder campaignHandle={campaignHandle} /> : null}
    <BulkAssignment campaignHandle={campaignHandle} assignees={assignees} />
  </div>;
}
