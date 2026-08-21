import { validateDocMasterKeysConfig } from "@/lib/encryption";
import { readMalwareScannerConfiguration } from "@/lib/malwareScannerConfig";

export type AppEnvironment = "development" | "test" | "staging" | "production";
export type ConfigAuditSeverity = "error" | "warn";
export type ConfigAuditFinding = {
  severity: ConfigAuditSeverity;
  code: string;
  field: string;
  message: string;
};

export type ConfigAuditReport = {
  environment: AppEnvironment;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  findings: ConfigAuditFinding[];
  errorCount: number;
  warningCount: number;
};

const SECRET_FIELDS = [
  "APP_SECRET",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "VIEW_SALT",
  "API_KEY_SALT",
  "SECURITY_TELEMETRY_HASH_KEY",
  "CRON_SECRET",
  "SHARE_COOKIE_SECRET",
  "ADMIN_COOKIE_SECRET",
  "OIDC_SECRETS_KEY",
] as const;

const PLACEHOLDER_PATTERNS = [
  /^replace[_-]/i,
  /^example/i,
  /^changeme/i,
  /^placeholder/i,
  /^test[_-]/i,
  /dummy/i,
];

function normalizeText(value: string | undefined): string {
  const raw = String(value || "");
  if (/[\r\n\0]/.test(raw)) return "";
  return raw.trim();
}

