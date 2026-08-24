import { sentryConfigLooksValid } from "./sentry-policy.ts";

const scannerClientIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const scannerSecretPattern = /^[0-9a-f]{64}$/;
const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const reviewIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const objectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Vercel discovers runtime environment dependencies from explicit `process.env.NAME`
 * references. Passing `process.env` through the injectable policy parameter works in
 * local Node and during builds, but can leave sensitive variables out of a deployed
 * function's runtime environment. Keep this explicit snapshot in sync with the launch
 * policy so Production build and runtime decisions use the same inputs.
 */
function productionLaunchRuntimeEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    LOCAL801_ACCESS_SUPPORT_EMAIL: process.env.LOCAL801_ACCESS_SUPPORT_EMAIL,
    LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: process.env.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION,
    LOCAL801_ALLOW_SYNTHETIC_SEED: process.env.LOCAL801_ALLOW_SYNTHETIC_SEED,
    LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER: process.env.LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER,
    LOCAL801_APP_URL: process.env.LOCAL801_APP_URL,
    LOCAL801_APPLE_TEAM_ID: process.env.LOCAL801_APPLE_TEAM_ID,
    LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED: process.env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED,
    LOCAL801_BACKUP_RESTORE_VERIFIED: process.env.LOCAL801_BACKUP_RESTORE_VERIFIED,
    LOCAL801_DATABASE_PII_PROTECTION_ENABLED: process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED,
    LOCAL801_DATABASE_URL: process.env.LOCAL801_DATABASE_URL,
    LOCAL801_DOWNLOAD_RATE_LIMIT_PER_MINUTE: process.env.LOCAL801_DOWNLOAD_RATE_LIMIT_PER_MINUTE,
    LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED: process.env.LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED,
    LOCAL801_DURABLE_IMPORTS_ENABLED: process.env.LOCAL801_DURABLE_IMPORTS_ENABLED,
    LOCAL801_ENCRYPTION_MASTER_KEYS: process.env.LOCAL801_ENCRYPTION_MASTER_KEYS,
    LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID: process.env.LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID,
    LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID: process.env.LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID,
    LOCAL801_ENTRA_USER_PROVISIONING_ENABLED: process.env.LOCAL801_ENTRA_USER_PROVISIONING_ENABLED,
    LOCAL801_EXPORT_RATE_LIMIT_PER_HOUR: process.env.LOCAL801_EXPORT_RATE_LIMIT_PER_HOUR,
    LOCAL801_IMPORT_RATE_LIMIT_PER_HOUR: process.env.LOCAL801_IMPORT_RATE_LIMIT_PER_HOUR,
    LOCAL801_MALWARE_SCANNER_CLIENT_ID: process.env.LOCAL801_MALWARE_SCANNER_CLIENT_ID,
    LOCAL801_MALWARE_SCANNER_ENABLED: process.env.LOCAL801_MALWARE_SCANNER_ENABLED,
    LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX: process.env.LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX,
    LOCAL801_MALWARE_SCANNER_URL: process.env.LOCAL801_MALWARE_SCANNER_URL,
    LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL: process.env.LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL,
    LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX: process.env.LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX,
    LOCAL801_MOBILE_PUSH_GATEWAY_URL: process.env.LOCAL801_MOBILE_PUSH_GATEWAY_URL,
    LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX: process.env.LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX,
    LOCAL801_MUTATION_RATE_LIMIT_PER_MINUTE: process.env.LOCAL801_MUTATION_RATE_LIMIT_PER_MINUTE,
    LOCAL801_NATIVE_MOBILE_ENABLED: process.env.LOCAL801_NATIVE_MOBILE_ENABLED,
    LOCAL801_OIDC_CLIENT_ID: process.env.LOCAL801_OIDC_CLIENT_ID,
    LOCAL801_OIDC_CLIENT_SECRET: process.env.LOCAL801_OIDC_CLIENT_SECRET,
    LOCAL801_OIDC_BOOTSTRAP_OBJECT_ID: process.env.LOCAL801_OIDC_BOOTSTRAP_OBJECT_ID,
    LOCAL801_OIDC_MFA_CLAIM: process.env.LOCAL801_OIDC_MFA_CLAIM,
    LOCAL801_OIDC_MFA_VALUE: process.env.LOCAL801_OIDC_MFA_VALUE,
    LOCAL801_OIDC_PROVIDER_ID: process.env.LOCAL801_OIDC_PROVIDER_ID,
    LOCAL801_OIDC_TENANT_ID: process.env.LOCAL801_OIDC_TENANT_ID,
    LOCAL801_OIDC_WELL_KNOWN: process.env.LOCAL801_OIDC_WELL_KNOWN,
    LOCAL801_ORGANIZATION_SLUG: process.env.LOCAL801_ORGANIZATION_SLUG,
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: process.env.LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION,
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: process.env.LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION,
    LOCAL801_PII_BACKFILL_ENABLED: process.env.LOCAL801_PII_BACKFILL_ENABLED,
    LOCAL801_PII_BLIND_INDEX_KEYS: process.env.LOCAL801_PII_BLIND_INDEX_KEYS,
    LOCAL801_PII_DUAL_WRITE_ENABLED: process.env.LOCAL801_PII_DUAL_WRITE_ENABLED,
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: process.env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS,
    LOCAL801_PREVIEW_AUTH_ENABLED: process.env.LOCAL801_PREVIEW_AUTH_ENABLED,
    LOCAL801_PRODUCTION_AUTH_ENABLED: process.env.LOCAL801_PRODUCTION_AUTH_ENABLED,
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: process.env.LOCAL801_PRODUCTION_LAUNCH_ENABLED,
    LOCAL801_PRODUCTION_SECURITY_REVIEW_ID: process.env.LOCAL801_PRODUCTION_SECURITY_REVIEW_ID,
    LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED: process.env.LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED,
    LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED: process.env.LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED,
    LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED: process.env.LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED,
    LOCAL801_PUSH_ENABLED: process.env.LOCAL801_PUSH_ENABLED,
    LOCAL801_R2_ACCESS_KEY_ID: process.env.LOCAL801_R2_ACCESS_KEY_ID,
    LOCAL801_R2_ACCOUNT_ID: process.env.LOCAL801_R2_ACCOUNT_ID,
    LOCAL801_R2_BUCKET: process.env.LOCAL801_R2_BUCKET,
    LOCAL801_R2_ENDPOINT: process.env.LOCAL801_R2_ENDPOINT,
    LOCAL801_R2_SECRET_ACCESS_KEY: process.env.LOCAL801_R2_SECRET_ACCESS_KEY,
    LOCAL801_SEARCH_RATE_LIMIT_PER_MINUTE: process.env.LOCAL801_SEARCH_RATE_LIMIT_PER_MINUTE,
    LOCAL801_SECURITY_REVIEW_APPROVED: process.env.LOCAL801_SECURITY_REVIEW_APPROVED,
    LOCAL801_SENTRY_DSN: process.env.LOCAL801_SENTRY_DSN,
    LOCAL801_SENTRY_ENABLED: process.env.LOCAL801_SENTRY_ENABLED,
    LOCAL801_SYNTHETIC_DATA_ONLY: process.env.LOCAL801_SYNTHETIC_DATA_ONLY,
    LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED: process.env.LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED,
    LOCAL801_VAPID_PRIVATE_KEY: process.env.LOCAL801_VAPID_PRIVATE_KEY,
    LOCAL801_VAPID_PUBLIC_KEY: process.env.LOCAL801_VAPID_PUBLIC_KEY,
    LOCAL801_VAPID_SUBJECT: process.env.LOCAL801_VAPID_SUBJECT,
    MFA_ENFORCE_ALL: process.env.MFA_ENFORCE_ALL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NODE_ENV: process.env.NODE_ENV,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    SIGNUP_ENABLED: process.env.SIGNUP_ENABLED,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
}

