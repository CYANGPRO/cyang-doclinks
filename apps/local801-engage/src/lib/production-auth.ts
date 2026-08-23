import "server-only";

import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { Role } from "./access.ts";

const subjectPattern = /^[\x21-\x7e]{1,255}$/;
const providerPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ProductionAuthConfig = {
  enabled: boolean;
  organizationSlug: string;
  providerId: string;
  providerName: string;
  wellKnown: string;
  clientId: string;
  clientSecret: string;
  mfaClaim: "amr" | "acr";
  mfaValue: string;
};

export type ProductionIdentity = {
  providerId: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  mfaVerified: boolean;
};

export type ProductionAuthBinding = {
  organizationSlug: string;
  userId: string;
  email: string;
  role: Role;
  sessionVersion: number;
};

type BindingRow = {
  organization_slug: string;
  user_id: string;
  email: string;
  auth_session_version: number | string;
  role: string;
  linked_subject: string | null;
};

export class ProductionAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductionAuthError";
    this.code = code;
  }
}

const safeProductionAuthCodes = new Set([
  "AUTH_CONFIG_INVALID",
  "AUTH_DISABLED",
  "EMAIL_NOT_VERIFIED",
  "EMAIL_REQUIRED",
  "IDENTITY_INVALID",
  "IDENTITY_MISMATCH",
  "MFA_REQUIRED",
  "PROTECTED_PII_INVALID",
  "USER_NOT_PROVISIONED",
]);

export function productionAuthSafeCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "AUTHORIZATION_FAILED";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && safeProductionAuthCodes.has(code) ? code : "AUTHORIZATION_FAILED";
}

function nonempty(value: string | undefined) {
  return value?.trim() ?? "";
}

export function getProductionAuthConfig(env: NodeJS.ProcessEnv = process.env): ProductionAuthConfig {
  const enabled = env.LOCAL801_PRODUCTION_AUTH_ENABLED === "1";
  const organizationSlug = nonempty(env.LOCAL801_ORGANIZATION_SLUG);
  const providerId = nonempty(env.LOCAL801_OIDC_PROVIDER_ID) || "local801-oidc";
  const providerName = nonempty(env.LOCAL801_OIDC_PROVIDER_NAME) || "Organization sign-in";
  const wellKnown = nonempty(env.LOCAL801_OIDC_WELL_KNOWN);
  const clientId = nonempty(env.LOCAL801_OIDC_CLIENT_ID);
  const clientSecret = nonempty(env.LOCAL801_OIDC_CLIENT_SECRET);
  const mfaClaim = env.LOCAL801_OIDC_MFA_CLAIM === "acr" ? "acr" : "amr";
  const mfaValue = nonempty(env.LOCAL801_OIDC_MFA_VALUE) || "mfa";

  if (enabled) {
    if (!organizationSlug || organizationSlug.length > 80) throw new ProductionAuthError("AUTH_CONFIG_INVALID", "LOCAL801_ORGANIZATION_SLUG is required when production authentication is enabled.");
    if (!providerPattern.test(providerId)) throw new ProductionAuthError("AUTH_CONFIG_INVALID", "LOCAL801_OIDC_PROVIDER_ID is invalid.");
    if (!wellKnown.startsWith("https://")) throw new ProductionAuthError("AUTH_CONFIG_INVALID", "LOCAL801_OIDC_WELL_KNOWN must be an HTTPS URL.");
    if (!clientId || !clientSecret) throw new ProductionAuthError("AUTH_CONFIG_INVALID", "OIDC client credentials are required when production authentication is enabled.");
    if (!mfaValue || mfaValue.length > 120) throw new ProductionAuthError("AUTH_CONFIG_INVALID", "LOCAL801_OIDC_MFA_VALUE is invalid.");
  }

  return { enabled, organizationSlug, providerId, providerName, wellKnown, clientId, clientSecret, mfaClaim, mfaValue };
}

function claimString(profile: Record<string, unknown>, key: string) {
  const value = profile[key];
  return typeof value === "string" ? value : "";
}

export function profileHasRequiredMfa(profile: Record<string, unknown>, config: Pick<ProductionAuthConfig, "mfaClaim" | "mfaValue">) {
  const value = profile[config.mfaClaim];
  if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && entry === config.mfaValue);
  return typeof value === "string" && (config.mfaClaim === "amr" ? value.split(/\s+/).includes(config.mfaValue) : value === config.mfaValue);
}

export function productionIdentityFromProfile(profile: Record<string, unknown>, config: ProductionAuthConfig): ProductionIdentity {
  const subject = claimString(profile, "sub");
  const standardEmail = claimString(profile, "email").trim().toLowerCase();
  const authoritativeEmail = claimString(profile, "verified_primary_email").trim().toLowerCase();
  const email = standardEmail || authoritativeEmail;
  const emailVerified = profile.email_verified === true
    || (authoritativeEmail.length > 0 && authoritativeEmail === email);
  const mfaVerified = profileHasRequiredMfa(profile, config);
  if (!subjectPattern.test(subject)) throw new ProductionAuthError("IDENTITY_INVALID", "The identity provider did not return a valid subject identifier.");
  if (!emailPattern.test(email) || email.length > 320) throw new ProductionAuthError("EMAIL_REQUIRED", "A valid identity-provider email address is required.");
  if (!emailVerified) throw new ProductionAuthError("EMAIL_NOT_VERIFIED", "The identity provider must verify the sign-in email address.");
  if (!mfaVerified) throw new ProductionAuthError("MFA_REQUIRED", "The identity provider did not provide the required MFA assurance claim.");
  return { providerId: config.providerId, subject, email, emailVerified, mfaVerified };
}

