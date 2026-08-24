import "server-only";

import { roleLabels, type Role } from "./access.ts";
import { CURRENT_ACCESS_POLICY } from "./policy-contract.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_APP_ROLE_ID = "00000000-0000-0000-0000-000000000000";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const MAX_ASSIGNMENT_PAGES = 20;
const MAX_ASSIGNMENT_RECORDS = 5_000;

const roleIntroductions: Record<Role, string> = {
  system_owner: "Full system governance, user access, protected data, configuration, reports, and audit oversight.",
  local_admin: "User administration and broad operational access, excluding System Owner-only controls.",
  membership_data_manager: "Membership records, protected imports, data quality, documents, and authorized reports.",
  cat_admin: "CAT programs, campaigns, actions, team coordination, documents, and authorized reports.",
  cat_lead: "Assigned-team coordination, member outreach, follow-ups, documents, and authorized reports.",
  cat_member: "Assigned member outreach, follow-ups, directory access, and CAT-member documents.",
  report_viewer: "Authenticated access to approved summary reports; no roster editing or person-level exports.",
};

export type EntraProvisioningConfig = {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  enterpriseAppObjectId: string;
  appRoleId: string;
  appUrl: string;
  supportEmail: string;
};

export type EntraOnboardingTarget = {
  organizationId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
};

type InvitationResponse = {
  status?: unknown;
  invitedUser?: { id?: unknown };
};

type AssignmentListResponse = {
  value?: unknown;
  "@odata.nextLink"?: unknown;
};

type AssignmentEntry = {
  appRoleId?: unknown;
  principalId?: unknown;
  resourceId?: unknown;
};

type OnboardingRow = {
  provider_user_id: string | null;
  status: string;
};

export class EntraOnboardingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "EntraOnboardingError";
    this.code = code;
    this.status = status;
  }
}

function value(input: string | undefined) {
  return input?.trim() ?? "";
}

export function getEntraProvisioningConfig(env: NodeJS.ProcessEnv = process.env): EntraProvisioningConfig {
  const enabled = env.LOCAL801_ENTRA_USER_PROVISIONING_ENABLED === "1";
  const tenantId = value(env.LOCAL801_OIDC_TENANT_ID).toLowerCase();
  const clientId = value(env.LOCAL801_OIDC_CLIENT_ID).toLowerCase();
  const clientSecret = value(env.LOCAL801_OIDC_CLIENT_SECRET);
  const enterpriseAppObjectId = value(env.LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID).toLowerCase();
  const appRoleId = (value(env.LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID) || DEFAULT_APP_ROLE_ID).toLowerCase();
  const appUrl = value(env.LOCAL801_APP_URL);
  const supportEmail = value(env.LOCAL801_ACCESS_SUPPORT_EMAIL).toLowerCase();

  if (enabled) {
    if (![tenantId, clientId, enterpriseAppObjectId].every((entry) => UUID_RE.test(entry))
      || (appRoleId !== DEFAULT_APP_ROLE_ID && !UUID_RE.test(appRoleId))
      || !clientSecret) {
      throw new EntraOnboardingError("ENTRA_PROVISIONING_CONFIG_INVALID", "Automated Microsoft Entra onboarding is not configured correctly.");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(appUrl);
    } catch {
      throw new EntraOnboardingError("ENTRA_PROVISIONING_CONFIG_INVALID", "Automated Microsoft Entra onboarding is not configured correctly.");
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw new EntraOnboardingError("ENTRA_PROVISIONING_CONFIG_INVALID", "Automated Microsoft Entra onboarding is not configured correctly.");
    }
    if (!EMAIL_RE.test(supportEmail) || supportEmail.length > 320) {
      throw new EntraOnboardingError("ENTRA_PROVISIONING_CONFIG_INVALID", "A valid CAT access-support email is required for onboarding invitations.");
    }
  }

  return { enabled, tenantId, clientId, clientSecret, enterpriseAppObjectId, appRoleId, appUrl, supportEmail };
}