function resolveProductionLaunchEnv(env: NodeJS.ProcessEnv) {
  return env === process.env ? productionLaunchRuntimeEnv() : env;
}

export type ProductionLaunchBlocker =
  | "NOT_VERCEL_PRODUCTION"
  | "LAUNCH_NOT_APPROVED"
  | "PRODUCTION_AUTH_DISABLED"
  | "PREVIEW_AUTH_ENABLED"
  | "SIGNUP_ENABLED"
  | "MFA_NOT_ENFORCED"
  | "PRODUCTION_ORGANIZATION_INVALID"
  | "APP_URL_INVALID"
  | "NEXTAUTH_URL_INVALID"
  | "NEXTAUTH_SECRET_WEAK"
  | "OIDC_CONFIG_INVALID"
  | "ENTRA_PROVISIONING_CONFIG_INVALID"
  | "SCANNER_DISABLED"
  | "SCANNER_CONFIG_INVALID"
  | "SENTRY_CONFIG_INVALID"
  | "PUSH_CONFIG_INVALID"
  | "MOBILE_CONFIG_INVALID"
  | "DATABASE_CONFIG_INVALID"
  | "DATABASE_TLS_NOT_REQUIRED"
  | "STORAGE_CONFIG_INVALID"
  | "ENCRYPTION_CONFIG_INVALID"
  | "PII_KEY_CONFIG_INVALID"
  | "PII_PROTECTION_NOT_VERIFIED"
  | "BACKUP_RESTORE_NOT_VERIFIED"
  | "DISTRIBUTED_RATE_LIMITS_DISABLED"
  | "SECURITY_REVIEW_NOT_APPROVED"
  | "SECURITY_REVIEW_ID_MISSING"
  | "PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"
  | "PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED"
  | "PROTECTED_DURABLE_IMPORTS_DISABLED"
  | "RATE_LIMIT_CONFIG_INVALID"
  | "SYNTHETIC_SEED_ENABLED"
  | "SYNTHETIC_PRODUCTION_PILOT_ENABLED"
  | "SYNTHETIC_DATA_ONLY_ENABLED";

