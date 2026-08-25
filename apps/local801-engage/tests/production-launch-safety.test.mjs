import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProductionLaunchState, productionAuthRuntimeEnabled, productionSyntheticPilotRuntimeEnabled } from "../src/lib/production-launch-policy.ts";
import { durableImportProcessingEnabled } from "../src/lib/import-scanner.ts";

const key = (byte) => Buffer.alloc(32, byte).toString("base64");
const vapidKey = (size, byte) => Buffer.alloc(size, byte).toString("base64url");

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
    LOCAL801_OIDC_CLIENT_ID: "55555555-5555-4555-8555-555555555555",
    LOCAL801_OIDC_CLIENT_SECRET: "oidc-client-secret-value",
    LOCAL801_OIDC_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    LOCAL801_OIDC_BOOTSTRAP_OBJECT_ID: "33333333-3333-4333-8333-333333333333",
    LOCAL801_OIDC_MFA_CLAIM: "amr",
    LOCAL801_OIDC_MFA_VALUE: "mfa",
    LOCAL801_ENTRA_USER_PROVISIONING_ENABLED: "1",
    LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID: "22222222-2222-4222-8222-222222222222",
    LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID: "00000000-0000-0000-0000-000000000000",
    LOCAL801_ACCESS_SUPPORT_EMAIL: "support@example.test",
    LOCAL801_MALWARE_SCANNER_ENABLED: "1",
    LOCAL801_MALWARE_SCANNER_URL: "https://scan.cyang.io",
    LOCAL801_MALWARE_SCANNER_CLIENT_ID: "local801-production",
    LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: "a".repeat(64),
    LOCAL801_SENTRY_ENABLED: "1",
    LOCAL801_SENTRY_DSN: `https://${"d".repeat(32)}@o123.ingest.sentry.io/456`,
    LOCAL801_PUSH_ENABLED: "1",
    LOCAL801_VAPID_PUBLIC_KEY: vapidKey(65, 4),
    LOCAL801_VAPID_PRIVATE_KEY: vapidKey(32, 5),
    LOCAL801_VAPID_SUBJECT: "mailto:owner@example.test",
    LOCAL801_NATIVE_MOBILE_ENABLED: "0",
    LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: "https://attest.cyang.io",
    LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX: "b".repeat(64),
    LOCAL801_MOBILE_PUSH_GATEWAY_URL: "https://push.cyang.io",
    LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX: "c".repeat(64),
    LOCAL801_APPLE_TEAM_ID: "A1B2C3D4E5",
    LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER: "123456789012",
    LOCAL801_DATABASE_URL: "postgresql://local801:secret@production.example.test/local801?sslmode=require",
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
    LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED: "1",
    LOCAL801_SECURITY_REVIEW_APPROVED: "1",
    LOCAL801_PRODUCTION_SECURITY_REVIEW_ID: "SEC-2026-0001",
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "0",
    LOCAL801_DURABLE_IMPORTS_ENABLED: "0",
    LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED: "1",
    LOCAL801_ALLOW_SYNTHETIC_SEED: "0",
    LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED: "0",
    LOCAL801_SYNTHETIC_DATA_ONLY: "0",
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
    "ENTRA_PROVISIONING_CONFIG_INVALID",
    "SCANNER_DISABLED",
    "SENTRY_CONFIG_INVALID",
    "PUSH_CONFIG_INVALID",
    "DATABASE_CONFIG_INVALID",
    "DATABASE_TLS_NOT_REQUIRED",
    "STORAGE_CONFIG_INVALID",
    "ENCRYPTION_CONFIG_INVALID",
    "PII_KEY_CONFIG_INVALID",
    "PII_PROTECTION_NOT_VERIFIED",
    "BACKUP_RESTORE_NOT_VERIFIED",
    "DISTRIBUTED_RATE_LIMITS_DISABLED",
    "SECURITY_REVIEW_NOT_APPROVED",
    "SECURITY_REVIEW_ID_MISSING",
    "PROTECTED_DURABLE_IMPORTS_DISABLED",
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

test("every Production launch dependency is explicit for the Vercel function runtime", async () => {
  const source = await readFile(new URL("../src/lib/production-launch-policy.ts", import.meta.url), "utf8");
  const dependencies = new Set([
    ...Array.from(source.matchAll(/env\.([A-Z][A-Z0-9_]*)/g), (match) => match[1]),
    "LOCAL801_SENTRY_DSN",
    "LOCAL801_SENTRY_ENABLED",
  ]);
  for (const name of dependencies) {
    assert.match(source, new RegExp(`process\\.env\\.${name}\\b`), name);
  }
  assert.match(source, /env === process\.env \? productionLaunchRuntimeEnv\(\) : env/);
  assert.equal((source.match(/env = resolveProductionLaunchEnv\(env\)/g) ?? []).length, 3);
});

test("web/PWA launch does not require native store or gateway infrastructure", () => {
  const state = getProductionLaunchState(readyEnv({
    LOCAL801_NATIVE_MOBILE_ENABLED: "0",
    LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: undefined,
    LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX: undefined,
    LOCAL801_MOBILE_PUSH_GATEWAY_URL: undefined,
    LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX: undefined,
    LOCAL801_APPLE_TEAM_ID: undefined,
    LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER: undefined,
  }));
  assert.equal(state.ready, true);
  assert.equal(state.blockers.includes("MOBILE_CONFIG_INVALID"), false);
});

