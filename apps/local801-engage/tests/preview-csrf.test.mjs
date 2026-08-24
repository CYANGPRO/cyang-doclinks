import assert from "node:assert/strict";
import test from "node:test";
import { issuePreviewCsrfToken, verifyPreviewCsrfToken, __testing } from "../src/lib/preview-csrf.ts";

const env = { NODE_ENV: "production", NEXTAUTH_SECRET: "stage20-synthetic-secret-with-at-least-32-characters" };

test("Preview CSRF tokens bind the validated return path and expire", () => {
  const now = 1_800_000_000;
  const token = issuePreviewCsrfToken("/imports?limit=50", now, env);
  assert.equal(verifyPreviewCsrfToken(token, "/imports?limit=50", now, env), true);
  assert.equal(verifyPreviewCsrfToken(token, "/imports?limit=20", now, env), false);
  assert.equal(verifyPreviewCsrfToken(token, "/imports?limit=50", now + __testing.TOKEN_LIFETIME_SECONDS + 1, env), false);
});

test("Preview CSRF tokens reject tampering, malformed values, and the wrong secret", () => {
  const token = issuePreviewCsrfToken("/", 1_800_000_000, env);
  assert.equal(verifyPreviewCsrfToken(`${token}x`, "/", 1_800_000_000, env), false);
  assert.equal(verifyPreviewCsrfToken(token, "/", 1_800_000_000, { ...env, NEXTAUTH_SECRET: `${env.NEXTAUTH_SECRET}-other` }), false);
  assert.equal(verifyPreviewCsrfToken("not-a-token", "/", 1_800_000_000, env), false);
  assert.equal(verifyPreviewCsrfToken("x".repeat(1_025), "/", 1_800_000_000, env), false);
});