export type ProductionLaunchState = Readonly<{
  environment: "production" | "non-production";
  launchRequested: boolean;
  ready: boolean;
  blockers: readonly ProductionLaunchBlocker[];
}>;

function parseCanonicalHttpsRoot(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function databaseTarget(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") return null;
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port}/${parsed.pathname.replace(/^\//, "")}`;
  } catch {
    return null;
  }
}

function databaseRequiresTls(value: string | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
    return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
  } catch {
    return false;
  }
}

function storageIsPrivateAndScoped(env: NodeJS.ProcessEnv) {
  const accountId = env.LOCAL801_R2_ACCOUNT_ID?.trim();
  const bucket = env.LOCAL801_R2_BUCKET?.trim();
  const endpoint = parseCanonicalHttpsRoot(env.LOCAL801_R2_ENDPOINT);
  if (!accountId || !bucket || !env.LOCAL801_R2_ACCESS_KEY_ID || !env.LOCAL801_R2_SECRET_ACCESS_KEY || !endpoint) return false;
  const hostname = endpoint.hostname.toLowerCase();
  if (hostname !== `${accountId.toLowerCase()}.r2.cloudflarestorage.com`) return false;
  const legacyBucket = env.R2_BUCKET ?? env.R2_BUCKET_NAME;
  return !legacyBucket || legacyBucket !== bucket;
}

function encryptionConfigPresent(env: NodeJS.ProcessEnv) {
  const keyring = env.LOCAL801_ENCRYPTION_MASTER_KEYS?.trim() ?? "";
  const active = env.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION?.trim() ?? "";
  return keyring.startsWith("{") && keyring.endsWith("}") && keyring.length >= 20 && keyVersionPattern.test(active);
}

function canonical32ByteKey(value: unknown) {
  if (typeof value !== "string" || value.length < 40 || value.length > 48) return false;
  const decoded = Buffer.from(value, "base64");
  const valid = decoded.length === 32 && decoded.toString("base64") === value;
  decoded.fill(0);
  return valid;
}

function parsePiiLaunchKeyring(raw: string | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 8) return null;
    const result = new Map<string, string>();
    for (const [version, value] of entries) {
      if (!keyVersionPattern.test(version) || !canonical32ByteKey(value)) return null;
      result.set(version, value as string);
    }
    return result;
  } catch {
    return null;
  }
}

function piiKeyConfigLooksValid(env: NodeJS.ProcessEnv) {
  const encryption = parsePiiLaunchKeyring(env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS);
  const indexes = parsePiiLaunchKeyring(env.LOCAL801_PII_BLIND_INDEX_KEYS);
  const activeEncryption = env.LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION?.trim() ?? "";
  const activeIndex = env.LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION?.trim() ?? "";
  if (!encryption || !indexes || !encryption.has(activeEncryption) || !indexes.has(activeIndex)) return false;
  const encryptionMaterial = new Set(encryption.values());
  for (const indexKey of indexes.values()) if (encryptionMaterial.has(indexKey)) return false;
  return true;
}

