import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSentryRuntimeConfig, scrubSentryEvent, sentryConfigLooksValid, sentryDsnLooksValid } from "../src/lib/sentry-policy.ts";

const validDsn = `https://${"a".repeat(32)}@o123.ingest.sentry.io/456`;

test("Sentry requires an explicitly enabled canonical sentry.io DSN", () => {
  assert.equal(sentryDsnLooksValid(validDsn), true);
  assert.equal(sentryDsnLooksValid("http://a@o123.ingest.sentry.io/456"), false);
  assert.equal(sentryDsnLooksValid(`https://${"a".repeat(32)}@attacker.example.test/456`), false);
  assert.equal(sentryDsnLooksValid(`${validDsn}?member=secret`), false);
  assert.equal(sentryConfigLooksValid({ LOCAL801_SENTRY_ENABLED: "0", LOCAL801_SENTRY_DSN: validDsn }), false);
  assert.equal(sentryConfigLooksValid({ LOCAL801_SENTRY_ENABLED: "1", LOCAL801_SENTRY_DSN: validDsn }), true);
});

test("Sentry runtime remains disabled outside Vercel Production", () => {
  assert.deepEqual(getSentryRuntimeConfig({ VERCEL_ENV: "preview", LOCAL801_SENTRY_ENABLED: "1", LOCAL801_SENTRY_DSN: validDsn }), {
    enabled: false,
    dsn: validDsn,
  });
  assert.deepEqual(getSentryRuntimeConfig({ VERCEL_ENV: "production", LOCAL801_SENTRY_ENABLED: "1", LOCAL801_SENTRY_DSN: validDsn }), {
    enabled: true,
    dsn: validDsn,
  });
});

test("Next.js server instrumentation uses the privacy scrubber without browser tracing", async () => {
  const [instrumentation, serverConfig, example] = await Promise.all([
    readFile(new URL("../src/instrumentation.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/sentry.server.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(instrumentation, /NEXT_RUNTIME === "nodejs"/);
  assert.match(instrumentation, /captureRequestError/);
  assert.match(serverConfig, /sendDefaultPii: false/);
  assert.match(serverConfig, /maxBreadcrumbs: 0/);
  assert.match(serverConfig, /tracesSampleRate: 0/);
  assert.match(serverConfig, /beforeSend: scrubSentryEvent/);
  assert.match(example, /LOCAL801_SENTRY_ENABLED=0/);
  assert.equal(await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8").then((source) => source.includes("Sentry")), false);
});

test("Sentry events discard protected request and diagnostic data", () => {
  const scrubbed = scrubSentryEvent({
    event_id: "safe-event-id",
    release: "safe-release",
    message: "member@example.test failed",
    transaction: "/outreach/private-member-handle",
    request: { url: "https://cat.cyang.io/outreach/private-member-handle", data: "protected" },
    user: { email: "member@example.test" },
    breadcrumbs: [{ message: "protected breadcrumb" }],
    contexts: { protected: { value: "protected context" } },
    extra: { member: "protected extra" },
    tags: { member: "protected tag" },
    exception: { values: [{
      type: "DatabaseError",
      value: "email member@example.test violated a constraint",
      stacktrace: { frames: [{
        filename: "src/lib/member.ts",
        function: "saveMember",
        lineno: 42,
        colno: 7,
        in_app: true,
        vars: { email: "member@example.test" },
        context_line: "throw new Error(member.email)",
      }] },
    }] },
  });

  assert.equal(scrubbed.event_id, "safe-event-id");
  assert.equal(scrubbed.release, "safe-release");
  assert.deepEqual(scrubbed.exception?.values?.[0], {
    type: "DatabaseError",
    value: "Redacted application error",
    stacktrace: { frames: [{ filename: "src/lib/member.ts", function: "saveMember", lineno: 42, colno: 7, in_app: true }] },
  });
  const serialized = JSON.stringify(scrubbed);
  for (const forbidden of ["member@example.test", "private-member-handle", "protected", "context_line", "vars"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
