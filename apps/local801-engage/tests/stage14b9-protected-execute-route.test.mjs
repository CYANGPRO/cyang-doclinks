import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../src/app/api/imports/[batchId]/execute/route.ts", import.meta.url);
const controlUrl = new URL("../src/components/ImportExecutionControl.tsx", import.meta.url);

test("execute route chooses protected staging/apply only when all protected execution gates are explicit", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/);
  assert.match(source, /LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"/);
  assert.match(source, /LOCAL801_PII_BACKFILL_ENABLED !== "1"/);
  assert.match(source, /LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"/);
  assert.match(source, /LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"/);
  assert.match(source, /LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1"/);
  assert.match(source, /if \(protectedExecutionEnabled\(\)\) \{/);
});

test("protected route validates the confirmed preflight before preparing and atomically applying", async () => {
  const source = await readFile(routeUrl, "utf8");
  const protectedStart = source.indexOf("if (protectedExecutionEnabled())");
  const legacyStart = source.indexOf("const result = await executeAuthoritativeImport", protectedStart);
  const protectedBlock = source.slice(protectedStart, legacyStart);
  const preflight = protectedBlock.indexOf("getImportExecutionPreflight");
  const compare = protectedBlock.indexOf("preflight.fingerprint !== fingerprint");
  const prepare = protectedBlock.indexOf("prepareProtectedImportExecution");
  const apply = protectedBlock.indexOf("applyPreparedProtectedImport");
  assert.ok(preflight >= 0 && compare > preflight && prepare > compare && apply > prepare);
  assert.match(protectedBlock, /prepared\.executionSetId/);
  assert.match(protectedBlock, /prepared\.mutationFingerprint/);
  assert.match(protectedBlock, /protectedImportMembershipTransaction/);
  assert.doesNotMatch(protectedBlock, /executeAuthoritativeImport/);
});

test("protected execute response keeps execution-set IDs and mutation fingerprints server-only", async () => {
  const source = await readFile(routeUrl, "utf8");
  const protectedStart = source.indexOf("if (protectedExecutionEnabled())");
  const legacyStart = source.indexOf("const result = await executeAuthoritativeImport", protectedStart);
  const protectedBlock = source.slice(protectedStart, legacyStart);
  const responseStart = protectedBlock.indexOf("return json({", protectedBlock.indexOf("applyPreparedProtectedImport"));
  const responseBlock = protectedBlock.slice(responseStart);
  assert.match(responseBlock, /protectionMode: "protected"/);
  assert.match(responseBlock, /executed: result\.executed/);
  assert.match(responseBlock, /importKind: result\.importKind/);
  assert.match(responseBlock, /counts: result\.counts/);
  assert.doesNotMatch(responseBlock, /\.\.\.result/);
  assert.doesNotMatch(responseBlock, /executionSetId/);
  assert.doesNotMatch(responseBlock, /mutationFingerprint/);
});

test("legacy synthetic Preview executor remains a separate post-protected branch", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.match(source, /protectedExecutionEnabled\(env\) \|\| authoritativeExecutionEnabled\(env\)/);
  assert.match(source, /protectionMode: "protected"/);
  assert.match(source, /protectionMode: "synthetic_preview"/);
  assert.ok(source.indexOf("applyPreparedProtectedImport") < source.lastIndexOf("executeAuthoritativeImport(actor"));
});

test("execution control confirms only the public preflight fingerprint and never exposes mutation fingerprints", async () => {
  const source = await readFile(controlUrl, "utf8");
  assert.match(source, /body: JSON\.stringify\(\{ fingerprint \}\)/);
  assert.doesNotMatch(source, /mutationFingerprint/);
  assert.match(source, /mode\?: "synthetic_preview" \| "protected"/);
  assert.match(source, /Execute protected import/);
});