function oidcConfigLooksValid(env: NodeJS.ProcessEnv) {
  const providerId = env.LOCAL801_OIDC_PROVIDER_ID?.trim() || "local801-oidc";
  const wellKnown = env.LOCAL801_OIDC_WELL_KNOWN?.trim();
  const clientId = env.LOCAL801_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.LOCAL801_OIDC_CLIENT_SECRET?.trim();
  const bootstrapObjectId = env.LOCAL801_OIDC_BOOTSTRAP_OBJECT_ID?.trim() ?? "";
  const mfaClaim = env.LOCAL801_OIDC_MFA_CLAIM ?? "amr";
  const mfaValue = env.LOCAL801_OIDC_MFA_VALUE?.trim() || "mfa";
  if (!providerIdPattern.test(providerId) || !wellKnown || !clientId || !clientSecret
    || !objectIdPattern.test(bootstrapObjectId) || !mfaValue || mfaValue.length > 120) return false;
  if (mfaClaim !== "amr" && mfaClaim !== "acr") return false;
  try {
    const parsed = new URL(wellKnown);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function entraProvisioningConfigLooksValid(env: NodeJS.ProcessEnv) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const supportEmail = env.LOCAL801_ACCESS_SUPPORT_EMAIL?.trim() ?? "";
  return env.LOCAL801_ENTRA_USER_PROVISIONING_ENABLED === "1"
    && uuid.test(env.LOCAL801_OIDC_TENANT_ID?.trim() ?? "")
    && uuid.test(env.LOCAL801_OIDC_CLIENT_ID?.trim() ?? "")
    && uuid.test(env.LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID?.trim() ?? "")
    && ((env.LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID?.trim() || "00000000-0000-0000-0000-000000000000") === "00000000-0000-0000-0000-000000000000"
      || uuid.test(env.LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID?.trim() ?? ""))
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)
    && supportEmail.length <= 320;
}

function scannerConfigLooksValid(env: NodeJS.ProcessEnv) {
  const configuredUrl = env.LOCAL801_MALWARE_SCANNER_URL?.trim() || "https://scan.cyang.io";
  const parsed = parseCanonicalHttpsRoot(configuredUrl);
  return Boolean(
    parsed
    && parsed.hostname.toLowerCase() === "scan.cyang.io"
    && scannerClientIdPattern.test(env.LOCAL801_MALWARE_SCANNER_CLIENT_ID ?? "")
    && scannerSecretPattern.test(env.LOCAL801_MALWARE_SCANNER_HMAC_SECRET_HEX ?? ""),
  );
}

function pushConfigLooksValid(env: NodeJS.ProcessEnv) {
  const publicKey = env.LOCAL801_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.LOCAL801_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.LOCAL801_VAPID_SUBJECT?.trim() ?? "";
  try {
    return env.LOCAL801_PUSH_ENABLED === "1"
      && Buffer.from(publicKey, "base64url").length === 65
      && Buffer.from(privateKey, "base64url").length === 32
      && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)
      && !publicKey.startsWith("disabled-")
      && !privateKey.startsWith("disabled-");
  } catch {
    return false;
  }
}

function mobileConfigLooksValid(env: NodeJS.ProcessEnv) {
  // Native distribution is a separately enabled post-launch channel. A web/PWA launch must not
  // require Apple/Google signing or owner-operated native gateways, but enabling native delivery
  // still fails closed unless its complete trust bundle is present.
  if (env.LOCAL801_NATIVE_MOBILE_ENABLED !== "1") return true;
  const gateway = (value: string | undefined, host: string) => {
    const parsed = parseCanonicalHttpsRoot(value);
    return parsed?.hostname.toLowerCase() === host;
  };
  return gateway(env.LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL, "attest.cyang.io")
    && gateway(env.LOCAL801_MOBILE_PUSH_GATEWAY_URL, "push.cyang.io")
    && scannerSecretPattern.test(env.LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX ?? "")
    && scannerSecretPattern.test(env.LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX ?? "")
    && /^[A-Z0-9]{10}$/.test(env.LOCAL801_APPLE_TEAM_ID ?? "")
    && /^[0-9]{6,20}$/.test(env.LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER ?? "");
}

function nextAuthSecretLooksStrong(value: string | undefined) {
  if (!value || value.length < 32) return false;
  const normalized = value.toLowerCase();
  return !normalized.includes("changeme") && !normalized.includes("placeholder") && !value.includes("<") && !value.includes(">");
}

