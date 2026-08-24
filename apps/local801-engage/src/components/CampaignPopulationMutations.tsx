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
  if (!response.ok) throw new Error(payload.message || "We couldn’t update the campaign list.");
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <span
    className={`inline-feedback${feedback.tone === "success" ? " success" : " error"}`}
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
      setFeedback({ tone: "success", message: "Added to campaign." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t add this person." });
    } finally {
      setPending(false);
    }
  }

  return <div className="inline-actions">
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
    if (!window.confirm(`Remove ${displayName} from this draft campaign? If they have an open assignment with no recorded campaign contact, that assignment will be archived too.`)) return;
    setPending(true);
    setFeedback(null);
    try {
      await sendPopulationChange(`/api/campaigns/${campaignHandle}/population/${personHandle}`, "DELETE");
      setFeedback({ tone: "success", message: "Removed from campaign." });
      router.refresh();
    } catch (error) {
      setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t remove this person." });
      setPending(false);
    }
  }

  return <div className="inline-actions vertical-actions">
    <button className="button secondary" type="button" onClick={remove} disabled={pending}>{pending ? "Removing…" : "Remove"}</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}