function isTruthy(value: string | undefined): boolean {
  const raw = normalizeText(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function looksLikePlaceholder(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function inferEnvironment(env: NodeJS.ProcessEnv): AppEnvironment {
  const publicAppEnv = normalizeText(env.NEXT_PUBLIC_APP_ENV).toLowerCase();
  if (publicAppEnv === "staging") return "staging";
  if (publicAppEnv === "production") return "production";
  if (publicAppEnv === "test") return "test";
  if (publicAppEnv === "development") return "development";

  const vercelEnv = normalizeText(env.VERCEL_ENV).toLowerCase();
  if (vercelEnv === "preview") return "staging";
  if (vercelEnv === "production") return "production";

  const nodeEnv = normalizeText(env.NODE_ENV).toLowerCase();
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  return "development";
}

function addFinding(
  findings: ConfigAuditFinding[],
  severity: ConfigAuditSeverity,
  field: string,
  code: string,
  message: string
) {
  findings.push({ severity, field, code, message });
}

function validateUrl(
  findings: ConfigAuditFinding[],
  env: NodeJS.ProcessEnv,
  field: string,
  {
    required,
    requireHttps,
    disallowLoopback,
  }: { required: boolean; requireHttps: boolean; disallowLoopback: boolean }
) {
  const value = normalizeText(env[field]);
  if (!value) {
    if (required) {
      addFinding(findings, "error", field, "MISSING", `${field} is required in this environment.`);
    }
    return;
  }
  if (looksLikePlaceholder(value)) {
    addFinding(findings, "error", field, "PLACEHOLDER", `${field} still uses a placeholder-looking value.`);
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    addFinding(findings, "error", field, "INVALID_URL", `${field} must be a valid absolute URL.`);
    return;
  }

  if (requireHttps && parsed.protocol !== "https:") {
    addFinding(findings, "error", field, "HTTPS_REQUIRED", `${field} must use https in staging/production.`);
  }
  if (parsed.username || parsed.password) {
    addFinding(findings, "error", field, "EMBEDDED_CREDENTIALS", `${field} must not embed credentials.`);
  }
  if (disallowLoopback) {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      addFinding(findings, "error", field, "LOOPBACK_URL", `${field} must not point to loopback in staging/production.`);
    }
  }
}

function validateSecret(findings: ConfigAuditFinding[], env: NodeJS.ProcessEnv, field: string, required: boolean) {
  const value = normalizeText(env[field]);
  if (!value) {
    if (required) {
      addFinding(findings, "error", field, "MISSING", `${field} is required in this environment.`);
    }
    return;
  }
  if (value.length < 24) {
    addFinding(findings, "error", field, "TOO_SHORT", `${field} must be at least 24 characters long.`);
  }
  if (looksLikePlaceholder(value)) {
    addFinding(findings, "error", field, "PLACEHOLDER", `${field} still uses a placeholder-looking value.`);
  }
}

function validateEmail(findings: ConfigAuditFinding[], env: NodeJS.ProcessEnv, field: string, required: boolean) {
  const value = normalizeText(env[field]);
  if (!value) {
    if (required) {
      addFinding(findings, "error", field, "MISSING", `${field} is required in this environment.`);
    }
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    addFinding(findings, "error", field, "INVALID_EMAIL", `${field} must be a valid email address.`);
  }
}

function validateDeprecatedAliasUsage(findings: ConfigAuditFinding[], env: NodeJS.ProcessEnv) {
  const aliases: Array<{ preferred: string; alias: string; compare?: boolean }> = [
    { preferred: "R2_BUCKET", alias: "R2_BUCKET_NAME", compare: true },
    { preferred: "SUPPORT_EMAIL", alias: "CONTACT_EMAIL", compare: true },
    { preferred: "SECURITY_EMAIL", alias: "RESPONSIBLE_DISCLOSURE_EMAIL", compare: true },
    { preferred: "DMCA_EMAIL", alias: "DMCA_CONTACT_EMAIL", compare: true },
    { preferred: "EMAIL_FROM", alias: "RESEND_FROM", compare: true },
  ];

  for (const { preferred, alias, compare } of aliases) {
    const preferredValue = normalizeText(env[preferred]);
    const aliasValue = normalizeText(env[alias]);
    if (!aliasValue) continue;

    if (!preferredValue) {
      addFinding(
        findings,
        "warn",
        alias,
        "LEGACY_ALIAS_ONLY",
        `${alias} is set without ${preferred}. Prefer ${preferred} for new deployments and keep ${alias} only during migration windows.`
      );
      continue;
    }

    if (compare && preferredValue !== aliasValue) {
      addFinding(
        findings,
        "warn",
        alias,
        "LEGACY_ALIAS_MISMATCH",
        `${alias} does not match ${preferred}. ${preferred} is authoritative; align or remove the alias to reduce operator confusion.`
      );
    }
  }
}

export function auditRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ConfigAuditReport {
  const environment = inferEnvironment(env);
  const productionLike = environment === "production" || environment === "staging";
  const findings: ConfigAuditFinding[] = [];

  validateUrl(findings, env, "APP_URL", {
    required: productionLike,
    requireHttps: productionLike,
    disallowLoopback: productionLike,
  });
  validateUrl(findings, env, "NEXT_PUBLIC_APP_URL", {
    required: productionLike,
    requireHttps: productionLike,
    disallowLoopback: productionLike,
  });
  validateUrl(findings, env, "NEXTAUTH_URL", {
    required: productionLike,
    requireHttps: productionLike,
    disallowLoopback: productionLike,
  });
  validateUrl(findings, env, "R2_ENDPOINT", {
    required: productionLike,
    requireHttps: productionLike,
    disallowLoopback: productionLike,
  });
  const scannerConfiguration = readMalwareScannerConfiguration(env);
  if (scannerConfiguration.state !== "configured"
    && (productionLike || normalizeText(env.MALWARE_SCANNER_URL))) {
    const field = scannerConfiguration.reason === "client_id"
      ? "MALWARE_SCANNER_CLIENT_ID"
      : scannerConfiguration.reason === "hmac_secret"
      ? "MALWARE_SCANNER_HMAC_SECRET_HEX"
      : scannerConfiguration.reason === "timeout"
      ? "MALWARE_SCANNER_TIMEOUT_MS"
      : "MALWARE_SCANNER_URL";
    addFinding(
      findings,
      "error",
      field,
      scannerConfiguration.state === "missing" ? "MISSING" : "INVALID_SCANNER_CONFIG",
      "The OVHcloud malware scanner requires the approved /v1/scan URL, a valid client ID, a 64-character lowercase hexadecimal HMAC secret, and a 1-20 second timeout."
    );
  }

  for (const field of SECRET_FIELDS) {
    validateSecret(findings, env, field, productionLike);
  }
  validateSecret(findings, env, "R2_ACCESS_KEY_ID", productionLike);
  validateSecret(findings, env, "R2_SECRET_ACCESS_KEY", productionLike);
  validateSecret(findings, env, "BACKUP_STATUS_WEBHOOK_TOKEN", isTruthy(env.BACKUP_AUTOMATION_ENABLED));

  if (!normalizeText(env.DATABASE_URL)) {
    if (productionLike) {
      addFinding(findings, "error", "DATABASE_URL", "MISSING", "DATABASE_URL is required in this environment.");
    }
  } else {
    try {
      const parsed = new URL(normalizeText(env.DATABASE_URL));
      if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
        addFinding(findings, "error", "DATABASE_URL", "INVALID_PROTOCOL", "DATABASE_URL must use postgres/postgresql.");
      }
      if (productionLike && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) {
        addFinding(
          findings,
          "error",
          "DATABASE_URL",
          "LOOPBACK_URL",
          "DATABASE_URL must not point to loopback in staging/production."
        );
      }
    } catch {
      addFinding(findings, "error", "DATABASE_URL", "INVALID_URL", "DATABASE_URL must be a valid URL.");
    }
  }

  if (!normalizeText(env.R2_BUCKET)) {
    if (productionLike) {
      addFinding(findings, "error", "R2_BUCKET", "MISSING", "R2_BUCKET is required in this environment.");
    }
  } else if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,62})$/.test(normalizeText(env.R2_BUCKET))) {
    addFinding(findings, "error", "R2_BUCKET", "INVALID_BUCKET", "R2_BUCKET has an invalid bucket name.");
  }

  const allowedBuckets = normalizeText(env.R2_ALLOWED_BUCKETS)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (allowedBuckets.length && normalizeText(env.R2_BUCKET) && !allowedBuckets.includes(normalizeText(env.R2_BUCKET))) {
    addFinding(
      findings,
      "error",
      "R2_ALLOWED_BUCKETS",
      "BUCKET_NOT_ALLOWED",
      "R2_ALLOWED_BUCKETS must include the active R2_BUCKET."
    );
  }

  const docMasterKeys = normalizeText(env.DOC_MASTER_KEYS);
  if (!docMasterKeys) {
    if (productionLike) {
      addFinding(findings, "error", "DOC_MASTER_KEYS", "MISSING", "DOC_MASTER_KEYS is required in this environment.");
    }
  } else {
    const validation = validateDocMasterKeysConfig(docMasterKeys);
    if (!validation.ok) {
      addFinding(findings, "error", "DOC_MASTER_KEYS", "INVALID", validation.error);
    }
  }

  validateEmail(findings, env, "OWNER_EMAIL", productionLike);

  if (productionLike) {
    if (!isTruthy(env.ENABLE_STRICT_ENV_VALIDATION)) {
      addFinding(
        findings,
        "error",
        "ENABLE_STRICT_ENV_VALIDATION",
        "STRICT_VALIDATION_DISABLED",
        "ENABLE_STRICT_ENV_VALIDATION must stay enabled outside development."
      );
    }
    if (isTruthy(env.DEV_ALLOW_INSECURE_FALLBACK)) {
      addFinding(
        findings,
        "error",
        "DEV_ALLOW_INSECURE_FALLBACK",
        "INSECURE_FALLBACK_ENABLED",
        "DEV_ALLOW_INSECURE_FALLBACK must stay disabled in staging/production."
      );
    }
  }

  const stripeEnabled =
    isTruthy(env.PRO_PLAN_ENABLED) ||
    Boolean(normalizeText(env.STRIPE_SECRET_KEY)) ||
    Boolean(normalizeText(env.STRIPE_WEBHOOK_SECRET)) ||
    Boolean(normalizeText(env.STRIPE_PRO_PRICE_IDS));
  if (stripeEnabled) {
    validateSecret(findings, env, "STRIPE_SECRET_KEY", true);
    validateSecret(findings, env, "STRIPE_WEBHOOK_SECRET", true);
    if (!normalizeText(env.STRIPE_PRO_PRICE_IDS)) {
      addFinding(
        findings,
        "error",
        "STRIPE_PRO_PRICE_IDS",
        "MISSING",
        "STRIPE_PRO_PRICE_IDS is required when Stripe billing is enabled."
      );
    }
    if (environment === "production" && normalizeText(env.STRIPE_SECRET_KEY).startsWith("sk_test_")) {
      addFinding(findings, "error", "STRIPE_SECRET_KEY", "TEST_KEY", "Production must not use a Stripe test secret.");
    }
  }

  if (!isTruthy(env.BACKUP_AUTOMATION_ENABLED)) {
    if (productionLike) {
      addFinding(
        findings,
        "warn",
        "BACKUP_AUTOMATION_ENABLED",
        "BACKUP_AUTOMATION_DISABLED",
        "Automated backup reporting is disabled; operators should confirm an external backup cadence."
      );
    }
  }

  const backupMaxAgeHours = Number(normalizeText(env.BACKUP_MAX_AGE_HOURS) || "24");
  if (Number.isFinite(backupMaxAgeHours) && backupMaxAgeHours > 72) {
    addFinding(
      findings,
      "warn",
      "BACKUP_MAX_AGE_HOURS",
      "BACKUP_WINDOW_LARGE",
      "BACKUP_MAX_AGE_HOURS is unusually large for a security-sensitive production service."
    );
  }

  validateDeprecatedAliasUsage(findings, env);

  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warn").length;
  return {
    environment,
    ok: errorCount === 0,
    status: errorCount ? "fail" : warningCount ? "warn" : "pass",
    findings,
    errorCount,
    warningCount,
  };
}