function rateLimitConfigLooksValid(env: NodeJS.ProcessEnv) {
  const within = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(value ?? fallback);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
  };
  return within(env.LOCAL801_SEARCH_RATE_LIMIT_PER_MINUTE, 60, 10, 600)
    && within(env.LOCAL801_IMPORT_RATE_LIMIT_PER_HOUR, 10, 1, 100)
    && within(env.LOCAL801_EXPORT_RATE_LIMIT_PER_HOUR, 20, 1, 200)
    && within(env.LOCAL801_DOWNLOAD_RATE_LIMIT_PER_MINUTE, 20, 1, 200)
    && within(env.LOCAL801_MUTATION_RATE_LIMIT_PER_MINUTE, 120, 10, 600);
}

/**
 * The Stage 12 executor remains intrinsically non-production. The shared authoritative-execution
 * master switch is allowed in production only when the protected-only executor is fully gated.
 */
function protectedAuthoritativeImportExecutionConfigured(env: NodeJS.ProcessEnv) {
  return env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"
    && env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"
    && env.LOCAL801_PII_BACKFILL_ENABLED !== "1"
    && env.LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"
    && env.LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1";
}

/**
 * Environment-only, secret-safe production launch policy. The returned object contains only
 * boolean state and blocker codes; it never returns URLs, credentials, identities, or secret values.
 */
