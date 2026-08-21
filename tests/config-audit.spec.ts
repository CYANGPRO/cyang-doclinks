import { expect, test } from "@playwright/test";
import { auditRuntimeConfig } from "../src/lib/configAudit";

const VALID_DOC_MASTER_KEYS = JSON.stringify([
  { id: "k1", key_b64: Buffer.alloc(32, 4).toString("base64"), active: true },
]);

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as unknown as NodeJS.ProcessEnv;
}

test.describe("production config audit", () => {
  test("fails production-like environments when critical settings are missing or insecure", () => {
    const report = auditRuntimeConfig(
      env({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_ENV: "production",
        APP_URL: "https://cyang.io",
        NEXT_PUBLIC_APP_URL: "https://cyang.io",
        NEXTAUTH_URL: "https://cyang.io",
        DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
        R2_ENDPOINT: "http://localhost:9000",
        R2_BUCKET: "bucket",
        R2_ACCESS_KEY_ID: "replace_with_key",
        R2_SECRET_ACCESS_KEY: "replace_with_secret",
        DOC_MASTER_KEYS: VALID_DOC_MASTER_KEYS,
        ENABLE_STRICT_ENV_VALIDATION: "0",
        DEV_ALLOW_INSECURE_FALLBACK: "1",
        APP_SECRET: "replace_with_secret",
        AUTH_SECRET: "replace_with_secret",
        NEXTAUTH_SECRET: "replace_with_secret",
        VIEW_SALT: "replace_with_secret",
        API_KEY_SALT: "replace_with_secret",
        SECURITY_TELEMETRY_HASH_KEY: "replace_with_secret",
        CRON_SECRET: "replace_with_secret",
        SHARE_COOKIE_SECRET: "replace_with_secret",
        ADMIN_COOKIE_SECRET: "replace_with_secret",
        OIDC_SECRETS_KEY: "replace_with_secret",
        OWNER_EMAIL: "owner@example.com",
      })
    );

    expect(report.ok).toBeFalsy();
    expect(report.status).toBe("fail");
    expect(report.findings.some((finding) => finding.field === "DATABASE_URL")).toBeTruthy();
    expect(report.findings.some((finding) => finding.code === "STRICT_VALIDATION_DISABLED")).toBeTruthy();
  });

  test("passes a coherent staging/production-style configuration", () => {
    const report = auditRuntimeConfig(
      env({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_ENV: "production",
        APP_URL: "https://www.cyang.io",
        NEXT_PUBLIC_APP_URL: "https://www.cyang.io",
        NEXTAUTH_URL: "https://www.cyang.io",
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=require",
        R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        R2_BUCKET: "cyang-prod",
        R2_ALLOWED_BUCKETS: "cyang-prod,cyang-backups",
        R2_ACCESS_KEY_ID: "prod_access_key_1234567890abcdef",
        R2_SECRET_ACCESS_KEY: "prod_secret_key_1234567890abcdef",
        DOC_MASTER_KEYS: VALID_DOC_MASTER_KEYS,
        ENABLE_STRICT_ENV_VALIDATION: "1",
        APP_SECRET: "prod_app_secret_1234567890abcdef",
        AUTH_SECRET: "prod_auth_secret_1234567890abcdef",
        NEXTAUTH_SECRET: "prod_nextauth_secret_1234567890abcdef",
        VIEW_SALT: "prod_view_salt_1234567890abcdef",
        API_KEY_SALT: "prod_api_salt_1234567890abcdef",
        SECURITY_TELEMETRY_HASH_KEY: "prod_hash_key_1234567890abcdef",
        CRON_SECRET: "prod_cron_secret_1234567890abcdef",
        SHARE_COOKIE_SECRET: "prod_share_cookie_secret_1234567890abcdef",
        ADMIN_COOKIE_SECRET: "prod_admin_cookie_secret_1234567890abcdef",
        OIDC_SECRETS_KEY: "prod_oidc_secret_key_1234567890abcdef",
        OWNER_EMAIL: "owner@cyang.io",
        MALWARE_SCANNER_URL: "https://scan.cyang.io/v1/scan",
        MALWARE_SCANNER_CLIENT_ID: "doclinks-production",
        MALWARE_SCANNER_HMAC_SECRET_HEX: "a".repeat(64),
        MALWARE_SCANNER_TIMEOUT_MS: "10000",
        BACKUP_AUTOMATION_ENABLED: "1",
        BACKUP_STATUS_WEBHOOK_TOKEN: "prod_backup_webhook_token_1234567890abcdef",
      })
    );

    expect(report.ok).toBeTruthy();
    expect(report.status).toBe("pass");
    expect(report.errorCount).toBe(0);
  });

  test("warns when deprecated env aliases are used without preferred names", () => {
    const report = auditRuntimeConfig(
      env({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_ENV: "production",
        APP_URL: "https://www.cyang.io",
        NEXT_PUBLIC_APP_URL: "https://www.cyang.io",
        NEXTAUTH_URL: "https://www.cyang.io",
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=require",
        R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        R2_BUCKET_NAME: "cyang-prod",
        R2_ACCESS_KEY_ID: "prod_access_key_1234567890abcdef",
        R2_SECRET_ACCESS_KEY: "prod_secret_key_1234567890abcdef",
        DOC_MASTER_KEYS: VALID_DOC_MASTER_KEYS,
        ENABLE_STRICT_ENV_VALIDATION: "1",
        APP_SECRET: "prod_app_secret_1234567890abcdef",
        AUTH_SECRET: "prod_auth_secret_1234567890abcdef",
        NEXTAUTH_SECRET: "prod_nextauth_secret_1234567890abcdef",
        VIEW_SALT: "prod_view_salt_1234567890abcdef",
        API_KEY_SALT: "prod_api_salt_1234567890abcdef",
        SECURITY_TELEMETRY_HASH_KEY: "prod_hash_key_1234567890abcdef",
        CRON_SECRET: "prod_cron_secret_1234567890abcdef",
        SHARE_COOKIE_SECRET: "prod_share_cookie_secret_1234567890abcdef",
        ADMIN_COOKIE_SECRET: "prod_admin_cookie_secret_1234567890abcdef",
        OIDC_SECRETS_KEY: "prod_oidc_secret_key_1234567890abcdef",
        OWNER_EMAIL: "owner@cyang.io",
        MALWARE_SCANNER_URL: "https://scan.cyang.io/v1/scan",
        MALWARE_SCANNER_CLIENT_ID: "doclinks-production",
        MALWARE_SCANNER_HMAC_SECRET_HEX: "a".repeat(64),
        MALWARE_SCANNER_TIMEOUT_MS: "10000",
      })
    );

    expect(report.findings.some((finding) => finding.code === "LEGACY_ALIAS_ONLY" && finding.field === "R2_BUCKET_NAME")).toBeTruthy();
  });

  test("rejects the retired bearer scanner and malformed HMAC credentials", () => {
    const report = auditRuntimeConfig(env({
      NODE_ENV: "production",
      NEXT_PUBLIC_APP_ENV: "production",
      MALWARE_SCANNER_URL: "https://scanner.cyang.io/scan",
      MALWARE_SCANNER_CLIENT_ID: "unsafe client",
      MALWARE_SCANNER_HMAC_SECRET_HEX: "not-a-secret",
    }));

    expect(report.findings.some((finding) => finding.field === "MALWARE_SCANNER_URL")).toBeTruthy();
  });
});
