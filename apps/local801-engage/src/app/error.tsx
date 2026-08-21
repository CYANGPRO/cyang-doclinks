"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/DesignSystem";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("Local 801 Engage route failed", error.digest ?? "no-digest");
  }, [error]);

  return (
    <div className="content">
      <ErrorState
        title="This page could not load"
        description="No changes were made. Try the request again or return to the dashboard."
        action={<button className="button secondary" onClick={retry} type="button">Try again</button>}
      />
    </div>
  );
}
