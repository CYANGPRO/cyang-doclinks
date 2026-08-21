"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export function ProductionSignInButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [pending, setPending] = useState(false);
  return <button
    className="button"
    type="button"
    disabled={pending}
    onClick={async () => {
      setPending(true);
      await signIn(providerId, { callbackUrl: "/" });
      setPending(false);
    }}
  >
    {pending ? "Redirecting…" : `Continue with ${providerName}`}
  </button>;
}
