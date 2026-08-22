import assert from "node:assert/strict";
import test from "node:test";
import { local801SentryOptions, sanitizeLocal801SentryEvent } from "../src/lib/sentry-privacy.ts";

test("Sentry events retain diagnostics but remove request, user, context, breadcrumb, and local-variable data", () => {
  const sanitized = sanitizeLocal801SentryEvent({
    event_id: "a".repeat(32),
    message: "member@example.test",
    request: { url: "https://cat.example.test/member/private" },
    user: { email: "member@example.test", ip_address: "127.0.0.1" },
    contexts: { member: { name: "Synthetic Member" } },
    breadcrumbs: [{ message: "Synthetic Member" }],
    extra: { member: "Synthetic Member" },
    exception: { values: [{
      type: "MemberLookupError",
      value: "member@example.test",
      stacktrace: { frames: [{ filename: "src/example.ts", function: "lookup", lineno: 9, vars: { email: "member@example.test" } }] },
    }] },
  });

  assert.equal(sanitized.message, "[redacted]");
  assert.equal(sanitized.request, undefined);
  assert.equal(sanitized.user, undefined);
  assert.equal(sanitized.contexts, undefined);
  assert.equal(sanitized.breadcrumbs, undefined);
  assert.equal(sanitized.extra, undefined);
  assert.equal(sanitized.exception.values[0].type, "Local801ApplicationError");
  assert.equal(sanitized.exception.values[0].value, "Redacted application error");
  assert.equal(sanitized.exception.values[0].stacktrace.frames[0].vars, undefined);
  assert.deepEqual(sanitized.tags, { application: "local801-cat" });
});

test("Sentry is fail-closed unless both the CAT enable flag and DSN are present", () => {
  const previous = { enabled: process.env.LOCAL801_SENTRY_ENABLED, dsn: process.env.LOCAL801_SENTRY_DSN };
  try {
    process.env.LOCAL801_SENTRY_ENABLED = "0";
    process.env.LOCAL801_SENTRY_DSN = "https://public@example.test/1";
    assert.equal(local801SentryOptions().enabled, false);
    process.env.LOCAL801_SENTRY_ENABLED = "1";
    assert.equal(local801SentryOptions().enabled, true);
    delete process.env.LOCAL801_SENTRY_DSN;
    assert.equal(local801SentryOptions().enabled, false);
  } finally {
    if (previous.enabled === undefined) delete process.env.LOCAL801_SENTRY_ENABLED;
    else process.env.LOCAL801_SENTRY_ENABLED = previous.enabled;
    if (previous.dsn === undefined) delete process.env.LOCAL801_SENTRY_DSN;
    else process.env.LOCAL801_SENTRY_DSN = previous.dsn;
  }
});
