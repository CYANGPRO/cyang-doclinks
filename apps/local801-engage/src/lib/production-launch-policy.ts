const scannerClientIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const scannerSecretPattern = /^[0-9a-f]{64}$/;
const providerIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const reviewIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

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
  | "SCANNER_DISABLED"
  | "SCANNER_CONFIG_INVALID"
  | "DATABASE_CONFIG_INVALID"
  | "STORAGE_CONFIG_INVALID"
  | "ENCRYPTION_CONFIG_INVALID"
  | "PII_KEY_CONFIG_INVALID"
  | "PII_PROTECTION_NOT_VERIFIED"
  | "BACKUP_RESTORE_NOT_VERIFIED"
  | "SECURITY_REVIEW_NOT_APPROVED"
  | "SECURITY_REVIEW_ID_MISSING"
  | "PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED"
  | "PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED"
  | "SYNTHETIC_SEED_ENABLED";

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
  const mfaClaim = env.LOCAL801_OIDC_MFA_CLAIM ?? "amr";
  const mfaValue = env.LOCAL801_OIDC_MFA_VALUE?.trim() || "mfa";
  if (!providerIdPattern.test(providerId) || !wellKnown || !clientId || !clientSecret || !mfaValue || mfaValue.length > 120) return false;
  if (mfaClaim !== "amr" && mfaClaim !== "acr") return false;
  try {
    const parsed = new URL(wellKnown);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
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

function nextAuthSecretLooksStrong(value: string | undefined) {
  if (!value || value.length < 32) return false;
  const normalized = value.toLowerCase();
  return !normalized.includes("changeme") && !normalized.includes("placeholder") && !value.includes("<") && !value.includes(">");
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
export function getProductionLaunchState(env: NodeJS.ProcessEnv = process.env): ProductionLaunchState {
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

  if (env.LOCAL801_MALWARE_SCANNER_ENABLED !== "1") blockers.push("SCANNER_DISABLED");
  else if (!scannerConfigLooksValid(env)) blockers.push("SCANNER_CONFIG_INVALID");

  const localDatabase = databaseTarget(env.LOCAL801_DATABASE_URL);
  const legacyDatabase = databaseTarget(env.DATABASE_URL);
  if (!localDatabase || (legacyDatabase && localDatabase === legacyDatabase)) blockers.push("DATABASE_CONFIG_INVALID");
  if (!storageIsPrivateAndScoped(env)) blockers.push("STORAGE_CONFIG_INVALID");
  if (!encryptionConfigPresent(env)) blockers.push("ENCRYPTION_CONFIG_INVALID");
  if (!piiKeyConfigLooksValid(env)) blockers.push("PII_KEY_CONFIG_INVALID");

  if (env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED !== "1") blockers.push("PII_PROTECTION_NOT_VERIFIED");
  if (env.LOCAL801_BACKUP_RESTORE_VERIFIED !== "1") blockers.push("BACKUP_RESTORE_NOT_VERIFIED");
  if (env.LOCAL801_SECURITY_REVIEW_APPROVED !== "1") blockers.push("SECURITY_REVIEW_NOT_APPROVED");
  if (!reviewIdPattern.test(env.LOCAL801_PRODUCTION_SECURITY_REVIEW_ID?.trim() ?? "")) blockers.push("SECURITY_REVIEW_ID_MISSING");

  if (env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"
    && !protectedAuthoritativeImportExecutionConfigured(env)) {
    blockers.push("PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED");
  }
  if (env.LOCAL801_DURABLE_IMPORTS_ENABLED === "1") blockers.push("PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED");
  if (env.LOCAL801_ALLOW_SYNTHETIC_SEED === "1") blockers.push("SYNTHETIC_SEED_ENABLED");

  return Object.freeze({
    environment: production ? "production" : "non-production",
    launchRequested,
    ready: production && launchRequested && blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

/** Preview can exercise the OIDC implementation; Vercel production additionally requires the launch gate. */
export function productionAuthRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.LOCAL801_PRODUCTION_AUTH_ENABLED !== "1") return false;
  if (env.VERCEL_ENV !== "production") return true;
  return getProductionLaunchState(env).ready;
}

export const __testing = {
  canonical32ByteKey,
  databaseTarget,
  encryptionConfigPresent,
  nextAuthSecretLooksStrong,
  oidcConfigLooksValid,
  parseCanonicalHttpsRoot,
  piiKeyConfigLooksValid,
  protectedAuthoritativeImportExecutionConfigured,
  reviewIdPattern,
  scannerConfigLooksValid,
  storageIsPrivateAndScoped,
};