export function buildOnboardingInvitationMessage(target: Pick<EntraOnboardingTarget, "displayName" | "email" | "role">, config: Pick<EntraProvisioningConfig, "appUrl" | "supportEmail">) {
  return [
    `${target.displayName},`,
    "",
    "You have been approved for Engaging Local 801.",
    `Assigned role: ${roleLabels[target.role]}`,
    `Role access: ${roleIntroductions[target.role]}`,
    "",
    "Complete these steps:",
    "1. Use the invitation link in this email. It is personal to you and must not be forwarded.",
    `2. Sign in with exactly ${target.email}. Microsoft may use your existing account or send a one-time email code. CAT never creates or emails a password.`,
    "3. Complete Microsoft multifactor authentication when prompted.",
    `4. Continue to ${config.appUrl}/sign-in and accept ${CURRENT_ACCESS_POLICY.title} (${CURRENT_ACCESS_POLICY.version}) before using the workspace.`,
    "",
    "By accessing the workspace, you agree to use it only for authorized Local 801 work; protect member and employee information; avoid shared accounts, forwarded invitations, and unapproved offline copies; follow records, privacy, and incident-reporting requirements; and understand that security-relevant activity is audited. Your access is limited to the assigned CAT role and may be changed or revoked.",
    "",
    `If you were not expecting this invitation, do not redeem it. Contact ${config.supportEmail}. For access, MFA, or role questions, use that same support address.`,
  ].join("\n");
}

async function safeGraphCode(response: Response) {
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(code) ? code.toUpperCase().replace(/[.-]/g, "_") : null;
  } catch {
    return null;
  }
}

async function graphFailure(response: Response, operation: "TOKEN" | "INVITATION" | "ASSIGNMENT" | "ASSIGNMENT_CHECK") {
  const graphCode = await safeGraphCode(response);
  const unavailable = response.status === 429 || response.status >= 500;
  const code = unavailable ? `ENTRA_${operation}_UNAVAILABLE` : `ENTRA_${operation}_REJECTED`;
  console.error("[local801-entra-safe-failure]", JSON.stringify({
    operation,
    status: response.status,
    graphCode: graphCode ?? "UNAVAILABLE",
  }));
  if (graphCode === "AUTHORIZATION_REQUESTDENIED") {
    return new EntraOnboardingError(`${code}_${graphCode}`.slice(0, 80),
      "Microsoft Entra application permission consent is incomplete. An Entra administrator must confirm the approved Microsoft Graph application permissions and grant admin consent, then retry onboarding.", 502);
  }
  if (graphCode === "REQUEST_UNSUPPORTEDQUERY") {
    return new EntraOnboardingError(`${code}_${graphCode}`.slice(0, 80),
      "Microsoft Entra rejected CAT’s application-assignment query. No admin-consent change is required. The CAT application must be updated before onboarding is retried.", 502);
  }
  return new EntraOnboardingError(graphCode ? `${code}_${graphCode}`.slice(0, 80) : code, unavailable
    ? "Microsoft Entra is temporarily unavailable. The CAT account is saved; retry onboarding from Team & Access."
    : "Microsoft Entra rejected the onboarding request. Review the provisioning configuration and retry from Team & Access.", unavailable ? 503 : 502);
}

async function accessToken(config: EntraProvisioningConfig, fetcher: typeof fetch) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  let response: Response;
  try {
    response = await fetcher(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EntraOnboardingError("ENTRA_TOKEN_UNAVAILABLE", "Microsoft Entra is temporarily unavailable. The CAT account is saved; retry onboarding from Team & Access.");
  }
  if (!response.ok) throw await graphFailure(response, "TOKEN");
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length < 20) {
    throw new EntraOnboardingError("ENTRA_TOKEN_INVALID", "Microsoft Entra returned an invalid provisioning response.");
  }
  return payload.access_token;
}

async function graphJson(url: string, init: RequestInit, operation: "INVITATION" | "ASSIGNMENT" | "ASSIGNMENT_CHECK", fetcher: typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new EntraOnboardingError(`ENTRA_${operation}_UNAVAILABLE`, "Microsoft Entra is temporarily unavailable. The CAT account is saved; retry onboarding from Team & Access.");
  }
  if (!response.ok) throw await graphFailure(response, operation);
  return response.status === 204 ? {} : response.json() as Promise<unknown>;
}