test("durable imports open in production only behind protected state and the complete launch gate", () => {
  assert.equal(durableImportProcessingEnabled(readyEnv()), true);
  assert.equal(durableImportProcessingEnabled(readyEnv({ LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0" })), false);
  assert.equal(durableImportProcessingEnabled(readyEnv({ LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0" })), false);
  assert.equal(durableImportProcessingEnabled(readyEnv({ LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED: "0" })), false);
});

test("synthetic Production-origin pilot permits auth without authorizing launch or durable imports", () => {
  const pilot = readyEnv({
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED: "1",
    LOCAL801_SYNTHETIC_DATA_ONLY: "1",
  });
  assert.equal(getProductionLaunchState(pilot).ready, false);
  assert.equal(productionSyntheticPilotRuntimeEnabled(pilot), true);
  assert.equal(productionAuthRuntimeEnabled(pilot), true);
  assert.equal(durableImportProcessingEnabled(pilot), false);
  assert.equal(productionSyntheticPilotRuntimeEnabled({ ...pilot, LOCAL801_BACKUP_RESTORE_VERIFIED: "0" }), false);
  assert.equal(productionSyntheticPilotRuntimeEnabled({ ...pilot, LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1" }), false);
});

test("production launch blocks unsafe auth, scanner, PII, preview-only, and synthetic switches", () => {
  const cases = [
    [{ LOCAL801_PREVIEW_AUTH_ENABLED: "1" }, "PREVIEW_AUTH_ENABLED"],
    [{ SIGNUP_ENABLED: "1" }, "SIGNUP_ENABLED"],
    [{ MFA_ENFORCE_ALL: "0" }, "MFA_NOT_ENFORCED"],
    [{ LOCAL801_ENTRA_USER_PROVISIONING_ENABLED: "0" }, "ENTRA_PROVISIONING_CONFIG_INVALID"],
    [{ LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID: "not-an-object-id" }, "ENTRA_PROVISIONING_CONFIG_INVALID"],
    [{ LOCAL801_ORGANIZATION_SLUG: "local801-preview" }, "PRODUCTION_ORGANIZATION_INVALID"],
    [{ LOCAL801_MALWARE_SCANNER_ENABLED: "0" }, "SCANNER_DISABLED"],
    [{ LOCAL801_MALWARE_SCANNER_URL: "https://scanner.example.test" }, "SCANNER_CONFIG_INVALID"],
    [{ LOCAL801_SENTRY_ENABLED: "0" }, "SENTRY_CONFIG_INVALID"],
    [{ LOCAL801_SENTRY_DSN: "https://attacker.example.test/123" }, "SENTRY_CONFIG_INVALID"],
    [{ LOCAL801_PUSH_ENABLED: "0" }, "PUSH_CONFIG_INVALID"],
    [{ LOCAL801_VAPID_PUBLIC_KEY: "disabled-until-generated" }, "PUSH_CONFIG_INVALID"],
    [{ LOCAL801_NATIVE_MOBILE_ENABLED: "1", LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: undefined }, "MOBILE_CONFIG_INVALID"],
    [{ LOCAL801_NATIVE_MOBILE_ENABLED: "1", LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: "https://attacker.example.test" }, "MOBILE_CONFIG_INVALID"],
    [{ LOCAL801_PII_ENCRYPTION_MASTER_KEYS: undefined }, "PII_KEY_CONFIG_INVALID"],
    [{ LOCAL801_PII_BLIND_INDEX_KEYS: `{"v1":"${key(2)}"}` }, "PII_KEY_CONFIG_INVALID"],
    [{ LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: "1" }, "PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"],
    [{ LOCAL801_DURABLE_IMPORTS_ENABLED: "1" }, "PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED"],
    [{ LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED: "0" }, "PROTECTED_DURABLE_IMPORTS_DISABLED"],
    [{ LOCAL801_IMPORT_RATE_LIMIT_PER_HOUR: "0" }, "RATE_LIMIT_CONFIG_INVALID"],
    [{ LOCAL801_ALLOW_SYNTHETIC_SEED: "1" }, "SYNTHETIC_SEED_ENABLED"],
    [{ LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED: "1" }, "SYNTHETIC_PRODUCTION_PILOT_ENABLED"],
    [{ LOCAL801_SYNTHETIC_DATA_ONLY: "1" }, "SYNTHETIC_DATA_ONLY_ENABLED"],
    [{ LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "0" }, "PII_PROTECTION_NOT_VERIFIED"],
    [{ LOCAL801_BACKUP_RESTORE_VERIFIED: "0" }, "BACKUP_RESTORE_NOT_VERIFIED"],
    [{ LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED: "0" }, "DISTRIBUTED_RATE_LIMITS_DISABLED"],
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
    [{ LOCAL801_OIDC_BOOTSTRAP_OBJECT_ID: "not-an-object-id" }, "OIDC_CONFIG_INVALID"],
    [{ DATABASE_URL: "postgresql://local801:other@production.example.test/local801" }, "DATABASE_CONFIG_INVALID"],
    [{ LOCAL801_DATABASE_URL: "postgresql://local801:secret@production.example.test/local801" }, "DATABASE_TLS_NOT_REQUIRED"],
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
  assert.match(settings, /Secret configuration values are never shown here/);
  assert.match(settings, /It never displays credentials, encryption keys, connection strings, Microsoft identifiers, or scanner secrets/);
  for (const variable of [
    "LOCAL801_PRODUCTION_LAUNCH_ENABLED=0",
    "LOCAL801_DATABASE_PII_PROTECTION_ENABLED=0",
    "LOCAL801_BACKUP_RESTORE_VERIFIED=0",
    "LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED=0",
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
