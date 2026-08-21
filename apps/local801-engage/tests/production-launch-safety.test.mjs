import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProductionLaunchState, productionAuthRuntimeEnabled } from "../src/lib/production-launch-policy.ts";

const key = (byte) => Buffer.alloc(32, byte).toString("base64");

function readyEnv(overrides = {}) {
  return {
    VERCEL_ENV: "production",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1",
    LOCAL801_PRODUCTION_AUTH_ENABLED: "1",
    LOCAL801_PREVIEW_AUTH_ENABLED: "0",
    SIGNUP_ENABLED: "0",
    MFA_ENFORCE_ALL: "1",
    LOCAL801_ORGANIZATION_SLUG: "local801",
    LOCAL801_APP_URL: "https://cat.cyang.io",
    NEXTAUTH_URL: "https://cat.cyang.io",
    NEXTAUTH_SECRET: "n".repeat(64),
    LOCAL801_OIDC_PROVIDER_ID: "local801-oidc",
    LOCAL801_OIDC_WELL_KNOWN: "https://identity.example.test/.well-known/openid-configuration",
    LOCAL801_OIDC_CLIENT_ID: "local801-production",
    LOCAL801_OIDC_CLIENT_SECRET: "oidc-client-secret-value",
    LOCAL801_OIDC_MFA_CLAIM: "amr",
    LOCAL801_OIDC_MFA_VALUE: "mfa",
    LOCAL801_MALWARE_SCANNER_ENABLED: "1",
    LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io",
    LOCAL801_MALWARE_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: "a".repeat(64),
    LOCAL801_DATABASE_URL: "postgresql://local801:secret@production.example.test/local801",
    LOCAL801_R2_ACCOUNT_ID: "abc123",
    LOCAL801_R2_ENDPOINT: "https://abc123.r2.cloudflarestorage.com",
    LOCAL801_R2_BUCKET: "local801-production-private",
    LOCAL801_R2_ACCESS_KEY_ID: "r2-access-key",
    LOCAL801_R2_SECRET_ACCESS_KEY: "r2-secret-key",
    LOCAL801_ENCRYPTION_MASTER_KEYS: `{"v1":"${key(1)}"}`,
    LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: `{"v1":"${key(2)}"}`,
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: `{"v1":"${key(3)}"}`,
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
    LOCAL801_BACKUP_RESTORE_VERIFIED: "1",
    LOCAL801_SECURITY_REVIEW_APPROVED: "1",
    LOCAL801_PRODUCTION_SECURITY_REVIEW_ID: "SEC-2026-0001",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0",
    LOCAL801_DURABLE_IMPORTS_ENABLED: "0",
    LOCAL801_ALLOW_SYNTHETIC_SEED: "0",
    ...overrides,
  };
}

test("production launch is fail-closed by default", () => {
  const state = getProductionLaunchState({ VERCEL_ENV: "production" });
  assert.equal(state.ready, false);
  assert.equal(state.launchRequested, false);
  for (const code of [
    "LAUNCH_NOT_APPROVED",
    "PRODUCTION_AUTH_DISABLED",
    "PRODUCTION_ORGANIZATION_INVALID",
    "APP_URL_INVALID",
    "NEXTAUTH_URL_INVALID",
    "NEXTAUTH_SECRET_WEAK",
    "OIDC_CONFIG_INVALID",
    "SCANNER_DISABLED",
    "DATABASE_CONFIG_INVALID",
    "STORAGE_CONFIG_INVALID",
    "ENCRYPTION_CONFIG_INVALID",
    "PII_KEY_CONFIG_INVALID",
    "PII_PROTECTION_NOT_VERIFIED",
    "BACKUP_RESTORE_NOT_VERIFIED",
    "SECURITY_REVIEW_NOT_APPROVED",
    "SECURITY_REVIEW_ID_MISSING",
  ]) assert.equal(state.blockers.includes(code), true, code);
});

test("a complete production configuration can satisfy the coded launch gate", () => {
  const state = getProductionLaunchState(readyEnv());
  assert.deepEqual(state, {
    environment: "production",
    launchRequested: true,
    ready: true,
    blockers: [],
  });
});

