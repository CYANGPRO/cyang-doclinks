"use client";

import { useMemo, useState } from "react";
import { DataTable, EmptyState, StatusBadge, type StatusTone } from "@/components/DesignSystem";
import { MemberEmailBroadcastActions } from "@/components/MemberEmailBroadcastControls";
import type { MemberEmailBroadcastSummary } from "@/lib/member-email-broadcasts";
import styles from "./MemberEmailBroadcastArchive.module.css";

function tone(status: MemberEmailBroadcastSummary["status"]): StatusTone {
  if (status === "sent" || status === "simulated") return "ready";
  if (status === "approved" || status === "queued" || status === "sending") return "info";
  if (status === "failed") return "blocked";
  if (status === "cancelled") return "neutral";
  return "pending";
}

function schedule(item: MemberEmailBroadcastSummary, mode: "preview" | "production") {
  if (item.scheduledFor) return new Date(item.scheduledFor).toLocaleString();
  return mode === "preview" ? "Manual simulation" : "Manual send";
}

export function MemberEmailBroadcastArchive({
  broadcasts,
  mode,
  providerReady,
  sender,
  replyTo,
  realTestRecipient,
}: {
  broadcasts: MemberEmailBroadcastSummary[];
  mode: "preview" | "production";
  providerReady: boolean;
  sender: string | null;
  replyTo: string | null;
  realTestRecipient: string | null;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return broadcasts.filter((item) => (status === "all" || item.status === status)
      && (!needle || `${item.subject} ${item.audienceLabel}`.toLocaleLowerCase().includes(needle)));
  }, [broadcasts, search, status]);

  if (broadcasts.length === 0) return <EmptyState title={`No ${mode === "preview" ? "Preview broadcasts" : "member notices"}`} description="Create the first draft after checking its recipients." />;

  return <div className="stack">
    <div className={styles.filters} role="search" aria-label="Filter email notices">
      <div className="field">
        <label htmlFor="email-archive-search">Search</label>
        <input id="email-archive-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Subject or audience" />
      </div>
      <div className="field">
        <label htmlFor="email-archive-status">Status</label>
        <select id="email-archive-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All statuses</option>
          {Array.from(new Set(broadcasts.map((item) => item.status))).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
    </div>
    <p className="muted" aria-live="polite">Showing {filtered.length} of {broadcasts.length} notices.</p>
    {filtered.length === 0 ? <EmptyState title="No notices match" description="Change the search or status filter." /> : <DataTable caption="Email notice archive" headers={["Notice", "Status", "Audience", "Delivery", "Schedule", "Actions"]}>
      {filtered.map((item) => <tr key={item.handle}>
        <td><strong>{item.subject}</strong><br /><span className="muted">Created {new Date(item.createdAt).toLocaleString()}</span>{item.attachmentCount ? <><br /><span className="muted">{item.attachmentCount} {item.attachmentCount === 1 ? "attachment" : "attachments"}</span></> : null}</td>
        <td><StatusBadge tone={tone(item.status)}>{item.status}</StatusBadge>{item.failureCode ? <><br /><span className="muted">Needs attention</span></> : null}</td>
        <td><strong>{item.audienceLabel}</strong><br />{item.eligible} deliverable of {item.representedRecipients}<br /><span className="muted">{item.missing} missing · {item.duplicate} duplicate · {item.suppressed} suppressed</span></td>
        <td>{mode === "preview"
          ? item.status === "simulated" ? `${item.eligible} simulated` : "Not delivered"
          : <><strong>{item.deliveryCounts.delivered} delivered</strong><br /><span className="muted">{item.deliveryCounts.accepted} accepted · {item.deliveryCounts.pending} pending · {item.deliveryCounts.failed} failed</span></>}</td>
        <td>{schedule(item, mode)}</td>
        <td><MemberEmailBroadcastActions
          handle={item.handle}
          status={item.status}
          requiresDifferentApprover={item.requiresDifferentApprover}
          mode={mode}
          providerReady={providerReady}
          eligible={item.eligible}
          sender={sender}
          replyTo={replyTo}
          realTestRecipient={realTestRecipient}
        /></td>
      </tr>)}
    </DataTable>}
  </div>;
}
