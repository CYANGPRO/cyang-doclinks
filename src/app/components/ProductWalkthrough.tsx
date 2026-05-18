"use client";

import { useState } from "react";
import { trackPublicFunnelEvent } from "@/lib/publicFunnelClient";

type WalkthroughStep = {
  id: string;
  label: string;
  title: string;
  senderState: string;
  recipientState: string;
  result: string;
  systemChecks: string[];
};

const DEFAULT_STEPS: WalkthroughStep[] = [
  {
    id: "prepare",
    label: "1. Prepare",
    title: "Sender uploads a contract and sets the sharing rules.",
    senderState: "Upload succeeds, expiry is set, download is disabled, and the link is ready for a specific workflow.",
    recipientState: "Nothing is visible yet. The recipient only receives a clean protected link once the sender is ready.",
    result: "The document is prepared with policy before delivery starts.",
    systemChecks: [
      "Validate the upload path and document state.",
      "Attach expiry, revocation, and view rules to the share.",
      "Keep the file private while delivery eligibility is evaluated.",
    ],
  },
  {
    id: "release",
    label: "2. Release",
    title: "The protected link is sent and the system decides whether the file can be released.",
    senderState: "The sender shares a clean Doclinks URL instead of forwarding the raw file itself.",
    recipientState: "The recipient lands on a focused delivery page instead of a generic storage interface.",
    result: "Delivery starts from a controlled link, not from a loose attachment.",
    systemChecks: [
      "Require the document to pass scan-gated release before opening.",
      "Check that the share is still active and within policy.",
      "Present a clear recipient path without exposing the storage layer.",
    ],
  },
  {
    id: "open",
    label: "3. Open",
    title: "The recipient opens the link and the current rules are checked again.",
    senderState: "The sender still has visibility into delivery activity and can react if the workflow changes.",
    recipientState: "If access is still allowed, the document opens in a calm branded viewer. If not, access fails closed.",
    result: "Access is granted by current policy, not by the age of the URL.",
    systemChecks: [
      "Evaluate expiry, revocation, and any view limits at serve time.",
      "Allow or block download according to the current share policy.",
      "Keep enough delivery visibility for follow-up and support.",
    ],
  },
  {
    id: "close",
    label: "4. Close",
    title: "The workflow ends and the sender closes the loop.",
    senderState: "The sender revokes access or lets the link expire when the document is no longer needed.",
    recipientState: "Future opens show the correct closed state instead of silently drifting into stale access.",
    result: "The sharing path ends when the workflow ends.",
    systemChecks: [
      "Fail closed once the share is revoked or expired.",
      "Preserve the audit trail around what happened and when.",
      "Keep the recipient experience clear even when access ends.",
    ],
  },
];

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ProductWalkthrough({
  title = "See the product flow before you sign up.",
  body = "Walk through a realistic sender and recipient path to see how Doclinks keeps policy, delivery, and closure aligned.",
  steps = DEFAULT_STEPS,
}: {
  title?: string;
  body?: string;
  steps?: WalkthroughStep[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = steps[activeIndex] ?? steps[0];

  return (
    <div className="surface-panel-strong overflow-hidden rounded-sm p-6 sm:p-8 lg:p-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <div className="max-w-xl">
          <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-faint)]">Interactive walkthrough</div>
          <h3 className="mt-4 text-balance text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">
            {title}
          </h3>
          <p className="mt-4 text-base leading-8 text-[var(--text-secondary)]">{body}</p>
          <div className="mt-6 space-y-2">
            {steps.map((step, index) => (
              <button
                key={step.id}
                type="button"
                onClick={() => {
                  setActiveIndex(index);
                  trackPublicFunnelEvent({
                    action: "demo_interaction",
                    label: step.label,
                    location: "demo",
                    tier: "secondary",
                    target: `#${step.id}`,
                  });
                }}
                aria-pressed={index === activeIndex}
                className={cn(
                  "selection-tile flex w-full items-start justify-between gap-4 p-4 text-left",
                  index === activeIndex && "border-[var(--border-accent)] bg-[var(--surface-selected)]"
                )}
              >
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">{step.label}</div>
                  <div className="mt-2 text-base font-semibold text-slate-950">{step.title}</div>
                </div>
                <span className="text-sm text-[var(--text-secondary)]" aria-hidden="true">
                  {index === activeIndex ? "Active" : "View"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="surface-panel rounded-sm p-5">
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Sender side</div>
              <p className="mt-4 text-base leading-8 text-[var(--text-secondary)]">{active.senderState}</p>
            </div>
            <div className="surface-panel rounded-sm p-5">
              <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">Recipient side</div>
              <p className="mt-4 text-base leading-8 text-[var(--text-secondary)]">{active.recipientState}</p>
            </div>
          </div>

          <div className="surface-panel rounded-sm p-5">
            <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--text-faint)]">What the system enforces</div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {active.systemChecks.map((item) => (
                <div key={item} className="surface-panel-soft rounded-sm p-4 text-sm leading-7 text-[var(--text-secondary)]">
                  {item}
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-sm border border-[var(--border-subtle)] bg-white px-4 py-3 text-sm font-medium text-slate-950">
              Outcome: {active.result}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
