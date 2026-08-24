"use client";

import { useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { UserFacingErrorDialog } from "@/components/UserFacingErrorDialog";
import { signInStartProblem, type UserFacingProblem } from "@/lib/user-facing-errors";

export function ProductionSignInButton({ providerId, providerName, callbackUrl, forceAccountSelection = false }: { providerId: string; providerName: string; callbackUrl: string; forceAccountSelection?: boolean }) {
  const [pendingAction, setPendingAction] = useState<"sign-in" | "reset" | null>(null);
  const [problem, setProblem] = useState<UserFacingProblem | null>(null);
  const beginSignIn = async () => {
    setPendingAction("sign-in");
    setProblem(null);
    try {
      await signIn(providerId, { callbackUrl }, forceAccountSelection ? { prompt: "select_account" } : undefined);
      setPendingAction(null);
    } catch {
      setProblem(signInStartProblem);
      setPendingAction(null);
    }
  };
  const resetSignIn = async () => {
    setPendingAction("reset");
    setProblem(null);
    try {
      const resetUrl = `/sign-in?reset=1&next=${encodeURIComponent(callbackUrl)}`;
      await signOut({ callbackUrl: resetUrl });
    } catch {
      setProblem(signInStartProblem);
      setPendingAction(null);
    }
  };
  return <>
    <div className="form-actions sign-in-actions">
      <button className="button" type="button" disabled={pendingAction !== null} onClick={() => void beginSignIn()}>
        {pendingAction === "sign-in" ? "Opening secure sign-in…" : `Continue with ${providerName}`}
      </button>
      <button className="button secondary" type="button" disabled={pendingAction !== null} onClick={() => void resetSignIn()}>
        {pendingAction === "reset" ? "Resetting sign-in…" : "Sign out and reset sign-in"}
      </button>
    </div>
    <p className="field-help">Use reset if Microsoft keeps returning the wrong account or a previous attempt. It clears the CAT session and makes Microsoft ask which account to use next.</p>
    <UserFacingErrorDialog problem={problem} onClose={() => setProblem(null)} onRetry={() => void beginSignIn()} />
  </>;
}
