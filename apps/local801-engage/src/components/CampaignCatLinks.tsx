"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type ActionOption = { handle: string; name: string; status: string };
type LinkItem = { handle: string; actionHandle: string; actionName: string; actionStatus: string };

async function mutation(url: string, method: "POST" | "DELETE", body?: Record<string, unknown>) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The relationship could not be changed.");
}

export function CampaignCatLinks({ campaignHandle, links, actions }: {
  campaignHandle: string; links: LinkItem[]; actions: ActionOption[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const linked = new Set(links.map((item) => item.actionHandle));
  const available = actions.filter((item) => !linked.has(item.handle));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const actionHandle = String(new FormData(form).get("actionHandle") ?? "");
    if (!actionHandle) return;
    setPending(true); setMessage("");
    try {
      await mutation(`/api/campaigns/${campaignHandle}/cat-actions`, "POST", { actionHandle });
      form.reset(); setMessage("CAT Action linked to this campaign."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The relationship could not be saved."); }
    finally { setPending(false); }
  }

  async function remove(linkHandle: string) {
    if (!window.confirm("Remove this durable campaign/CAT Action relationship? Its audit history will remain.")) return;
    setPending(true); setMessage("");
    try { await mutation(`/api/campaign-cat-links/${linkHandle}`, "DELETE"); setMessage("Relationship removed."); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The relationship could not be removed."); }
    finally { setPending(false); }
  }

  return <div className="grid">
    {links.length ? <ul className="record-list">{links.map((item) => <li key={item.handle}>
      <div><Link href={`/cat-actions/${item.actionHandle}`}><strong>{item.actionName}</strong></Link> · {item.actionStatus}</div>
      <button className="button secondary compact-button" disabled={pending} onClick={() => void remove(item.handle)} type="button">Remove link</button>
    </li>)}</ul> : <p className="muted">No CAT Actions are durably linked to this campaign yet.</p>}
    {available.length ? <form className="form-grid" onSubmit={submit}>
      <div className="field"><label htmlFor="campaign-cat-action-link">CAT Action</label><select id="campaign-cat-action-link" name="actionHandle" defaultValue="" required>
        <option value="" disabled>Select a CAT Action</option>{available.map((item) => <option value={item.handle} key={item.handle}>{item.name} · {item.status}</option>)}
      </select></div>
      <div className="form-actions"><button className="button" disabled={pending} type="submit">{pending ? "Saving…" : "Link CAT Action"}</button></div>
    </form> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </div>;
}
