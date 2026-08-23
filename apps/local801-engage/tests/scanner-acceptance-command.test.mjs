import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live scanner acceptance is guarded, synthetic, fail-closed, and secret-safe", async () => {
  const source = await readFile(new URL("../scripts/accept-malware-scanner.mjs", import.meta.url), "utf8");
  for (const required of [
    "LOCAL801_SCANNER_ACCEPTANCE",
    "LOCAL801_SCANNER_ACCEPTANCE_TARGET",
    "LOCAL801_SCANNER_ACCEPTANCE_CONFIRM",
    "LOCAL801_PRODUCTION_LAUNCH_ENABLED",
    "synthetic-clean.txt",
    "synthetic-eicar.txt",
    "authentication_failed",
    "ECONNREFUSED",
    "SCANNER_UNAVAILABLE",
  ]) assert.match(source, new RegExp(required));
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\([^)]*(?:SECRET|secret|hmacSecret|content)/);
  assert.doesNotMatch(source, /LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX[^\n]*process\.stdout/);
});