async function inviteGuest(target: EntraOnboardingTarget, config: EntraProvisioningConfig, token: string, fetcher: typeof fetch) {
  const payload = await graphJson(`${GRAPH_ROOT}/invitations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      invitedUserEmailAddress: target.email,
      invitedUserDisplayName: target.displayName,
      inviteRedirectUrl: `${config.appUrl.replace(/\/$/, "")}/sign-in`,
      invitedUserType: "Guest",
      sendInvitationMessage: true,
      invitedUserMessageInfo: {
        messageLanguage: "en-US",
        customizedMessageBody: buildOnboardingInvitationMessage(target, config),
      },
    }),
  }, "INVITATION", fetcher) as InvitationResponse;
  const providerUserId = payload.invitedUser?.id;
  if (typeof providerUserId !== "string" || !UUID_RE.test(providerUserId)) {
    throw new EntraOnboardingError("ENTRA_INVITATION_INVALID", "Microsoft Entra returned an invalid invitation response.");
  }
  return { providerUserId: providerUserId.toLowerCase(), invitationStatus: typeof payload.status === "string" ? payload.status.slice(0, 80) : "PendingAcceptance" };
}

function normalizedUuid(input: unknown) {
  return typeof input === "string" && UUID_RE.test(input) ? input.toLowerCase() : null;
}

function normalizedAppRoleId(input: unknown) {
  if (typeof input !== "string") return null;
  const normalized = input.toLowerCase();
  return normalized === DEFAULT_APP_ROLE_ID || UUID_RE.test(normalized) ? normalized : null;
}

function exactAssignment(entry: AssignmentEntry, providerUserId: string, config: EntraProvisioningConfig) {
  return normalizedUuid(entry.principalId) === providerUserId
    && normalizedAppRoleId(entry.appRoleId) === config.appRoleId
    && normalizedUuid(entry.resourceId) === config.enterpriseAppObjectId;
}

function assignmentNextLink(input: unknown, config: EntraProvisioningConfig) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || input.length > 4_096) {
    throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_INVALID", "Microsoft Entra returned an invalid application-assignment response. The CAT account is saved; retry after the CAT application is updated.", 502);
  }
  let next: URL;
  try {
    next = new URL(input);
  } catch {
    throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_INVALID", "Microsoft Entra returned an invalid application-assignment response. The CAT account is saved; retry after the CAT application is updated.", 502);
  }
  const expectedPath = `/v1.0/servicePrincipals/${config.enterpriseAppObjectId}/appRoleAssignedTo`.toLowerCase();
  if (next.protocol !== "https:" || next.hostname !== "graph.microsoft.com" || next.port
    || next.username || next.password || next.hash || next.pathname.toLowerCase() !== expectedPath) {
    throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_INVALID", "Microsoft Entra returned an invalid application-assignment response. The CAT account is saved; retry after the CAT application is updated.", 502);
  }
  return next.toString();
}

async function ensureEnterpriseAppAssignment(providerUserId: string, config: EntraProvisioningConfig, token: string, fetcher: typeof fetch) {
  const collectionUrl = `${GRAPH_ROOT}/servicePrincipals/${config.enterpriseAppObjectId}/appRoleAssignedTo`;
  const visited = new Set<string>();
  let nextUrl: string | null = collectionUrl;
  let assignmentCount = 0;
  let pageCount = 0;
  while (nextUrl) {
    if (pageCount >= MAX_ASSIGNMENT_PAGES) {
      throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_LIMIT", "Microsoft Entra returned more application assignments than CAT can verify safely. The CAT account is saved; an administrator must review the enterprise application before retrying.", 502);
    }
    if (visited.has(nextUrl)) {
      throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_INVALID", "Microsoft Entra returned an invalid application-assignment response. The CAT account is saved; retry after the CAT application is updated.", 502);
    }
    visited.add(nextUrl);
    pageCount += 1;
    const list = await graphJson(
      nextUrl,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      "ASSIGNMENT_CHECK",
      fetcher,
    ) as AssignmentListResponse;
    if (!Array.isArray(list.value)) {
      throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_INVALID", "Microsoft Entra returned an invalid application-assignment response. The CAT account is saved; retry after the CAT application is updated.", 502);
    }
    assignmentCount += list.value.length;
    if (assignmentCount > MAX_ASSIGNMENT_RECORDS) {
      throw new EntraOnboardingError("ENTRA_ASSIGNMENT_CHECK_LIMIT", "Microsoft Entra returned more application assignments than CAT can verify safely. The CAT account is saved; an administrator must review the enterprise application before retrying.", 502);
    }
    if (list.value.some((entry) => entry !== null && typeof entry === "object"
      && exactAssignment(entry as AssignmentEntry, providerUserId, config))) return;
    nextUrl = assignmentNextLink(list["@odata.nextLink"], config);
  }
  await graphJson(`${GRAPH_ROOT}/servicePrincipals/${config.enterpriseAppObjectId}/appRoleAssignedTo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      principalId: providerUserId,
      resourceId: config.enterpriseAppObjectId,
      appRoleId: config.appRoleId,
    }),
  }, "ASSIGNMENT", fetcher);
}

