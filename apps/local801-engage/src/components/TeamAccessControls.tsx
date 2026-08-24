"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { roleLabels, type Role } from "@/lib/access";

type Feedback = { tone: "error" | "success" | "warning"; message: string } | null;

async function sendJson(url: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { message?: string; teamAccess?: string; onboarding?: string; invitationSent?: boolean };
  if (!response.ok) throw new Error(payload.message || "We couldn’t save that access change.");
  return payload;
}

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <div
    className={`form-message${feedback.tone === "success" ? " success" : feedback.tone === "warning" ? " warning" : ""}`}
    role={feedback.tone === "error" ? "alert" : "status"}
  >{feedback.message}</div>;
}

export function ProvisionTeamMemberForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setFeedback(null);
    const form = event.currentTarget; const data = new FormData(form);
    try {
      const result = await sendJson("/api/team/users", "POST", {
        displayName: String(data.get("displayName") ?? ""),
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? ""),
      });
      form.reset();
      setFeedback(result.teamAccess === "partial"
        ? { tone: "warning", message: result.message || "The CAT account was saved, but the Entra invitation is not complete. Use Retry onboarding in the user list." }
        : { tone: "success", message: "User added. Microsoft Entra access was assigned and the onboarding invitation was sent." });
      router.refresh();
    } catch (error) { setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t add this user." }); }
    finally { setPending(false); }
  }

  return <form className="stack" onSubmit={submit}>
    <div className="form-grid">
      <div className="field"><label htmlFor="team-display-name">Display name</label><input id="team-display-name" name="displayName" required maxLength={160} /></div>
      <div className="field"><label htmlFor="team-email">Sign-in email</label><input id="team-email" name="email" type="email" required maxLength={320} /><span className="field-help">The invitation is sent here. The user must sign in with this exact address.</span></div>
      <div className="field"><label htmlFor="team-role">Role</label><select id="team-role" name="role" required>{roles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></div>
    </div>
    <div className="form-actions"><button className="button" type="submit" disabled={pending}>{pending ? "Adding and inviting…" : "Add user and send invitation"}</button></div>
    <FeedbackMessage feedback={feedback} />
  </form>;
}

export function TeamMemberControls({ handle, currentRole, active, roles, displayName, onboardingStatus }: { handle: string; currentRole: Role; active: boolean; roles: Role[]; displayName: string; onboardingStatus: "pending" | "processing" | "invited" | "ready" | "failed" | "not_managed" }) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(currentRole);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function action(actionName: string, body: Record<string, unknown> = {}) {
    setPending(actionName); setFeedback(null);
    try {
      await sendJson(`/api/team/users/${handle}`, "PATCH", { action: actionName, ...body });
      setFeedback({ tone: "success", message: actionName === "revoke_sessions"
        ? "Signed out on all devices."
        : actionName === "retry_onboarding"
          ? "Microsoft Entra access is assigned and the invitation has been sent."
          : "Access updated." }); router.refresh();
    } catch (error) { setFeedback({ tone: "error", message: error instanceof Error ? error.message : "We couldn’t update this user." }); }
    finally { setPending(null); }
  }

  function disruptiveAction(actionName: "deactivate" | "revoke_sessions") {
    const prompt = actionName === "deactivate"
      ? `Deactivate ${displayName}? They will be signed out and unable to access Engaging Local 801.`
      : `Sign ${displayName} out everywhere? All of their current sessions will end.`;
    if (window.confirm(prompt)) void action(actionName);
  }

  return <div className="stack team-member-controls">
    <div className="field"><label htmlFor={`role-${handle}`}>Role</label><select id={`role-${handle}`} value={role} onChange={(event) => setRole(event.target.value as Role)}>{roles.map((candidate) => <option key={candidate} value={candidate}>{roleLabels[candidate]}</option>)}</select></div>
    <div className="form-actions compact-actions">
      <button className="button secondary" type="button" disabled={pending !== null || role === currentRole} onClick={() => action("role", { role })}>Save role</button>
      <button className="button secondary" type="button" disabled={pending !== null} onClick={() => active ? disruptiveAction("deactivate") : void action("reactivate")}>{active ? "Deactivate" : "Reactivate"}</button>
      <button className="button secondary" type="button" disabled={pending !== null} onClick={() => disruptiveAction("revoke_sessions")}>Sign out everywhere</button>
      {!active || onboardingStatus === "ready" || onboardingStatus === "processing" ? null : (
        <button className="button secondary" type="button" disabled={pending !== null} onClick={() => void action("retry_onboarding")}>{pending === "retry_onboarding" ? "Retrying…" : onboardingStatus === "failed" ? "Retry onboarding" : "Send Entra invitation"}</button>
      )}
    </div>
    <FeedbackMessage feedback={feedback} />
  </div>;
}
