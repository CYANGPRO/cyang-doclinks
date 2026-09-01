"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { renderMemberEmailHtml } from "@/lib/member-email-format";
import styles from "./MemberEmailBroadcastControls.module.css";

const AUDIENCE_GROUPS = ["Membership", "Users", "CAT", "Departments", "Saved lists"] as const;

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
  group: "Membership" | "Users" | "CAT" | "Departments" | "Saved lists";
  description: string;
};

type AttachmentOption = {
  handle: string;
  title: string;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
};

type Feedback = { tone: "error" | "success"; message: string } | null;

type DraftReview = {
  subject: string;
  body: string;
  scheduledFor: string | null;
  scheduledDisplay: string;
  attachments: AttachmentOption[];
};

function fileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isoDateTime(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString();
}

function formatSnapshotDate(value: string) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatSchedule(value: string | null) {
  if (!value) return "Manual send after approval";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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

export function MemberEmailBroadcastComposer({
  audienceOptions,
  attachmentOptions,
  sender,
  replyTo,
}: {
  audienceOptions: AudienceOption[];
  attachmentOptions: AttachmentOption[] | null;
  sender: string | null;
  replyTo: string | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [selectedAudience, setSelectedAudience] = useState(audienceOptions[0]?.key ?? "members");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [bodySource, setBodySource] = useState("");
  const [selectedAttachmentHandles, setSelectedAttachmentHandles] = useState<string[]>([]);
  const [review, setReview] = useState<DraftReview | null>(null);
  const [pending, setPending] = useState<"preview" | "create" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  function toggleAttachment(option: AttachmentOption, checked: boolean) {
    const next = checked
      ? [...selectedAttachmentHandles, option.handle]
      : selectedAttachmentHandles.filter((handle) => handle !== option.handle);
    const selected = (attachmentOptions ?? []).filter((attachment) => next.includes(attachment.handle));
    if (next.length > 5) {
      setFeedback({ tone: "error", message: "Choose no more than 5 attachments." });
      return;
    }
    if (selected.reduce((total, attachment) => total + attachment.byteSize, 0) > 20 * 1024 * 1024) {
      setFeedback({ tone: "error", message: "Attachments must total 20 MB or less." });
      return;
    }
    setSelectedAttachmentHandles(next);
    setReview(null);
    setFeedback(null);
  }

  function updateBody(next: string, selectionStart: number, selectionEnd: number) {
    setBodySource(next);
    setReview(null);
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function wrapSelection(prefix: string, suffix: string, placeholder: string, selectUrl = false) {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = bodySource.slice(start, end) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;
    const next = `${bodySource.slice(0, start)}${replacement}${bodySource.slice(end)}`;
    if (selectUrl) {
      const urlStart = start + replacement.lastIndexOf("https://");
      updateBody(next, urlStart, urlStart + "https://example.com".length);
      return;
    }
    updateBody(next, start + prefix.length, start + prefix.length + selected.length);
  }

  function prefixSelectedLines(kind: "heading" | "bullets" | "numbers") {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const start = bodySource.lastIndexOf("\n", Math.max(0, textarea.selectionStart - 1)) + 1;
    const nextLine = bodySource.indexOf("\n", textarea.selectionEnd);
    const end = nextLine === -1 ? bodySource.length : nextLine;
    let number = 1;
    const replacement = bodySource.slice(start, end).split("\n").map((line) => {
      if (!line.trim()) return line;
      if (kind === "heading") return `# ${line}`;
      if (kind === "bullets") return `- ${line}`;
      return `${number++}. ${line}`;
    }).join("\n");
    const next = `${bodySource.slice(0, start)}${replacement}${bodySource.slice(end)}`;
    updateBody(next, start, start + replacement.length);
  }

  async function loadPreview() {
    setPending("preview");
    setReview(null);
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

  function prepareReview(event: FormEvent<HTMLFormElement>) {
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
    const subject = String(data.get("subject") ?? "").trim();
    const body = String(data.get("body") ?? "").trim();
    if (!subject || !body) {
      setFeedback({ tone: "error", message: "Enter both a subject and message before reviewing the notice." });
      return;
    }
    const scheduledFor = isoDateTime(String(data.get("scheduledFor") ?? ""));
    if (scheduledFor === "invalid") {
      setFeedback({ tone: "error", message: "Enter a valid simulated send time." });
      return;
    }
    setFeedback(null);
    const attachments = (attachmentOptions ?? []).filter((attachment) => selectedAttachmentHandles.includes(attachment.handle));
    setReview({ subject, body, scheduledFor, scheduledDisplay: formatSchedule(scheduledFor), attachments });
  }

  async function create() {
    if (!audience || !review || audience.audienceKey !== selectedAudience) {
      setReview(null);
      setFeedback({ tone: "error", message: "Review the currently selected audience and notice before creating a draft." });
      return;
    }
    setPending("create");
    setFeedback(null);
    try {
      await post("/api/email-broadcasts", {
        subject: review.subject,
        body: review.body,
        audienceKey: selectedAudience,
        scheduledFor: review.scheduledFor,
        attachmentHandles: review.attachments.map((attachment) => attachment.handle),
      });
      formRef.current?.reset();
      setBodySource("");
      setSelectedAttachmentHandles([]);
      setAudience(null);
      setReview(null);
      setFeedback({ tone: "success", message: "Preview broadcast draft created with a frozen synthetic recipient snapshot." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "The draft could not be created." });
    } finally {
      setPending(null);
    }
  }

  return <form ref={formRef} className="stack" onSubmit={prepareReview} onInput={() => setReview(null)}>
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
          setReview(null);
          setFeedback(null);
        }} disabled={pending !== null}>
        {AUDIENCE_GROUPS.map((group) => {
          const grouped = audienceOptions.filter((option) => option.group === group);
          return grouped.length ? <optgroup key={group} label={group}>
            {grouped.map((option) => <option key={option.key} value={option.key}>{option.label} — {option.description}</option>)}
          </optgroup> : null;
        })}
      </select>
      <p className="field-help" id="member-email-audience-help">Registered users include every active Local 801 account with an assigned role. Departments contain current members only; unknown membership records remain excluded.</p>
    </div>
    <div className="form-actions">
      <button className="button secondary" type="button" onClick={loadPreview} disabled={pending !== null}>
        {pending === "preview" ? "Checking…" : "Preview synthetic recipients"}
      </button>
    </div>
    {audience ? <section className={styles.recipientPreview} aria-labelledby="recipient-preview-title" aria-live="polite">
      <header className={styles.previewHeader}>
        <div>
          <span className={styles.eyebrow}>Recipient preview</span>
          <h3 id="recipient-preview-title">{audience.audienceLabel}</h3>
          <p>Approved membership snapshot from {formatSnapshotDate(audience.snapshotDate)}</p>
        </div>
        <span className={styles.readyBadge}><span aria-hidden="true">✓</span> Checked</span>
      </header>

      <div className={styles.deliverySummary}>
        <div>
          <span className={styles.summaryLabel}>Ready to receive</span>
          <strong>{audience.eligible}</strong>
          <span>of {audience.representedRecipients} selected recipients</span>
        </div>
        <progress className={styles.deliveryProgress} value={audience.eligible} max={Math.max(audience.representedRecipients, 1)}>
          {audience.eligible} of {audience.representedRecipients}
        </progress>
      </div>

      <div className={styles.breakdownSection}>
        <div className={styles.breakdownHeading}>
          <h4>Address selection</h4>
          <p>CAT prefers a home address, then falls back to a work address.</p>
        </div>
        <dl className={styles.addressGrid}>
          <div><dt>Home address</dt><dd>{audience.homePreferred}</dd></div>
          <div><dt>Work fallback</dt><dd>{audience.workFallback}</dd></div>
        </dl>
      </div>

      <div className={styles.breakdownSection}>
        <div className={styles.breakdownHeading}>
          <h4>Not deliverable</h4>
          <p>These records are excluded before the draft is created.</p>
        </div>
        <dl className={styles.exclusionGrid}>
          <div data-empty={audience.missing === 0}><dt>Missing email</dt><dd>{audience.missing}</dd></div>
          <div data-empty={audience.duplicate === 0}><dt>Duplicate removed</dt><dd>{audience.duplicate}</dd></div>
          <div data-empty={audience.suppressed === 0}><dt>Suppressed</dt><dd>{audience.suppressed}</dd></div>
        </dl>
      </div>

      <p className={styles.privacyNote}>Only aggregate counts are shown here. Recipient addresses remain protected.</p>
    </section> : null}
    <div className={styles.composeHeading}>
      <span>Next</span>
      <div>
        <h3>Compose the notice</h3>
        <p>The draft can be created after the selected audience has been checked.</p>
      </div>
    </div>
    <div className="field">
      <label htmlFor="member-email-subject">Subject</label>
      <input id="member-email-subject" name="subject" required maxLength={160} />
    </div>
    <div className="field">
      <label htmlFor="member-email-body">Message</label>
      <div className={styles.editorWorkspace}>
        <div className={styles.formatEditor}>
          <div className={styles.formattingToolbar} role="toolbar" aria-label="Message formatting">
            <button type="button" onClick={() => wrapSelection("**", "**", "bold text")} aria-label="Bold" title="Bold"><strong>B</strong></button>
            <button type="button" onClick={() => wrapSelection("*", "*", "italic text")} aria-label="Italic" title="Italic"><em>I</em></button>
            <button type="button" onClick={() => prefixSelectedLines("heading")} aria-label="Heading" title="Heading">Heading</button>
            <button type="button" onClick={() => prefixSelectedLines("bullets")} aria-label="Bulleted list" title="Bulleted list">• List</button>
            <button type="button" onClick={() => prefixSelectedLines("numbers")} aria-label="Numbered list" title="Numbered list">1. List</button>
            <button type="button" onClick={() => wrapSelection("[", "](https://example.com)", "link text", true)} aria-label="Link" title="Link">Link</button>
          </div>
          <textarea ref={bodyRef} className={styles.messageEditor} id="member-email-body" name="body" required maxLength={20000} rows={13}
            value={bodySource} onChange={(event) => {
              setBodySource(event.target.value);
              setReview(null);
            }} />
          <div className={styles.editorMeta}><span>Limited formatting only</span><span>{bodySource.length.toLocaleString()} / 20,000</span></div>
        </div>
        <div className={styles.livePreview} aria-live="polite">
          <span className={styles.previewLabel}>Formatting preview</span>
          <div className={styles.previewContent} dangerouslySetInnerHTML={{ __html: renderMemberEmailHtml(bodySource) }} />
        </div>
      </div>
      <p className="field-help">Use headings, bold, italic, lists, and safe web links. Raw HTML is shown as text, and CAT generates a plain-text fallback automatically. Private documents should stay in CAT.</p>
    </div>
    <div className="field">
      <span className={styles.fieldLabel}>Attachments</span>
      {attachmentOptions === null ? <div className="callout neutral">
        <strong>Attachments are temporarily unavailable.</strong> You can still create the notice without a file.
      </div> : attachmentOptions.length === 0 ? <div className="callout neutral">
        <strong>No approved documents are available.</strong> Upload and approve a file in <Link href="/documents">Documents</Link>, then return here.
      </div> : <div className={styles.attachmentPicker}>
        {attachmentOptions.map((attachment) => <label key={attachment.handle} className={styles.attachmentChoice}>
          <input type="checkbox" checked={selectedAttachmentHandles.includes(attachment.handle)}
            onChange={(event) => toggleAttachment(attachment, event.target.checked)} />
          <span><strong>{attachment.title}</strong><small>{attachment.originalFilename} · {fileSize(attachment.byteSize)}</small></span>
        </label>)}
      </div>}
      <p className="field-help">Optional. Choose up to 5 approved CAT Documents, totaling no more than 20 MB. Access and file integrity are checked again before a real Preview test.</p>
    </div>
    <div className="field">
      <label htmlFor="member-email-schedule">Optional simulated send time</label>
      <input id="member-email-schedule" name="scheduledFor" type="datetime-local" />
    </div>
    <div className="form-actions">
      {!review ? <button className="button" type="submit" disabled={!audience || pending !== null}>Review notice</button> : null}
    </div>
    {review && audience ? <section className={styles.finalReview} aria-labelledby="final-review-title" aria-live="polite">
      <header className={styles.finalReviewHeader}>
        <div>
          <span className={styles.eyebrow}>Final review</span>
          <h3 id="final-review-title">Confirm this Preview draft</h3>
          <p>Check the delivery details and message before freezing the recipient snapshot.</p>
        </div>
        <span className={styles.reviewBadge}>Not sent yet</span>
      </header>

      <dl className={styles.reviewDetails}>
        <div><dt>Audience</dt><dd>{audience.audienceLabel}</dd></div>
        <div><dt>Deliverable recipients</dt><dd>{audience.eligible}</dd></div>
        <div><dt>From</dt><dd>{sender ?? "Sender not configured"}</dd></div>
        <div><dt>Replies go to</dt><dd>{replyTo ?? "Reply-To not configured"}</dd></div>
        <div><dt>Schedule</dt><dd>{review.scheduledDisplay}</dd></div>
        <div><dt>Attachments</dt><dd>{review.attachments.length === 0 ? "None" : `${review.attachments.length} selected`}</dd></div>
      </dl>

      <div className={styles.messageReview}>
        <span>Subject</span>
        <strong>{review.subject}</strong>
        <span>Message</span>
        <div dangerouslySetInnerHTML={{ __html: renderMemberEmailHtml(review.body) }} />
        {review.attachments.length > 0 ? <>
          <span>Attachments</span>
          <ul className={styles.attachmentReviewList}>{review.attachments.map((attachment) => <li key={attachment.handle}>
            <strong>{attachment.title}</strong><span>{attachment.originalFilename} · {fileSize(attachment.byteSize)}</span>
          </li>)}</ul>
        </> : null}
      </div>

      <div className={styles.freezeNotice}>
        <strong>Creating this draft does not send an email.</strong>
        It freezes this audience and message for the separate review and approval workflow.
      </div>
      <div className={styles.reviewActions}>
        <button className="button secondary" type="button" onClick={() => {
          setReview(null);
          document.getElementById("member-email-subject")?.focus();
        }} disabled={pending !== null}>Back to edit</button>
        <button className="button" type="button" onClick={create} disabled={pending !== null}>
          {pending === "create" ? "Creating…" : "Create Preview draft"}
        </button>
      </div>
    </section> : null}
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

  return <div className="stack">
    <div className="form-actions compact-actions">
      <Link className="button secondary" href={`/email-broadcasts/${handle}`}>View email</Link>
      {status === "draft" ? <button className="button secondary" type="button" onClick={() => act("submit")} disabled={pending !== null}>Submit for review</button> : null}
      {status === "review" ? <button className="button" type="button" onClick={() => act("approve")} disabled={pending !== null || requiresDifferentApprover}>Approve</button> : null}
      {status === "approved" ? <button className="button" type="button" onClick={() => act("simulate_send")} disabled={pending !== null}>Simulate delivery</button> : null}
      {status !== "simulated" && status !== "cancelled" ? <button className="button secondary" type="button" onClick={() => act("simulate_test")} disabled={pending !== null}>Simulate test</button> : null}
      {status !== "simulated" && status !== "cancelled" && realTestRecipient ? <button className="button secondary" type="button" onClick={() => act("real_test")} disabled={pending !== null}>
        {pending === "real_test" ? "Sending…" : "Send real email test"}
      </button> : null}
    </div>
    {status === "review" && requiresDifferentApprover ? <span className="muted">Switch to the other authorized administrator to approve.</span> : null}
    <FeedbackMessage value={feedback} />
  </div>;
}
