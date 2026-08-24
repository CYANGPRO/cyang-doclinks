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
            <h1>The workspace could not start</h1>
            <p>No protected information is available on this screen. The application shell encountered a problem before the requested page could load.</p>
            <h2>What to do</h2>
            <ol className="step-list">
              <li>Check your connection and try loading the workspace again.</li>
              <li>If the problem continues, close this tab and return to <strong>cat.cyang.io</strong>.</li>
              <li>Share only the support reference with the System Owner. Never share a password, MFA code, or encryption key.</li>
            </ol>
            {error.digest ? <p><strong>Support reference:</strong> <code>{error.digest}</code></p> : <p><strong>Support reference:</strong> <code>APPLICATION_START_FAILED</code></p>}
            <button className="button" onClick={reset} type="button">Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
