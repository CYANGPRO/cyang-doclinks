"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Feedback = { tone: "error" | "success"; message: string } | null;

async function sendPopulationChange(url: string, method: "POST" | "DELETE", personHandle?: string) {
  const response = await fetch(url, {
    method,
    headers: personHandle ? { "Content-Type": "application/json" } : undefined,
    body: personHandle ? JSON.stringify({ personHandle }) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The campaign population change could not be completed.");
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <span
    className={feedback.tone === "error" ? "error-text" : undefined}
    style={feedback.tone === "success" ? { color: "var(--success)", fontWeight: 700 } : undefined}
    role={feedback.tone === "error" ? "alert" : "status"}
  >{feedback.message}</span>;
}

export function CampaignPopulationAddButton({
  campaignHandle,
  personHandle,
}: {
  campaignHandle: string;
  personHandle: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function add() {
    setPending(true);
    setFeedback(null);
    try {
      await sendPopulationChange(`/api/campaigns/${campaignHandle}/population`, "POST", personHandle);
      setFeedback({ tone: "success", message: "Added." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Add failed." });
    } finally {
      setPending(false);
    }
  }

  return <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
    <button className="button secondary" type="button" onClick={add} disabled={pending}>{pending ? "Adding…" : "Add to campaign"}</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}

export function CampaignPopulationRemoveButton({
  campaignHandle,
  personHandle,
  displayName,
}: {
  campaignHandle: string;
  personHandle: string;
  displayName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function remove() {
    if (!window.confirm(`Remove ${displayName} from this draft campaign? Any open assignment without engagement will be archived.`)) return;
    setPending(true);
    setFeedback(null);
    try {
      await sendPopulationChange(`/api/campaigns/${campaignHandle}/population/${personHandle}`, "DELETE");
      setFeedback({ tone: "success", message: "Removed." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Remove failed." });
      setPending(false);
    }
  }

  return <div style={{ display: "grid", gap: 6 }}>
    <button className="button secondary" type="button" onClick={remove} disabled={pending}>{pending ? "Removing…" : "Remove"}</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}
