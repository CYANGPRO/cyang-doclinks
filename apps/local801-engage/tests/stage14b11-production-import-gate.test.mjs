import assert from "node:assert/strict";
import test from "node:test";
import { getProductionLaunchState, __testing } from "../src/lib/production-launch-policy.ts";

const protectedImport = {
  LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
  LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
  LOCAL801_PII_BACKFILL_ENABLED: "0",
  LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED: "1",
  LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED: "1",
};

test("protected authoritative import configuration requires every protected-only gate", () => {
  assert.equal(__testing.protectedAuthoritativeImportExecutionConfigured(protectedImport), true);
  for (const key of [
    "LOCAL801_DATABASE_PII_PROTECTION_ENABLED",
    "LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED",
    "LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED",
  ]) {
    assert.equal(__testing.protectedAuthoritativeImportExecutionConfigured({ ...protectedImport, [key]: "0" }), false, key);
  }
  assert.equal(__testing.protectedAuthoritativeImportExecutionConfigured({ ...protectedImport, LOCAL801_PII_DUAL_WRITE_ENABLED: "1" }), false);
  assert.equal(__testing.protectedAuthoritativeImportExecutionConfigured({ ...protectedImport, LOCAL801_PII_BACKFILL_ENABLED: "1" }), false);
});

test("production launch blocks a partially configured authoritative master switch", () => {
  const state = getProductionLaunchState({
    VERCEL_ENV: "production",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED: "1",
    LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED: "0",
  });
  assert.equal(state.blockers.includes("PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"), true);
});

test("production launch does not classify a fully protected authoritative executor as the Preview-only blocker", () => {
  const state = getProductionLaunchState({
    VERCEL_ENV: "production",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1",
    ...protectedImport,
  });
  assert.equal(state.blockers.includes("PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"), false);
  assert.equal(state.ready, false, "other independent launch gates are intentionally absent in this focused test");
});
