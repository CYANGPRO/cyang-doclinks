import { AlertBanner, DisclosureCard, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { getProductionLaunchState, type ProductionLaunchBlocker } from "@/lib/production-launch-policy";

const blockerLabels: Record<ProductionLaunchBlocker, string> = {
  NOT_VERCEL_PRODUCTION: "This deployment is not the Vercel Production environment.",
  LAUNCH_NOT_APPROVED: "The explicit production launch switch is off.",
  PRODUCTION_AUTH_DISABLED: "Production OIDC authentication is not runtime-enabled.",
  PREVIEW_AUTH_ENABLED: "Preview authentication must be disabled.",
  SIGNUP_ENABLED: "Self-service signup must remain disabled.",
  MFA_NOT_ENFORCED: "MFA enforcement is not enabled for every production user.",
  PRODUCTION_ORGANIZATION_INVALID: "The production organization identifier is not approved.",
  APP_URL_INVALID: "The canonical production application origin is not configured.",
  NEXTAUTH_URL_INVALID: "The production authentication callback origin does not match the application origin.",
  NEXTAUTH_SECRET_WEAK: "The production authentication secret does not meet the minimum configuration policy.",
  OIDC_CONFIG_INVALID: "The production OIDC provider configuration is incomplete or invalid.",
  ENTRA_PROVISIONING_CONFIG_INVALID: "Automated Microsoft Entra user onboarding is incomplete or invalid.",
  SCANNER_DISABLED: "The malware scanner is not enabled.",
  SCANNER_CONFIG_INVALID: "The malware scanner configuration is incomplete or invalid.",
  SENTRY_CONFIG_INVALID: "Privacy-scrubbed Production error reporting is disabled or its Sentry DSN is invalid.",
  PUSH_CONFIG_INVALID: "Browser push is disabled or its owner-controlled VAPID configuration is invalid.",
  MOBILE_CONFIG_INVALID: "Native mobile is enabled, but its attestation or push gateways, signing identifiers, or owner-controlled secrets are incomplete.",
  DATABASE_CONFIG_INVALID: "The production database configuration is missing, invalid, or not isolated.",
  DATABASE_TLS_NOT_REQUIRED: "The production database connection does not explicitly require TLS.",
  STORAGE_CONFIG_INVALID: "The private production object-storage configuration is missing, invalid, or not isolated.",
  ENCRYPTION_CONFIG_INVALID: "The production object-encryption keyring is not configured.",
  PII_KEY_CONFIG_INVALID: "The separate PII encryption and blind-index keyrings are missing, invalid, or reuse key material.",
  PII_PROTECTION_NOT_VERIFIED: "Database PII protection has not passed its production acceptance gate.",
  BACKUP_RESTORE_NOT_VERIFIED: "A production backup restore test has not been recorded as verified.",
  DISTRIBUTED_RATE_LIMITS_DISABLED: "The production PostgreSQL distributed rate limiter has not been enabled and accepted.",
  SECURITY_REVIEW_NOT_APPROVED: "The final production security review has not been approved.",
  SECURITY_REVIEW_ID_MISSING: "A production security-review/change reference has not been recorded.",
  PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED: "The Preview-only import approval setting must be off.",
  PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED: "The Preview-only background import setting must be off.",
  PROTECTED_DURABLE_IMPORTS_DISABLED: "Protected background import processing must be enabled.",
  RATE_LIMIT_CONFIG_INVALID: "One or more production request-rate limits are missing or outside the approved safety range.",
  SYNTHETIC_SEED_ENABLED: "Test-data seeding must not be enabled in Production.",
  SYNTHETIC_PRODUCTION_PILOT_ENABLED: "Production pilot mode must be disabled before launch.",
  SYNTHETIC_DATA_ONLY_ENABLED: "The test-data-only assertion must be disabled before launch.",
};

export default function SettingsPage() {
  const launch = getProductionLaunchState();
  return <ProtectedPage permission="manageUsers"><div className="content">
    <PageHeader eyebrow="Administration" title="Settings" description="Review CAT’s Production security checks. Credentials, keys, and connection details are never shown here." />
    {launch.ready
      ? <AlertBanner title="Production is enabled">CAT is running in Production with Microsoft Entra sign-in and the required server protections.</AlertBanner>
      : <AlertBanner title="Production launch remains locked" tone="preview">Preview can continue. Production sign-in and member data will stay unavailable until every required security check passes.</AlertBanner>}
    <SectionCard title="Security defaults" badge={<StatusBadge tone="ready">Fail closed</StatusBadge>}>
      <p className="page-copy">CAT uses a dedicated database, encrypted private storage, organization and role checks, same-site change protection, Microsoft MFA, and malware scanning. These protections are enforced on the server, and their secret settings are never displayed.</p>
    </SectionCard>
    <SectionCard title="Production launch gate" badge={<StatusBadge tone={launch.ready ? "ready" : "blocked"}>{launch.ready ? "Ready" : "Locked"}</StatusBadge>}>
      <p className="page-copy">This page shows whether each launch check passed and names anything still blocking launch. It never displays credentials, encryption keys, connection strings, Microsoft identifiers, or scanner secrets.</p>
      {launch.ready ? <p className="page-copy"><strong>All automated launch checks passed.</strong> CAT still checks the user’s organization, role, request origin, rate limits, audit rules, protected data, file scans, and storage access during normal use.</p> : (
        <ul>
          {launch.blockers.map((blocker) => <li key={blocker}>{blockerLabels[blocker]}</li>)}
        </ul>
      )}
    </SectionCard>
    <DisclosureCard title="Security defaults" description="Review the protections that block access when required security configuration is missing." className="route-secondary-panel settings-reference-panel">
      <p className="page-copy">Engaging Local 801 keeps the database and storage private, encrypts stored files and protected member data, checks access on the server, requires same-origin changes, uses MFA-backed production identity, and scans uploads for malware. Secret configuration values are never shown here.</p>
    </DisclosureCard>
  </div></ProtectedPage>;
}
