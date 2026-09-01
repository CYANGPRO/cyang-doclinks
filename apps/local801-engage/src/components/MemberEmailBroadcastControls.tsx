"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const AUDIENCE_GROUPS = ["Membership", "CAT", "Departments", "Saved lists"] as const;

type Audience = {
  audienceKey: string;
  audienceLabel: string;
  snapshotDate: string;
  representedRecipients: number;
  eligible: number;
  missing: number;
  duplicate: number;
  suppressed: number;
  homePreferred: number;
  workFallback: number;
  syntheticOnly: true;
};

type AudienceOption = {
  key: string;
  label: string;
  group: "Membership" | "CAT" | "Departments" | "Saved lists";
  description: string;
};

type Feedback = { tone: "error" | "success"; message: string } | null;

function isoDateTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString();
}

async function post(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: string };
  if (!response.ok) throw new Error(payload.message || "The Preview broadcast operation could not be completed.");
  return payload;
}

function FeedbackMessage({ value }: { value: Feedback }) {
  if (!value) return null;
  return <div className={`form-message${value.tone === "success" ? " success" : ""}`}
    role={value.tone === "error" ? "alert" : "status"}>{value.message}</div>;
}

export function MemberEmailBroadcastComposer({ audienceOptions }: { audienceOptions: AudienceOption[] }) {
  const router = useRouter();
  const [selectedAudience, setSelectedAudience] = useState(audienceOptions[0]?.key ?? "members");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [pending, setPending] = useState<"preview" | "create" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function loadPreview() {
    setPending("preview");
    setFeedback(null);
    try {
      const payload = await post("/api/email-broadcasts/preview", { audienceKey: selectedAudience });
      setAudience(payload.audience as Audience);
      setFeedback({ tone: "success", message: "Synthetic recipient preview refreshed for the selected audience." });
    } catch (error) {
      setAudience(null);
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Recipient preview is unavailable." });
    } finally {
      setPending(null);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!audience) {
      setFeedback({ tone: "error", message: "Preview the synthetic recipients before creating a draft." });
      return;
    }
    if (audience.audienceKey !== selectedAudience) {
      setAudience(null);
      setFeedback({ tone: "error", message: "Preview the currently selected audience before creating a draft." });
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    const scheduledFor = isoDateTime(String(data.get("scheduledFor") ?? ""));
    if (scheduledFor === "invalid") {
      setFeedback({ tone: "error", message: "Enter a valid simulated send time." });
      return;
    }
    setPending("create");
    setFeedback(null);
    try {
      await post("/api/email-broadcasts", {
        subject: String(data.get("subject") ?? ""),
        body: String(data.get("body") ?? ""),
        audienceKey: selectedAudience,
        scheduledFor,
      });
      form.reset();
      setAudience(null);
      setFeedback({ tone: "success", message: "Preview broadcast draft created with a frozen synthetic recipient snapshot." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "The draft could not be created." });
    } finally {
      setPending(null);
    }
  }

  return <form className="stack" onSubmit={create}>
    <div className="callout neutral">
      <strong>Member delivery stays simulated.</strong> Draft audiences remain locked to <code>example.test</code>. A separate action may send one configured external test through Resend, never the member list.
    </div>
    <div className="field">
      <label htmlFor="member-email-audience">Recipients</label>
      <select id="member-email-audience" name="audienceKey" value={selectedAudience}
        aria-describedby="member-email-audience-help"
        onChange={(event) => {
          setSelectedAudience(event.target.value);
          setAudience(null);
          setFeedback(null);
        }} disabled={pending !== null}>
        {AUDIENCE_GROUPS.map((group) => {
          const grouped = audienceOptions.filter((option) => option.group === group);
          return grouped.length ? <optgroup key={group} label={group}>
            {grouped.map((option) => <option key={option.key} value={option.key}>{option.label} — {option.description}</option>)}
          </optgroup> : null;
        })}
      </select>
      <p className="field-help" id="member-email-audience-help">Departments contain current members only. Saved lists reuse frozen campaign populations; unknown membership records remain excluded.</p>
    </div>
    <div className="form-actions">
      <button className="button secondary" type="button" onClick={loadPreview} disabled={pending !== null}>
        {pending === "preview" ? "Checking…" : "Preview synthetic recipients"}
      </button>
    </div>
    {audience ? <><div className="callout neutral"><strong>Selected audience:</strong> {audience.audienceLabel}</div>
      <div className="metric-grid compact-metrics" aria-label="Synthetic recipient preview">
      <div className="metric-card"><span>Eligible deliveries</span><strong>{audience.eligible}</strong></div>
      <div className="metric-card"><span>Selected recipients</span><strong>{audience.representedRecipients}</strong></div>
      <div className="metric-card"><span>Home preferred</span><strong>{audience.homePreferred}</strong></div>
      <div className="metric-card"><span>Work fallback</span><strong>{audience.workFallback}</strong></div>
      <div className="metric-card"><span>Missing</span><strong>{audience.missing}</strong></div>
      <div className="metric-card"><span>Duplicate</span><strong>{audience.duplicate}</strong></div>
      <div className="metric-card"><span>Suppressed</span><strong>{audience.suppressed}</strong></div>
      <div className="metric-card"><span>Snapshot</span><strong>{audience.snapshotDate}</strong></div>
    </div></> : null}
    <div className="field">
      <label htmlFor="member-email-subject">Subject</label>
      <input id="member-email-subject" name="subject" required maxLength={160} />
    </div>
    <div className="field">
      <label htmlFor="member-email-body">Plain-text message</label>
      <textarea id="member-email-body" name="body" required maxLength={20000} rows={10} />
      <p className="field-help">Private documents should stay in CAT and be linked from the eventual production message.</p>
    </div>
    <div className="field">
      <label htmlFor="member-email-schedule">Optional simulated send time</label>
      <input id="member-email-schedule" name="scheduledFor" type="datetime-local" />
    </div>
    <div className="form-actions">
      <button className="button" type="submit" disabled={!audience || pending !== null}>
        {pending === "create" ? "Creating…" : "Create Preview draft"}
      </button>
    </div>
    <FeedbackMessage value={feedback} />
  </form>;
}

export function MemberEmailBroadcastActions({
  handle,
  status,
  requiresDifferentApprover,
  realTestRecipient,
}: {
  handle: string;
  status: "draft" | "review" | "approved" | "simulated" | "cancelled";
  requiresDifferentApprover: boolean;
  realTestRecipient: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function act(action: "submit" | "approve" | "simulate_test" | "simulate_send" | "real_test") {
    const warning = action === "approve"
      ? "Approve this frozen synthetic recipient list? No email will be delivered."
      : action === "simulate_send"
        ? "Record simulated delivery for every eligible synthetic recipient?"
        : action === "real_test"
          ? `Send one real external email through Resend to ${realTestRecipient}? No member email will be delivered.`
        : null;
    if (warning && !window.confirm(warning)) return;
    setPending(action);
    setFeedback(null);
    try {
      await post(`/api/email-broadcasts/${handle}/actions`, { action });
      setFeedback({
        tone: "success",
        message: action === "simulate_test"
          ? "Test simulation recorded."
          : action === "real_test"
            ? "Resend accepted the one-address Preview test."
            : "Preview workflow updated.",
      });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "The Preview workflow could not be updated." });
    } finally {
      setPending(null);
    }
  }

  if (status === "simulated" || status === "cancelled") return <span className="muted">No further actions</span>;
  return <div className="stack">
    <div className="form-actions compact-actions">
      {status === "draft" ? <button className="button secondary" type="button" onClick={() => act("submit")} disabled={pending !== null}>Submit for review</button> : null}
      {status === "review" ? <button className="button" type="button" onClick={() => act("approve")} disabled={pending !== null || requiresDifferentApprover}>Approve</button> : null}
      {status === "approved" ? <button className="button" type="button" onClick={() => act("simulate_send")} disabled={pending !== null}>Simulate delivery</button> : null}
      <button className="button secondary" type="button" onClick={() => act("simulate_test")} disabled={pending !== null}>Simulate test</button>
      {realTestRecipient ? <button className="button secondary" type="button" onClick={() => act("real_test")} disabled={pending !== null}>
        {pending === "real_test" ? "Sending…" : "Send real email test"}
      </button> : null}
    </div>
    {status === "review" && requiresDifferentApprover ? <span className="muted">Switch to the other authorized administrator to approve.</span> : null}
    <FeedbackMessage value={feedback} />
  </div>;
}