test("production launch blocks unsafe auth, scanner, PII, preview-only, and synthetic switches", () => {
  const cases = [
    [{ LOCAL801_PREVIEW_AUTH_ENABLED: "1" }, "PREVIEW_AUTH_ENABLED"],
    [{ SIGNUP_ENABLED: "1" }, "SIGNUP_ENABLED"],
    [{ MFA_ENFORCE_ALL: "0" }, "MFA_NOT_ENFORCED"],
    [{ LOCAL801_ORGANIZATION_SLUG: "local801-preview" }, "PRODUCTION_ORGANIZATION_INVALID"],
    [{ LOCAL801_MALWARE_SCANNER_ENABLED: "0" }, "SCANNER_DISABLED"],
    [{ LOCAL801_MALWARE_SCANNER_URL: "https://scanner.example.test" }, "SCANNER_CONFIG_INVALID"],
    [{ LOCAL801_PII_ENCRYPTION_MASTER_KEYS: undefined }, "PII_KEY_CONFIG_INVALID"],
    [{ LOCAL801_PII_BLIND_INDEX_KEYS: `{"v1":"${key(2)}"}` }, "PII_KEY_CONFIG_INVALID"],
    [{ LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1" }, "PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"],
    [{ LOCAL801_DURABLE_IMPORTS_ENABLED: "1" }, "PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED"],
    [{ LOCAL801_ALLOW_SYNTHETIC_SEED: "1" }, "SYNTHETIC_SEED_ENABLED"],
    [{ LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0" }, "PII_PROTECTION_NOT_VERIFIED"],
    [{ LOCAL801_BACKUP_RESTORE_VERIFIED: "0" }, "BACKUP_RESTORE_NOT_VERIFIED"],
    [{ LOCAL801_SECURITY_REVIEW_APPROVED: "0" }, "SECURITY_REVIEW_NOT_APPROVED"],
  ];
  for (const [override, expected] of cases) {
    const state = getProductionLaunchState(readyEnv(override));
    assert.equal(state.ready, false, expected);
    assert.equal(state.blockers.includes(expected), true, expected);
  }
});

test("production URLs, database, storage, and secrets must be canonical and isolated", () => {
  const cases = [
    [{ LOCAL801_APP_URL: "http://cat.cyang.io" }, "APP_URL_INVALID"],
    [{ NEXTAUTH_URL: "https://other.cyang.io" }, "NEXTAUTH_URL_INVALID"],
    [{ NEXTAUTH_SECRET: "changeme" }, "NEXTAUTH_SECRET_WEAK"],
    [{ LOCAL801_OIDC_WELL_KNOWN: "http://identity.example.test/.well-known/openid-configuration" }, "OIDC_CONFIG_INVALID"],
    [{ DATABASE_URL: "postgresql://local801:other@production.example.test/local801" }, "DATABASE_CONFIG_INVALID"],
    [{ LOCAL801_R2_ENDPOINT: "https://pub-example.r2.dev" }, "STORAGE_CONFIG_INVALID"],
    [{ R2_BUCKET: "local801-production-private" }, "STORAGE_CONFIG_INVALID"],
  ];
  for (const [override, expected] of cases) {
    const state = getProductionLaunchState(readyEnv(override));
    assert.equal(state.ready, false, expected);
    assert.equal(state.blockers.includes(expected), true, expected);
  }
});

test("production readiness result never contains configuration or secret values", () => {
  const env = readyEnv({
    NEXTAUTH_SECRET: "super-secret-nextauth-material-1234567890",
    LOCAL801_OIDC_CLIENT_SECRET: "provider-private-secret",
    LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: "b".repeat(64),
    LOCAL801_R2_SECRET_ACCESS_KEY: "storage-private-secret",
  });
  const serialized = JSON.stringify(getProductionLaunchState(env));
  for (const forbidden of [
    env.NEXTAUTH_SECRET,
    env.LOCAL801_OIDC_CLIENT_SECRET,
    env.LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX,
    env.LOCAL801_R2_SECRET_ACCESS_KEY,
    env.LOCAL801_DATABASE_URL,
    env.LOCAL801_OIDC_WELL_KNOWN,
    env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS,
    env.LOCAL801_PII_BLIND_INDEX_KEYS,
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("OIDC development remains testable outside production but Vercel Production requires the launch gate", () => {
  assert.equal(productionAuthRuntimeEnabled({ LOCAL801_PRODUCTION_AUTH_ENABLED: "1", VERCEL_ENV: "preview" }), true);
  assert.equal(productionAuthRuntimeEnabled({ LOCAL801_PRODUCTION_AUTH_ENABLED: "0", VERCEL_ENV: "preview" }), false);
  assert.equal(productionAuthRuntimeEnabled(readyEnv()), true);
  assert.equal(productionAuthRuntimeEnabled(readyEnv({ LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0" })), false);
  assert.equal(productionAuthRuntimeEnabled(readyEnv({ LOCAL801_PII_BLIND_INDEX_KEYS: undefined })), false);
});

test("Stage 14A/14B1 are integrated into auth, settings, environment defaults, and hardened response headers", async () => {
  const [authz, authOptions, settings, envExample, nextConfig, serviceWorker] = await Promise.all([
    readFile(new URL("../src/lib/authz.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/auth-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/settings/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(authz, /productionAuthRuntimeEnabled\(\)/);
  assert.doesNotMatch(authz, /process\.env\.LOCAL801_PRODUCTION_AUTH_ENABLED === "1"/);
  assert.match(authOptions, /productionAuthRuntimeEnabled\(\)/);
  assert.match(settings, /getProductionLaunchState\(\)/);
  assert.match(settings, /PII_KEY_CONFIG_INVALID/);
  assert.match(settings, /never displays credentials, key material, connection strings/i);
  for (const variable of [
    "LOCAL801_PRODUCTION_LAUNCH_ENABLED=0",
    "LOCAL801_DATABASE_PII_PROTECTION_ENABLED=0",
    "LOCAL801_BACKUP_RESTORE_VERIFIED=0",
    "LOCAL801_SECURITY_REVIEW_APPROVED=0",
    "LOCAL801_PII_ENCRYPTION_MASTER_KEYS=",
    "LOCAL801_PII_BLIND_INDEX_KEYS=",
  ]) assert.match(envExample, new RegExp(variable));
  assert.match(nextConfig, /Strict-Transport-Security/);
  assert.match(nextConfig, /Cross-Origin-Opener-Policy/);
  assert.match(nextConfig, /Cross-Origin-Resource-Policy/);
  assert.match(nextConfig, /X-Permitted-Cross-Domain-Policies/);
  assert.match(serviceWorker, /isStaticAsset/);
  assert.doesNotMatch(serviceWorker, /cache\.put\(request/);
});
