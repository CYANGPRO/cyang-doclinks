export const INTENTIONAL_EXTRA_ENV_GROUPS = {
  compatibilityAliases: {
    description: "Legacy aliases kept only to support controlled migration windows and env-name transitions.",
    keys: [
      "AUTH_SECRET",
      "CUSTOM_HASH_SALT",
      "FORCE_R2_SSE",
      "RESEND_FROM",
      "SHARE_SALT",
    ],
  },
  publicBrandAndProductShell: {
    description: "Public-shell and pricing flags that may be consumed at runtime or deployment boundaries rather than static imports.",
    keys: [
      "BRAND_NAME",
      "BRAND_PRIMARY_COLOR",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    ],
  },
  deployOnlyProviderInputs: {
    description: "Provider or deployment metadata required for real environments even when a local proof run uses placeholders.",
    keys: [
      "ADMIN_COOKIE_SECRET",
      "ADMIN_PASSWORD",
      "LIVE_RESTORE_TARGET_BASE_URL",
      "LIVE_RUNTIME_BASE_URL",
      "LIVE_RUNTIME_STRIPE_PRICE_ID",
      "LIVE_RUNTIME_STRIPE_TIMEOUT_SECONDS",
      "LIVE_RUNTIME_UPLOAD_SCAN_TIMEOUT_SECONDS",
      "R2_ACCOUNT_ID",
    ],
  },
  optionalOpsTuning: {
    description: "Operational knobs that are intentionally available for tuning, incident response, or deploy-specific caching behavior.",
    keys: [
      "ANALYTICS_AGGREGATE_DAYS_BACK",
      "SKIP_ENV_LOCAL_BOOTSTRAP",
      "VERIFY_LOCAL_RUNTIME",
    ],
  },
};

export function flattenIntentionalExtraEnvKeys() {
  return new Set(
    Object.values(INTENTIONAL_EXTRA_ENV_GROUPS).flatMap((group) => group.keys)
  );
}