async function markFailure(target: EntraOnboardingTarget, code: string, query: DatabaseQuery) {
  await query(`
    UPDATE local801.user_identity_onboarding
    SET status = 'failed', last_error_code = $3::text, completed_at = NULL
    WHERE organization_id = $1::uuid AND user_id = $2::uuid
  `, [target.organizationId, target.userId, code]);
}

export async function onboardTeamMemberWithEntra(
  target: EntraOnboardingTarget,
  dependencies: { query?: DatabaseQuery; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const fetcher = dependencies.fetch ?? fetch;
  const config = getEntraProvisioningConfig(dependencies.env ?? process.env);
  if (!config.enabled) {
    throw new EntraOnboardingError("ENTRA_PROVISIONING_DISABLED", "Automated Microsoft Entra onboarding is not enabled.");
  }

  await query(`
    INSERT INTO local801.user_identity_onboarding (organization_id, user_id, status)
    VALUES ($1::uuid, $2::uuid, 'pending')
    ON CONFLICT (user_id) DO NOTHING
  `, [target.organizationId, target.userId]);

  const [claimed] = await query<OnboardingRow>(`
    UPDATE local801.user_identity_onboarding onboarding
    SET status = 'processing', last_attempted_at = now(), attempt_count = attempt_count + 1, last_error_code = NULL, completed_at = NULL
    WHERE onboarding.organization_id = $1::uuid
      AND onboarding.user_id = $2::uuid
      AND EXISTS (
        SELECT 1
        FROM local801.users target_user
        WHERE target_user.organization_id = onboarding.organization_id
          AND target_user.id = onboarding.user_id
          AND target_user.deactivated_at IS NULL
      )
      AND (
        onboarding.status IN ('pending', 'invited', 'failed')
        OR (onboarding.status = 'processing' AND onboarding.last_attempted_at < now() - interval '5 minutes')
      )
    RETURNING provider_user_id::text, status
  `, [target.organizationId, target.userId]);
  if (!claimed) {
    const [current] = await query<OnboardingRow>(`
      SELECT provider_user_id::text, status
      FROM local801.user_identity_onboarding
      WHERE organization_id = $1::uuid AND user_id = $2::uuid
      LIMIT 1
    `, [target.organizationId, target.userId]);
    if (current?.status === "ready") return { onboarding: "ready" as const, invitationSent: false };
    throw new EntraOnboardingError("ENTRA_ONBOARDING_STATE_INVALID", "This user’s onboarding state could not be claimed safely.", 409);
  }

  try {
    const token = await accessToken(config, fetcher);
    let providerUserId = claimed.provider_user_id;
    let invitationSent = false;
    if (!providerUserId) {
      const invitation = await inviteGuest(target, config, token, fetcher);
      providerUserId = invitation.providerUserId;
      invitationSent = true;
      await query(`
        UPDATE local801.user_identity_onboarding
        SET provider_user_id = $3::uuid, status = 'processing', invitation_status = $4::text,
          invitation_sent_at = now(), last_error_code = NULL
        WHERE organization_id = $1::uuid AND user_id = $2::uuid
      `, [target.organizationId, target.userId, providerUserId, invitation.invitationStatus]);
    }

    await ensureEnterpriseAppAssignment(providerUserId, config, token, fetcher);
    await query(`
      UPDATE local801.user_identity_onboarding
      SET status = 'ready', access_assigned_at = now(), completed_at = now(), last_error_code = NULL
      WHERE organization_id = $1::uuid AND user_id = $2::uuid AND provider_user_id = $3::uuid
    `, [target.organizationId, target.userId, providerUserId]);
    return { onboarding: "ready" as const, invitationSent };
  } catch (error) {
    const safe = error instanceof EntraOnboardingError
      ? error
      : new EntraOnboardingError("ENTRA_ONBOARDING_UNAVAILABLE", "Automated Microsoft Entra onboarding could not be completed. The CAT account is saved; retry from Team & Access.");
    try { await markFailure(target, safe.code, query); } catch { /* Preserve the safe original failure. */ }
    throw safe;
  }
}

export const __testing = { DEFAULT_APP_ROLE_ID, MAX_ASSIGNMENT_PAGES, MAX_ASSIGNMENT_RECORDS, roleIntroductions, UUID_RE };
