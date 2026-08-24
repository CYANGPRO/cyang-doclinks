"use client";

import { useState } from "react";
import { getProviders, signIn } from "next-auth/react";

export function ProductionSignInButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return <>
    <button
      className="button"
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        setError(null);
        try {
          const providers = await getProviders();
          if (!providers?.[providerId]) {
            setError("Organization sign-in is temporarily unavailable. Please try again after an administrator enables production access.");
            return;
          }
          await signIn(providerId, { callbackUrl: "/" });
        } catch {
          setError("Organization sign-in could not be started. Please try again; if the problem continues, contact the system administrator.");
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? "Redirecting…" : `Continue with ${providerName}`}
    </button>
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </>;
}
