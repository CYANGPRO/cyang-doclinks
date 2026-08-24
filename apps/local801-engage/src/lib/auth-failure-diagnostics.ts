const SAFE_PRODUCTION_AUTH_FAILURE_CODES = new Set([
  "AUTH_CONFIG_INVALID",
  "AUTH_DISABLED",
  "EMAIL_NOT_VERIFIED",
  "EMAIL_REQUIRED",
  "IDENTITY_INVALID",
  "IDENTITY_MISMATCH",
  "MFA_REQUIRED",
  "USER_NOT_PROVISIONED",
]);

export function safeProductionAuthFailureCode(error: unknown): string {
  try {
    if (!error || typeof error !== "object" || !("code" in error)) return "AUTH_DENIED";
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && SAFE_PRODUCTION_AUTH_FAILURE_CODES.has(code)
      ? code
      : "AUTH_DENIED";
  } catch {
    return "AUTH_DENIED";
  }
}

const SAFE_INTERNAL_ERROR_NAMES = new Set([
  "PiiProtectionError",
  "ProductionAuthError",
]);

const SAFE_INTERNAL_ERROR_CODES = new Set([
  "ACTIVE_KEY_INVALID",
  "AUTHENTICATION_FAILED",
  "AUTH_CONFIG_INVALID",
  "AUTH_DISABLED",
  "DUPLICATE_KEY",
  "EMAIL_NOT_VERIFIED",
  "EMAIL_REQUIRED",
  "ENVELOPE_INVALID",
  "IDENTITY_INVALID",
  "IDENTITY_MISMATCH",
  "INVALID_CONTEXT",
  "INVALID_KEY",
  "KEYRING_INVALID",
  "KEYRING_MISSING",
  "KEY_NOT_FOUND",
  "KEY_VERSION_INVALID",
  "MFA_REQUIRED",
  "NORMALIZATION_FAILED",
  "PLAINTEXT_INVALID",
  "PLAINTEXT_TOO_LARGE",
  "PROTECTED_PII_INVALID",
  "PROTECTED_AUTH_ACCOUNT_FAILED",
  "PROTECTED_AUTH_IDENTITY_LOOKUP_FAILED",
  "PROTECTED_AUTH_SUBJECT_QUERY_FAILED",
  "PROTECTED_AUTH_USER_QUERY_FAILED",
  "PROTECTED_AUTH_ORGANIZATION_FAILED",
  "PROTECTED_AUTH_TRANSACTION_FAILED",
  "USER_NOT_PROVISIONED",
]);

export type SafeProductionAuthInternalFailure = {
  category: "auth" | "database-query" | "database-transaction" | "pii" | "unknown";
  code: string;
};

/** Private-log diagnostic containing only fixed categories and allowlisted non-PII codes. */
export function safeProductionAuthInternalFailure(error: unknown): SafeProductionAuthInternalFailure {
  try {
    if (!error || typeof error !== "object") return { category: "unknown", code: "UNCLASSIFIED" };
    const record = error as { name?: unknown; code?: unknown };
    const name = typeof record.name === "string" ? record.name : "";
    const code = typeof record.code === "string" ? record.code : "";
    if (name.startsWith("Local801TransactionError:")) {
      const stage = name.slice("Local801TransactionError:".length);
      return /^[A-Z][A-Z0-9_]{1,63}$/.test(stage)
        ? { category: "database-transaction", code: stage }
        : { category: "database-transaction", code: "UNCLASSIFIED" };
    }
    if (name === "PostgresError" || /^[0-9A-Z]{5}$/.test(code)) {
      return /^[0-9A-Z]{5}$/.test(code)
        ? { category: "database-query", code }
        : { category: "database-query", code: "UNCLASSIFIED" };
    }
    if (SAFE_INTERNAL_ERROR_NAMES.has(name) && SAFE_INTERNAL_ERROR_CODES.has(code)) {
      return { category: name === "PiiProtectionError" ? "pii" : "auth", code };
    }
    return { category: "unknown", code: "UNCLASSIFIED" };
  } catch {
    return { category: "unknown", code: "UNCLASSIFIED" };
  }
}

export type SafeProductionAuthClaimPresence = {
  subject: boolean;
  tenant: boolean;
  objectId: boolean;
  email: boolean;
  emails: boolean;
  local801Email: boolean;
  verifiedPrimaryEmail: boolean;
  preferredUsername: boolean;
  emailVerified: boolean;
  emailDomainVerified: boolean;
  amrMfa: boolean;
};

const NO_CLAIMS: SafeProductionAuthClaimPresence = {
  subject: false,
  tenant: false,
  objectId: false,
  email: false,
  emails: false,
  local801Email: false,
  verifiedPrimaryEmail: false,
  preferredUsername: false,
  emailVerified: false,
  emailDomainVerified: false,
  amrMfa: false,
};

export function safeProductionAuthClaimPresence(profile: unknown): SafeProductionAuthClaimPresence {
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return { ...NO_CLAIMS };
    const claims = profile as Record<string, unknown>;
    const presentString = (key: string) => typeof claims[key] === "string" && claims[key].trim().length > 0;
    const emails = claims.emails;
    const amr = claims.amr;
    return {
      subject: presentString("sub"),
      tenant: presentString("tid"),
      objectId: presentString("oid"),
      email: presentString("email"),
      emails: Array.isArray(emails) && emails.some((value) => typeof value === "string" && value.trim().length > 0),
      local801Email: presentString("local801_email"),
      verifiedPrimaryEmail: presentString("verified_primary_email"),
      preferredUsername: presentString("preferred_username"),
      emailVerified: claims.email_verified === true,
      emailDomainVerified: claims.xms_edov === true,
      amrMfa: Array.isArray(amr)
        ? amr.includes("mfa")
        : typeof amr === "string" && amr.split(/\s+/).includes("mfa"),
    };
  } catch {
    return { ...NO_CLAIMS };
  }
}
