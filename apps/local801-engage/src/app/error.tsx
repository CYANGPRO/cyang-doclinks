"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DisclosureCard, ErrorState } from "@/components/DesignSystem";
import { UserFacingErrorDialog } from "@/components/UserFacingErrorDialog";
import { unexpectedClientProblem } from "@/lib/user-facing-errors";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [showDialog, setShowDialog] = useState(true);
  useEffect(() => {
    console.error("Engaging Local 801 route failed", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="content">
      <UserFacingErrorDialog
        problem={showDialog ? unexpectedClientProblem : null}
        onClose={() => setShowDialog(false)}
        onRetry={() => { setShowDialog(false); reset(); }}
      />
      <ErrorState
        title="We couldn’t load this page"
        description="CAT stopped before it could confirm what happened. Try the page again, then check the current record before repeating an action."
        action={<div className="page-actions">
          <button className="button" onClick={reset} type="button">Try again</button>
          <Link className="button secondary" href="/">Go home</Link>
        </div>}
      />
      {error.digest ? <DisclosureCard title="Support reference" description="Include this non-sensitive code if you contact support">
        <p><code>{error.digest}</code></p>
        <p className="muted">Do not include member data, passwords, MFA codes, recovery codes, or keys in a support message.</p>
      </DisclosureCard> : null}
    </div>
  );
}
