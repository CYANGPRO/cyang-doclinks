import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listStorageObjectKeys, setR2ClientFactoryForTests } from "../src/lib/r2.ts";

test("private storage listing is bounded, paginated, and restricted to safe Local 801 keys", async () => {
  const previous = Object.fromEntries([
    "LOCAL801_R2_ACCOUNT_ID", "LOCAL801_R2_ENDPOINT", "LOCAL801_R2_BUCKET",
    "LOCAL801_R2_ACCESS_KEY_ID", "LOCAL801_R2_SECRET_ACCESS_KEY",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    LOCAL801_R2_ACCOUNT_ID: "account",
    LOCAL801_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    LOCAL801_R2_BUCKET: "local801-private",
    LOCAL801_R2_ACCESS_KEY_ID: "synthetic",
    LOCAL801_R2_SECRET_ACCESS_KEY: "synthetic",
  });
  const commands = [];
  setR2ClientFactoryForTests(() => ({
    async send(command) {
      commands.push(command.input);
      return commands.length === 1
        ? { Contents: [{ Key: "local801/documents/2026/08/10000000-0000-4000-8000-000000000001" }], IsTruncated: true, NextContinuationToken: "next" }
        : { Contents: [{ Key: "local801/imports/2026/08/20000000-0000-4000-8000-000000000001" }], IsTruncated: false };
    },
  }));
  try {
    const keys = await listStorageObjectKeys({ maximumObjects: 10 });
    assert.equal(keys.length, 2);
    assert.equal(commands[0].Prefix, "local801/");
    assert.equal(commands[1].ContinuationToken, "next");
  } finally {
    setR2ClientFactoryForTests(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("storage reconciliation is explicit, read-only, count-only, and has no deletion path", async () => {
  const source = await readFile(new URL("../scripts/reconcile-storage.mjs", import.meta.url), "utf8");
  assert.match(source, /LOCAL801_STORAGE_RECONCILIATION_CONFIRM !== "READ_ONLY"/);
  assert.match(source, /missingObjects: missingObjects\.length/);
  assert.match(source, /orphanObjects: orphanObjects\.length/);
  assert.match(source, /cleanupPending/);
  assert.doesNotMatch(source, /deleteObject|DELETE FROM|Remove-Item|rm -rf/i);
});

test("release CI matches the pinned Node 22 runtime and includes scale, secret, dependency, migration, and build gates", async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version: "22\.16\.0"/);
  for (const gate of [
    "test:xlsx-scale",
    "security:secret-scan",
    "security:route-audit",
    "db:migrations:verify",
    "npm audit --omit=dev",
    "npm run build",
  ]) {
    assert.equal(workflow.includes(gate), true, gate);
  }
  assert.equal(JSON.parse(packageJson).engines.node, ">=22.16.0 <23");
});

test("Production builds emit a secret-safe in-environment preflight without weakening the deployment lock", async () => {
  const [script, packageJson] = await Promise.all([
    readFile(new URL("../scripts/check-production-readiness.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;
  assert.match(scripts.build, /security:production-preflight:build-report/);
  assert.match(scripts["security:production-preflight:build-report"], /--preflight --report-only --vercel-production-only/);
  assert.match(script, /vercelProductionOnly && process\.env\.VERCEL_ENV !== "production"/);
  assert.match(script, /reportOnly && !vercelProductionOnly/);
  assert.match(script, /mode: vercelProductionOnly \? "vercel-production-build-preflight"/);
  assert.match(script, /process\.exitCode = reportOnly \|\| safeOutput\.ready \? 0 : 2/);
  assert.match(script, /blocker === "SECURITY_REVIEW_NOT_APPROVED" \|\| blocker === "SECURITY_REVIEW_ID_MISSING"/);
  assert.match(script, /if \(infrastructureCheckEligible\)/);
  assert.doesNotMatch(script, /console\.(?:log|error)\([^\n]*(?:DATABASE_URL|SECRET|MASTER_KEYS|ACCESS_KEY)/);
});