function asRole(value: string): Role | null {
  return value === "system_owner" || value === "local_admin" || value === "membership_data_manager"
    || value === "cat_admin" || value === "cat_lead" || value === "cat_member" || value === "report_viewer"
    ? value : null;
}

export async function authorizeProductionIdentity(
  identity: ProductionIdentity,
  config: ProductionAuthConfig,
  dependencies: {
    query?: DatabaseQuery;
    transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  } = {},
): Promise<ProductionAuthBinding> {
  if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") {
    const { authorizeProtectedProductionIdentity } = await import("./pii-protected-production-auth.ts");
    return authorizeProtectedProductionIdentity(identity, config, dependencies);
  }
  if (!config.enabled) throw new ProductionAuthError("AUTH_DISABLED", "Production authentication is disabled.");
  if (identity.providerId !== config.providerId || !identity.emailVerified || !identity.mfaVerified) {
    throw new ProductionAuthError("IDENTITY_INVALID", "The production identity did not satisfy the configured assurance requirements.");
  }
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const rows = await query<BindingRow>(`
    /* production-auth:resolve-active-user */
    SELECT organization.slug AS organization_slug, app_user.id AS user_id, app_user.email,
      app_user.auth_session_version, role.code AS role, identity.provider_subject AS linked_subject
    FROM local801.organizations organization
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
     AND app_user.deactivated_at IS NULL
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = organization.id
    LEFT JOIN local801.auth_identities identity
      ON identity.organization_id = organization.id
     AND identity.user_id = app_user.id
     AND identity.provider_id = $3::text
    WHERE organization.slug = $1::text
      AND organization.archived_at IS NULL
      AND lower(app_user.email) = lower($2::text)
    LIMIT 2
  `, [config.organizationSlug, identity.email, identity.providerId]);
  if (rows.length !== 1) throw new ProductionAuthError("USER_NOT_PROVISIONED", "No unique active Local 801 account is provisioned for this identity.");
  const row = rows[0];
  const role = asRole(row.role);
  const sessionVersion = Number(row.auth_session_version);
  if (!role || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) throw new ProductionAuthError("USER_NOT_PROVISIONED", "The Local 801 account is not provisioned with one valid role.");
  if (row.linked_subject && row.linked_subject !== identity.subject) {
    throw new ProductionAuthError("IDENTITY_MISMATCH", "This Local 801 account is already linked to a different identity-provider subject.");
  }

  const bindIdentity: DatabaseStatement = {
    sql: `
      WITH target AS (
        SELECT organization.id AS organization_id, app_user.id AS user_id
        FROM local801.organizations organization
        JOIN local801.users app_user
          ON app_user.organization_id = organization.id
         AND app_user.deactivated_at IS NULL
        WHERE organization.slug = $1::text
          AND organization.archived_at IS NULL
          AND app_user.id = $2::uuid
          AND lower(app_user.email) = lower($5::text)
      ), linked AS (
        INSERT INTO local801.auth_identities
          (organization_id, user_id, provider_id, provider_subject, linked_email, linked_at, last_sign_in_at)
        SELECT target.organization_id, target.user_id, $3::text, $4::text, lower($5::text), now(), now()
        FROM target
        ON CONFLICT (organization_id, user_id, provider_id) DO UPDATE
          SET linked_email = excluded.linked_email, last_sign_in_at = now()
          WHERE local801.auth_identities.provider_subject = excluded.provider_subject
        RETURNING id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS identity_linked
      FROM linked
    `,
    parameters: [config.organizationSlug, row.user_id, identity.providerId, identity.subject, identity.email],
  };
  const markAuthentication: DatabaseStatement = {
    sql: `
      WITH updated AS (
        UPDATE local801.users app_user
        SET last_authenticated_at = now(), last_mfa_at = now()
        FROM local801.organizations organization
        WHERE app_user.id = $2::uuid
          AND app_user.organization_id = organization.id
          AND organization.slug = $1::text
          AND organization.archived_at IS NULL
          AND app_user.deactivated_at IS NULL
          AND app_user.auth_session_version = $3::integer
        RETURNING app_user.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS authentication_marked
      FROM updated
    `,
    parameters: [config.organizationSlug, row.user_id, sessionVersion],
  };
  await transaction([bindIdentity, markAuthentication]);
  return { organizationSlug: row.organization_slug, userId: row.user_id, email: row.email, role, sessionVersion };
}

export async function resolveProductionSessionBinding(
  session: { organizationSlug: string; userId: string; sessionVersion: number },
  query: DatabaseQuery = queryLocal801,
): Promise<ProductionAuthBinding | null> {
  if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") {
    const { resolveProtectedProductionSessionBinding } = await import("./pii-protected-production-auth.ts");
    return resolveProtectedProductionSessionBinding(session, query);
  }
  if (!session.organizationSlug || !session.userId || !Number.isSafeInteger(session.sessionVersion)) return null;
  const rows = await query<BindingRow>(`
    /* production-auth:validate-session */
    SELECT organization.slug AS organization_slug, app_user.id AS user_id, app_user.email,
      app_user.auth_session_version, role.code AS role, NULL::text AS linked_subject
    FROM local801.organizations organization
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
     AND app_user.deactivated_at IS NULL
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
     AND role.organization_id = organization.id
    WHERE organization.slug = $1::text
      AND organization.archived_at IS NULL
      AND app_user.id = $2::uuid
      AND app_user.auth_session_version = $3::integer
    LIMIT 2
  `, [session.organizationSlug, session.userId, session.sessionVersion]);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const role = asRole(row.role);
  const sessionVersion = Number(row.auth_session_version);
  return role && sessionVersion === session.sessionVersion
    ? { organizationSlug: row.organization_slug, userId: row.user_id, email: row.email, role, sessionVersion }
    : null;
}

export const __testing = { asRole, providerPattern, safeProductionAuthCodes, subjectPattern };
