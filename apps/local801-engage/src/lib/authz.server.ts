import "server-only";

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { can, type Permission, type Role } from "@/lib/access";
import { authOptions } from "@/lib/auth-options";
import { previewAuthEnabled } from "@/lib/preview-auth-policy";
import { getProductionAuthConfig, resolveProductionSessionBinding } from "@/lib/production-auth";
import { productionAuthRuntimeEnabled } from "@/lib/production-launch-policy";
import { enforceAuthenticatedIdentityRateLimit, type RateLimitPolicy } from "@/lib/rate-limit";
import { writeSecuritySignal } from "@/lib/security-signal";

export { previewAuthEnabled } from "@/lib/preview-auth-policy";

const previewCookie = "local801_preview_role";
const actorCookie = "local801_preview_actor";

const previewEmails: Record<Role, string> = {
  system_owner: "system_owner@example.test",
  local_admin: "local_admin@example.test",
  membership_data_manager: "membership_manager@example.test",
  cat_admin: "cat_admin@example.test",
  cat_lead: "cat_lead@example.test",
  cat_member: "cat_member@example.test",
  report_viewer: "report_viewer@example.test",
};

const roleSet = new Set<Role>([
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
]);

export type PreviewUser = {
  id: string;
  email: string;
  role: Role;
  organizationId: string;
  authentication: "preview" | "production";
  policyAcknowledged: boolean;
  sessionVersion: number | null;
};

export function normalizeRole(role: string | null | undefined): Role | null {
  return role && roleSet.has(role as Role) ? (role as Role) : null;
}

async function getSyntheticPreviewUser(): Promise<PreviewUser | null> {
  const jar = await cookies();
  const role = normalizeRole(jar.get(previewCookie)?.value);
  if (!role) return null;
  return {
    id: jar.get(actorCookie)?.value || `preview-${role}`,
    email: previewEmails[role],
    role,
    organizationId: "local801-preview",
    authentication: "preview",
    policyAcknowledged: true,
    sessionVersion: null,
  };
}

async function getProductionUser(): Promise<PreviewUser | null> {
  if (!productionAuthRuntimeEnabled()) return null;
  const config = getProductionAuthConfig();
  if (!config.enabled) return null;
  const session = await getServerSession(authOptions);
  const sessionAuth = session?.local801Auth;
  if (!sessionAuth || sessionAuth.organizationSlug !== config.organizationSlug) return null;
  const binding = await resolveProductionSessionBinding({
    organizationSlug: sessionAuth.organizationSlug,
    userId: sessionAuth.userId,
    sessionVersion: sessionAuth.sessionVersion,
  });
  if (!binding) return null;
  return {
    id: binding.userId,
    email: binding.email,
    role: binding.role,
    organizationId: binding.organizationSlug,
    authentication: "production",
    policyAcknowledged: binding.policyAcknowledged,
    sessionVersion: binding.sessionVersion,
  };
}

/**
 * Compatibility name retained while existing pages/routes migrate. In private Preview it resolves
 * the synthetic role cookie; otherwise it resolves and revalidates a production OIDC session.
 */
export async function getPreviewUser(): Promise<PreviewUser | null> {
  if (previewAuthEnabled()) return getSyntheticPreviewUser();
  try {
    const user = await getProductionUser();
    return user?.policyAcknowledged ? user : null;
  } catch {
    return null;
  }
}

export async function getPolicyAcknowledgementUser(): Promise<PreviewUser | null> {
  if (previewAuthEnabled()) return null;
  try {
    const user = await getProductionUser();
    return user && !user.policyAcknowledged ? user : null;
  } catch {
    return null;
  }
}

const permissionRatePolicy: Partial<Record<Permission, RateLimitPolicy>> = {
  manageUsers: "administrative_mutation",
  manageImports: "import",
  approveImports: "import",
  manageCampaigns: "administrative_mutation",
  manageCatActions: "administrative_mutation",
  manageDocuments: "upload",
  viewDocuments: "download_export",
  generateReports: "download_export",
  viewReports: "download_export",
  viewDirectory: "search",
  recordEngagement: "administrative_mutation",
  exportRoster: "download_export",
};

export async function requirePreviewUser(permission?: Permission, options: { skipRateLimit?: boolean } = {}) {
  const user = await getPreviewUser();
  if (!user) {
    if (process.env.NODE_ENV === "production") {
      writeSecuritySignal("warn", "authorization.denied", {
        outcome: "denied", reason: "unauthenticated", permission: permission ?? null,
      });
    }
    return { ok: false as const, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  if (permission && !can(user.role, permission)) {
    if (process.env.NODE_ENV === "production") {
      writeSecuritySignal("warn", "authorization.denied", {
        outcome: "denied", reason: "insufficient_permission", actorId: user.id,
        organizationId: user.organizationId, permission,
      });
    }
    return { ok: false as const, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) };
  }
  const policy = permission ? permissionRatePolicy[permission] : undefined;
  if (policy && !options.skipRateLimit) {
    const limit = await enforceAuthenticatedIdentityRateLimit({
      organizationSlug: user.organizationId,
      userId: user.id,
      policy,
    });
    if (!limit.ok) return { ok: false as const, response: limit.response };
  }
  return { ok: true as const, user };
}

export function protectRequest(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestedPath = `${pathname}${request.nextUrl.search}`;
  const isApi = pathname.startsWith("/api/");

  if (!previewAuthEnabled()) {
    // Production authorization is completed at the Node.js server boundary, where the encrypted
    // JWT session is revalidated against the live Local 801 user, role, and session version.
    // In Vercel Production, the Stage 14 launch policy must also be fully ready.
    if (productionAuthRuntimeEnabled()) return NextResponse.next();
    if (isApi) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("next", requestedPath);
    return NextResponse.redirect(url);
  }

  const role = normalizeRole(request.cookies.get(previewCookie)?.value);

  if (!role) {
    if (isApi) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("next", requestedPath);
    return NextResponse.redirect(url);
  }

  const pagePermissions: Array<[RegExp, Permission]> = [
    [/^\/directory/, "viewDirectory"],
    [/^\/imports/, "manageImports"],
    [/^\/membership/, "manageImports"],
    [/^\/new-hires/, "assignNewHires"],
    [/^\/outreach/, "recordEngagement"],
    [/^\/follow-ups/, "recordEngagement"],
    [/^\/workload/, "recordEngagement"],
    [/^\/campaigns/, "manageCampaigns"],
    [/^\/cat-actions/, "manageCatActions"],
    [/^\/documents/, "viewDocuments"],
    [/^\/notifications/, "viewPersonalWorkspace"],
    [/^\/team/, "manageUsers"],
    [/^\/settings/, "manageUsers"],
    [/^\/audit/, "manageUsers"],
    [/^\/reports/, "viewReports"],
  ];

  const required = pagePermissions.find(([pattern]) => pattern.test(pathname))?.[1];
  if (required && !can(role, required)) {
    if (isApi) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    const url = request.nextUrl.clone();
    url.pathname = "/unauthorized";
    url.search = "";
    url.searchParams.set("next", requestedPath);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export function setPreviewAuthCookies(response: NextResponse, role: Role) {
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(previewCookie, role, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: role === "system_owner" || role === "local_admin" ? 60 * 60 * 12 : 60 * 60 * 24 * 7,
  });
  response.cookies.set(actorCookie, `preview-${role}`, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}
