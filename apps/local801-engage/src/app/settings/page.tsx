import { AlertBanner, PageHeader, SectionCard, StatusBadge } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { getProductionLaunchState, type ProductionLaunchBlocker } from "@/lib/production-launch-policy";

const blockerLabels: Record<ProductionLaunchBlocker, string> = {
  NOT_VERCEL_PRODUCTION: "This deployment is not the Vercel Production environment.",
  LAUNCH_NOT_APPROVED: "The explicit production launch switch is off.",
  PRODUCTION_AUTH_DISABLED: "Production OIDC authentication is not runtime-enabled.",
  PREVIEW_AUTH_ENABLED: "Synthetic Preview authentication must be disabled.",
  SIGNUP_ENABLED: "Self-service signup must remain disabled.",
  MFA_NOT_ENFORCED: "MFA enforcement is not enabled for every production user.",
  PRODUCTION_ORGANIZATION_INVALID: "The production organization identifier is not approved.",
  APP_URL_INVALID: "The canonical production application origin is not configured.",
  NEXTAUTH_URL_INVALID: "The production authentication callback origin does not match the application origin.",
  NEXTAUTH_SECRET_WEAK: "The production authentication secret does not meet the minimum configuration policy.",
  OIDC_CONFIG_INVALID: "The production OIDC provider configuration is incomplete or invalid.",
  SCANNER_DISABLED: "The malware scanner is not enabled.",
  SCANNER_CONFIG_INVALID: "The malware scanner configuration is incomplete or invalid.",
  DATABASE_CONFIG_INVALID: "The production database configuration is missing, invalid, or not isolated.",
  STORAGE_CONFIG_INVALID: "The private production object-storage configuration is missing, invalid, or not isolated.",
  ENCRYPTION_CONFIG_INVALID: "The production object-encryption keyring is not configured.",
  PII_KEY_CONFIG_INVALID: "The separate PII encryption and blind-index keyrings are missing, invalid, or reuse key material.",
  PII_PROTECTION_NOT_VERIFIED: "Database PII protection has not passed its production acceptance gate.",
  BACKUP_RESTORE_NOT_VERIFIED: "A production backup restore test has not been recorded as verified.",
  SECURITY_REVIEW_NOT_APPROVED: "The final production security review has not been approved.",
  SECURITY_REVIEW_ID_MISSING: "A production security-review/change reference has not been recorded.",
  PREVIEW_ONLY_IMPORT_EXECUTION_ENABLED: "The Preview-only authoritative import execution gate must be off.",
  PREVIEW_ONLY_DURABLE_IMPORTS_ENABLED: "The Preview-only durable import gate must be off.",
  SYNTHETIC_SEED_ENABLED: "The synthetic seed opt-in must not be enabled in production.",
};

export default function SettingsPage() {
  const launch = getProductionLaunchState();
  return <ProtectedPage permission="manageUsers"><div className="content">
    <PageHeader eyebrow="Administration" title="Settings" description="Review environment and security posture without exposing secrets or presenting inactive controls as functional." />
    <AlertBanner title="Real-data launch remains locked" tone="preview">Synthetic Preview can continue normally. Production authentication and real member data remain fail-closed until every Stage 14 production gate is satisfied.</AlertBanner>
    <SectionCard title="Security defaults" badge={<StatusBadge tone="ready">Fail closed</StatusBadge>}>
      <p className="page-copy">Dedicated database configuration, encrypted private storage, organization scoping, same-origin mutation checks, server authorization, MFA-backed production identity, and malware scanning remain enforced by server-side boundaries. Configuration values are never rendered.</p>
    </SectionCard>
    <SectionCard title="Production launch gate" badge={<StatusBadge tone={launch.ready ? "ready" : "blocked"}>{launch.ready ? "Ready" : "Locked"}</StatusBadge>}>
      <p className="page-copy">This view reports only safe readiness states and blocker names. It never displays credentials, key material, connection strings, provider subjects, or scanner secrets.</p>
      {launch.ready ? <p className="page-copy"><strong>All coded launch gates are satisfied.</strong> Operational approval is still governed by the production-readiness checklist.</p> : (
        <ul>
          {launch.blockers.map((blocker) => <li key={blocker}>{blockerLabels[blocker]}</li>)}
        </ul>
      )}
    </SectionCard>
  </div></ProtectedPage>;
}