"use client";

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Engaging Local 801 application shell failed", error.digest ?? "no-digest");
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="global-error-page">
          <section className="global-error-card" role="alert">
            <p className="problem-dialog-kicker">Engaging Local 801</p>
            <h1>CAT couldn’t start</h1>
            <p>The problem happened before your page could load, so no protected information is shown here.</p>
            <h2>What to do</h2>
            <ol className="step-list">
              <li>Check your connection and try loading CAT again.</li>
              <li>If the problem continues, close this tab and return to <strong>cat.cyang.io</strong>.</li>
              <li>If you contact support, share only the reference below. Never send a password, MFA code, or encryption key.</li>
            </ol>
            {error.digest ? <p><strong>Support reference:</strong> <code>{error.digest}</code></p> : <p><strong>Support reference:</strong> <code>APPLICATION_START_FAILED</code></p>}
            <button className="button" onClick={reset} type="button">Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
