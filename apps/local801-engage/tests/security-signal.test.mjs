import assert from "node:assert/strict";
import test from "node:test";
import { buildSecuritySignal } from "../src/lib/security-signal.ts";

test("security signals accept metadata identifiers but reject PII, bodies, tokens, and raw IP fields", () => {
  assert.deepEqual(buildSecuritySignal("scanner.failure", { organizationId: "22222222-2222-4222-8222-222222222222", safeCode: "SCANNER_UNAVAILABLE" }), {
    event: "scanner.failure", organizationId: "22222222-2222-4222-8222-222222222222", safeCode: "SCANNER_UNAVAILABLE",
  });
  for (const key of ["email", "name", "body", "token", "cookie", "ip", "narrative"]) {
    assert.throws(() => buildSecuritySignal("integrity.failure", { [key]: "unsafe" }), /not allowlisted/);
  }
  assert.throws(() => buildSecuritySignal("authorization.denied", { reason: "contains spaces and possible content" }), /unsafe/);
});
