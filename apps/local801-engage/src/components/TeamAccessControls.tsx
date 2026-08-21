"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { roleLabels, type Role } from "@/lib/access";

type Feedback = { tone: "error" | "success"; message: string } | null;

async function sendJson(url: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(payload.message || "The team access change could not be completed.");
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <span className={feedback.tone === "error" ? "error-text" : undefined}
    style={feedback.tone === "success" ? { color: "var(--success)", fontWeight: 700 } : undefined}
    role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</span>;
}

export function ProvisionTeamMemberForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setFeedback(null);
    const form = event.currentTarget; const data = new FormData(form);
    try {
      await sendJson("/api/team/users", "POST", {
        displayName: String(data.get("displayName") ?? ""),
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? ""),
      });
      form.reset(); setFeedback({ tone: "success", message: "User provisioned. They can sign in after the approved OIDC provider is configured." }); router.refresh();
    } catch (error) { setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Provisioning failed." }); }
    finally { setPending(false); }
  }

  return <form className="grid" onSubmit={submit}>
    <div className="field"><label htmlFor="team-display-name">Display name</label><input id="team-display-name" name="displayName" required maxLength={160} /></div>
    <div className="field"><label htmlFor="team-email">Verified IdP email</label><input id="team-email" name="email" type="email" required maxLength={320} /></div>
    <div className="field"><label htmlFor="team-role">Role</label><select id="team-role" name="role" required>{roles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></div>
    <button className="button" type="submit" disabled={pending}>{pending ? "Provisioning…" : "Provision user"}</button>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function TeamMemberControls({ handle, currentRole, active, roles }: { handle: string; currentRole: Role; active: boolean; roles: Role[] }) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(currentRole);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function action(actionName: string, body: Record<string, unknown> = {}) {
    setPending(actionName); setFeedback(null);
    try {
      await sendJson(`/api/team/users/${handle}`, "PATCH", { action: actionName, ...body });
      setFeedback({ tone: "success", message: actionName === "revoke_sessions" ? "Sessions revoked." : "Account access updated." }); router.refresh();
    } catch (error) { setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Update failed." }); }
    finally { setPending(null); }
  }

  return <div className="grid" style={{ minWidth: 220 }}>
    <div className="field"><label htmlFor={`role-${handle}`}>Role</label><select id={`role-${handle}`} value={role} onChange={(event) => setRole(event.target.value as Role)}>{roles.map((candidate) => <option key={candidate} value={candidate}>{roleLabels[candidate]}</option>)}</select></div>
    <button className="button secondary" type="button" disabled={pending !== null || role === currentRole} onClick={() => action("role", { role })}>Save role</button>
    <button className="button secondary" type="button" disabled={pending !== null} onClick={() => action(active ? "deactivate" : "reactivate")}>{active ? "Deactivate" : "Reactivate"}</button>
    <button className="button secondary" type="button" disabled={pending !== null} onClick={() => action("revoke_sessions")}>Revoke all sessions</button>
    <FeedbackMessage feedback={feedback} />
  </div>;
}