export function getProductionLaunchState(env: NodeJS.ProcessEnv = productionLaunchRuntimeEnv()): ProductionLaunchState {
  env = resolveProductionLaunchEnv(env);
  const blockers: ProductionLaunchBlocker[] = [];
  const production = env.VERCEL_ENV === "production";
  const launchRequested = env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1";

  if (!production) blockers.push("NOT_VERCEL_PRODUCTION");
  if (!launchRequested) blockers.push("LAUNCH_NOT_APPROVED");
  if (env.LOCAL801_PRODUCTION_AUTH_ENABLED !== "1") blockers.push("PRODUCTION_AUTH_DISABLED");
  if (env.LOCAL801_PREVIEW_AUTH_ENABLED === "1") blockers.push("PREVIEW_AUTH_ENABLED");
  if ((env.SIGNUP_ENABLED ?? "0") !== "0") blockers.push("SIGNUP_ENABLED");
  if ((env.MFA_ENFORCE_ALL ?? "1") !== "1") blockers.push("MFA_NOT_ENFORCED");

  const organizationSlug = env.LOCAL801_ORGANIZATION_SLUG?.trim() ?? "";
  if (!organizationSlug || organizationSlug === "local801-preview" || organizationSlug.length > 80) {
    blockers.push("PRODUCTION_ORGANIZATION_INVALID");
  }

  const appUrl = parseCanonicalHttpsRoot(env.LOCAL801_APP_URL);
  if (!appUrl || appUrl.hostname.toLowerCase() !== "cat.cyang.io") blockers.push("APP_URL_INVALID");
  const nextAuthUrl = parseCanonicalHttpsRoot(env.NEXTAUTH_URL);
  if (!nextAuthUrl || !appUrl || nextAuthUrl.origin !== appUrl.origin) blockers.push("NEXTAUTH_URL_INVALID");
  if (!nextAuthSecretLooksStrong(env.NEXTAUTH_SECRET)) blockers.push("NEXTAUTH_SECRET_WEAK");
  if (!oidcConfigLooksValid(env)) blockers.push("OIDC_CONFIG_INVALID");
  if (!entraProvisioningConfigLooksValid(env)) blockers.push("ENTRA_PROVISIONING_CONFIG_INVALID");

  if (env.LOCAL801_MALWARE_SCANNER_ENABLED !== "1") blockers.push("SCANNER_DISABLED");
  else if (!scannerConfigLooksValid(env)) blockers.push("SCANNER_CONFIG_INVALID");
  if (!sentryConfigLooksValid(env)) blockers.push("SENTRY_CONFIG_INVALID");
  if (!pushConfigLooksValid(env)) blockers.push("PUSH_CONFIG_INVALID");
  if (!mobileConfigLooksValid(env)) blockers.push("MOBILE_CONFIG_INVALID");

  const localDatabase = databaseTarget(env.LOCAL801_DATABASE_URL);
  const legacyDatabase = databaseTarget(env.DATABASE_URL);
  if (!localDatabase || (legacyDatabase && localDatabase === legacyDatabase)) blockers.push("DATABASE_CONFIG_INVALID");
  if (!databaseRequiresTls(env.LOCAL801_DATABASE_URL)) blockers.push("DATABASE_TLS_NOT_REQUIRED");
  if (!storageIsPrivateAndScoped(env)) blockers.push("STORAGE_CONFIG_INVALID");
  if (!encryptionConfigPresent(env)) blockers.push("ENCRYPTION_CONFIG_INVALID");
  if (!piiKeyConfigLooksValid(env)) blockers.push("PII_KEY_CONFIG_INVALID");
  if (!rateLimitConfigLooksValid(env)) blockers.push("RATE_LIMIT_CONFIG_INVALID");

  if (env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") blockers.push("PII_PROTECTION_NOT_VERIFIED");
  if (env.LOCAL801_BACKUP_RESTORE_VERIFIED !== "1") blockers.push("BACKUP_RESTORE_NOT_VERIFIED");
  if (env.LOCAL801_DISTRIBUTED_RATE_LIMIT_ENABLED !== "1") blockers.push("DISTRIBUTED_RATE_LIMITS_DISABLED");
  if (env.LOCAL801_SECURITY_REVIEW_APPROVED !== "1") blockers.push("SECURITY_REVIEW_NOT_APPROVED");
  if (!reviewIdPattern.test(env.LOCAL801_PRODUCTION_SECURITY_REVIEW_ID?.trim() ?? "")) blockers.push("SECURITY_REVIEW_ID_MISSING");

  if (env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"
    && !protectedAuthoritativeImportExecutionConfigured(env)) {
    blockers.push("PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED");
  }
  if (env.LOCAL801_DURABLE_IMPORTS_ENABLED === "1") blockers.push("PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED");
  if (env.LOCAL801_PROTECTED_DURABLE_IMPORTS_ENABLED !== "1") blockers.push("PROTECTED_DURABLE_IMPORTS_DISABLED");
  if (env.LOCAL801_ALLOW_SYNTHETIC_SEED === "1") blockers.push("SYNTHETIC_SEED_ENABLED");
  if (env.LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED === "1") blockers.push("SYNTHETIC_PRODUCTION_PILOT_ENABLED");
  if (env.LOCAL801_SYNTHETIC_DATA_ONLY === "1") blockers.push("SYNTHETIC_DATA_ONLY_ENABLED");

  return Object.freeze({
    environment: production ? "production" : "non-production",
    launchRequested,
    ready: production && launchRequested && blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

/**
 * Stage 23 may exercise the real Production origin with an isolated database
 * containing synthetic data only. Every launch prerequisite except the final
 * launch approval must pass, and the two pilot assertions are themselves final
 * launch blockers. Durable Production imports remain closed in this mode.
 */
export function productionSyntheticPilotRuntimeEnabled(env: NodeJS.ProcessEnv = productionLaunchRuntimeEnv()) {
  env = resolveProductionLaunchEnv(env);
  if (env.VERCEL_ENV !== "production"
    || env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1"
    || env.LOCAL801_SYNTHETIC_PRODUCTION_PILOT_ENABLED !== "1"
    || env.LOCAL801_SYNTHETIC_DATA_ONLY !== "1") return false;
  const allowed = new Set<ProductionLaunchBlocker>([
    "LAUNCH_NOT_APPROVED",
    "SYNTHETIC_PRODUCTION_PILOT_ENABLED",
    "SYNTHETIC_DATA_ONLY_ENABLED",
  ]);
  return getProductionLaunchState(env).blockers.every((blocker) => allowed.has(blocker));
}

/** Preview can exercise the OIDC implementation; Vercel production additionally requires the launch gate. */
export function productionAuthRuntimeEnabled(env: NodeJS.ProcessEnv = productionLaunchRuntimeEnv()) {
  env = resolveProductionLaunchEnv(env);
  if (env.LOCAL801_PRODUCTION_AUTH_ENABLED !== "1") return false;
  if (env.VERCEL_ENV !== "production") return true;
  return getProductionLaunchState(env).ready || productionSyntheticPilotRuntimeEnabled(env);
}

export const __testing = {
  canonical32ByteKey,
  databaseTarget,
  databaseRequiresTls,
  encryptionConfigPresent,
  entraProvisioningConfigLooksValid,
  nextAuthSecretLooksStrong,
  oidcConfigLooksValid,
  parseCanonicalHttpsRoot,
  piiKeyConfigLooksValid,
  rateLimitConfigLooksValid,
  mobileConfigLooksValid,
  protectedAuthoritativeImportExecutionConfigured,
  pushConfigLooksValid,
  reviewIdPattern,
  scannerConfigLooksValid,
  storageIsPrivateAndScoped,
};
