"use client";

import { useEffect, useMemo, useState } from "react";
import { INQUIRY_TOPIC_LABELS, type InquiryTopic, normalizeInquiryTopic } from "@/lib/publicInquiry";
import { trackPublicFunnelEvent } from "@/lib/publicFunnelClient";

type Props = {
  defaultTopic?: InquiryTopic;
  source: "contact" | "procurement";
  title?: string;
  body?: string;
  submitLabel?: string;
};

type FormState = {
  name: string;
  email: string;
  company: string;
  message: string;
};

type Feedback =
  | { tone: "success"; message: string }
  | { tone: "error"; message: string }
  | null;

const TOPIC_ORDER: InquiryTopic[] = [
  "demo_request",
  "procurement",
  "product_support",
  "privacy_legal",
  "security_disclosure",
  "general",
];

const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readTopicFromLocation(fallback: InquiryTopic): InquiryTopic {
  if (typeof window === "undefined") return fallback;
  const params = new URLSearchParams(window.location.search);
  return normalizeInquiryTopic(params.get("topic")) ?? fallback;
}

function placeholderForTopic(topic: InquiryTopic): string {
  if (topic === "procurement") {
    return "We are evaluating Doclinks and would like the procurement package, response timeline, and any buyer review guidance.";
  }
  if (topic === "demo_request") {
    return "We share contracts and financial documents with clients and want to see how Doclinks handles protected delivery, expiry, and revocation.";
  }
  if (topic === "product_support") {
    return "We need help with onboarding, account setup, or a workflow question.";
  }
  if (topic === "privacy_legal") {
    return "We have a question about the DPA, retention, subprocessors, or another legal/privacy review item.";
  }
  if (topic === "security_disclosure") {
    return "We would like to coordinate a private security disclosure and share the relevant context.";
  }
  return "Tell us what you are trying to do and where you would like help.";
}

export default function InquiryForm({
  defaultTopic = "demo_request",
  source,
  title = "Start a direct request.",
  body = "Use the form below for demos, procurement, product questions, and follow-up. Direct email routes remain available, but this path works even when visitors are not using a local mail client.",
  submitLabel = "Send request",
}: Props) {
  const [topic, setTopic] = useState<InquiryTopic>(defaultTopic);
  const [form, setForm] = useState<FormState>({
    name: "",
    email: "",
    company: "",
    message: "",
  });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setTopic(readTopicFromLocation(defaultTopic));
  }, [defaultTopic]);

  const errors = useMemo(() => {
    return {
      name: form.name.trim().length >= 2 ? null : "Add your name.",
      email: BASIC_EMAIL_RE.test(form.email.trim().toLowerCase()) ? null : "Enter a valid work email.",
      company: form.company.trim().length >= 2 ? null : "Add your company or team name.",
      message: form.message.trim().length >= 24 ? null : "Add a little more detail so we can route this correctly.",
    };
  }, [form.company, form.email, form.message, form.name]);

  const hasErrors = Boolean(errors.name || errors.email || errors.company || errors.message);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (hasErrors) {
      setFeedback({ tone: "error", message: "Please complete the highlighted fields." });
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic,
          source,
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          company: form.company.trim(),
          message: form.message.trim(),
          sourcePage: typeof window !== "undefined" ? window.location.pathname : source === "procurement" ? "/trust/procurement" : "/contact",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        setFeedback({
          tone: "error",
          message: data?.message || "Unable to send your request right now. You can still use the direct email routes below.",
        });
        return;
      }

      setSubmitted(true);
      setFeedback({
        tone: "success",
        message:
          topic === "procurement"
            ? "Your procurement request has been sent. We now have the context needed to follow up."
            : "Your request has been sent. We now have the context needed to reply directly.",
      });
      trackPublicFunnelEvent({
        action: topic === "procurement" ? "procurement_request" : "contact_request",
        label: INQUIRY_TOPIC_LABELS[topic],
        location: source === "procurement" ? "procurement" : "contact",
        tier: "primary",
        target: "/api/contact",
      });
      setForm({
        name: "",
        email: "",
        company: "",
        message: "",
      });
    } catch {
      setFeedback({
        tone: "error",
        message: "Network error. Please try again or use the direct email routes below.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface-panel-strong rounded-sm p-6 sm:p-7">
      <div className="max-w-2xl">
        <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Request form</div>
        <h2 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 text-base leading-8 text-[var(--text-secondary)]">{body}</p>
      </div>

      <form className="mt-8 grid gap-4" onSubmit={onSubmit} noValidate>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-slate-950">Name</span>
            <input
              value={form.name}
              onChange={(event) => updateField("name", event.target.value)}
              className="field-input mt-2 rounded-sm px-3 py-3 text-sm"
              placeholder="Your name"
              autoComplete="name"
            />
            {errors.name ? <span className="mt-2 block text-xs text-[var(--danger)]">{errors.name}</span> : null}
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-950">Work email</span>
            <input
              value={form.email}
              onChange={(event) => updateField("email", event.target.value)}
              className="field-input mt-2 rounded-sm px-3 py-3 text-sm"
              placeholder="you@company.com"
              autoComplete="email"
              inputMode="email"
            />
            {errors.email ? <span className="mt-2 block text-xs text-[var(--danger)]">{errors.email}</span> : null}
          </label>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <label className="block">
            <span className="text-sm font-medium text-slate-950">Company or team</span>
            <input
              value={form.company}
              onChange={(event) => updateField("company", event.target.value)}
              className="field-input mt-2 rounded-sm px-3 py-3 text-sm"
              placeholder="Company name"
              autoComplete="organization"
            />
            {errors.company ? <span className="mt-2 block text-xs text-[var(--danger)]">{errors.company}</span> : null}
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-950">Topic</span>
            <select
              value={topic}
              onChange={(event) => setTopic(normalizeInquiryTopic(event.target.value) ?? defaultTopic)}
              className="field-input mt-2 rounded-sm px-3 py-3 text-sm"
            >
              {TOPIC_ORDER.map((item) => (
                <option key={item} value={item}>
                  {INQUIRY_TOPIC_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-slate-950">Message</span>
          <textarea
            value={form.message}
            onChange={(event) => updateField("message", event.target.value)}
            className="field-input mt-2 min-h-36 rounded-sm px-3 py-3 text-sm"
            placeholder={placeholderForTopic(topic)}
          />
          {errors.message ? <span className="mt-2 block text-xs text-[var(--danger)]">{errors.message}</span> : null}
        </label>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-[var(--text-muted)]">
            {submitted
              ? "Thanks. Your request is now in the queue."
              : "This form is the fastest path when you want a response but do not want to rely on a mail client."}
          </div>
          <button type="submit" disabled={busy} className="btn-base btn-primary rounded-sm px-5 py-3 text-sm font-medium disabled:opacity-60">
            {busy ? "Sending..." : submitLabel}
          </button>
        </div>

        {feedback ? (
          <div
            className={
              feedback.tone === "success"
                ? "border border-[rgba(40,136,88,0.18)] bg-[rgba(40,136,88,0.08)] px-4 py-3 text-sm text-[var(--success)]"
                : "border border-[rgba(186,71,50,0.22)] bg-[rgba(186,71,50,0.08)] px-4 py-3 text-sm text-[var(--danger)]"
            }
            role="status"
            aria-live="polite"
          >
            {feedback.message}
          </div>
        ) : null}
      </form>
    </div>
  );
}
