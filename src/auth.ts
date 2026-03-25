import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { sql } from "@/lib/db";
import { normalizeExactPasswordInput } from "@/lib/password";
import { hasSignupConsentCookie, isSignupEnabled, recordTermsAcceptance, verifyManualCredentials } from "@/lib/signup";

/**
 * Auth (NextAuth v4)
 *
 * Sign-in methods:
 * - Google OAuth (regular email accounts)
 * - Enterprise SSO (BYO OIDC) (organizational logins)
 *
 * Landing behavior:
 * - Successful sign-in goes through an intent-aware continuation route
 * - Admin/owner sign-in lands in /admin
 * - Viewer sign-in lands in /viewer
 * - Sign-out lands on /
 *
 * Owner role:
 * - We compute `user.role` into the session so server layouts can hide/show owner-only nav.
 * - Set OWNER_EMAILS (comma-separated) or OWNER_EMAIL in Vercel to control who is "owner".
 *
 * Env vars (core):
 * - NEXTAUTH_URL=https://www.cyang.io
 * - NEXTAUTH_SECRET=<long random>
 *
 * Google OAuth:
 * - GOOGLE_CLIENT_ID
 * - GOOGLE_CLIENT_SECRET
 *
 * Enterprise OIDC (BYO):
 * - OIDC_ISSUER
 * - OIDC_CLIENT_ID
 * - OIDC_CLIENT_SECRET
 *
 * Owner allowlist:
 * - OWNER_EMAILS="a@x.com,b@y.com"  (recommended)
 *   OR
 * - OWNER_EMAIL="a@x.com"
 */

const POST_SIGN_IN_PATH = "/auth/continue-viewer";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254;
const MANUAL_PASSWORD_MAX_LEN = 4096;

const useSecureCookies =
  (process.env.NEXTAUTH_URL || "").toLowerCase().startsWith("https://") ||
  (process.env.VERCEL || "").toLowerCase() === "1" ||
  (process.env.VERCEL_ENV || "").length > 0;

function hasEnv(...keys: string[]) {
  return keys.every((k) => {
    const v = process.env[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

function isLikelyEmail(email: string): boolean {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || normalized.length > EMAIL_MAX_LEN) return false;
  return EMAIL_RE.test(normalized);
}

const isGoogleConfigured = hasEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");

const isEnterpriseSsoConfigured = hasEnv(
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET"
);

function parseOwnerEmails(): Set<string> {
  const single = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  const list = (process.env.OWNER_EMAILS ?? "").trim();

  const emails = new Set<string>();
  if (single) emails.add(single);

  if (list) {
    for (const part of list.split(",")) {
      const e = part.trim().toLowerCase();
      if (e) emails.add(e);
    }
  }
  return emails;
}

const OWNER_EMAIL_SET = parseOwnerEmails();

function computeRole(email?: string | null): "owner" | "viewer" {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return "viewer";

  // If no allowlist is configured, default to viewer for safety.
  if (OWNER_EMAIL_SET.size === 0) return "viewer";

  return OWNER_EMAIL_SET.has(e) ? "owner" : "viewer";
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function claimEmailVerified(profile: unknown): boolean | null {
  const p = profile as Record<string, unknown> | null | undefined;
  const value = p?.email_verified;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(normalized)) return true;
    if (["0", "false", "no"].includes(normalized)) return false;
  }
  return null;
}

function enterpriseOidcProvider() {
  const issuer = process.env.OIDC_ISSUER!;
  const wellKnown = issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration";

  return {
    id: "enterprise-sso",
    name: "Enterprise SSO",
    type: "oauth",
    wellKnown,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
    authorization: { params: { scope: "openid email profile" } },
    idToken: true,
    checks: ["pkce", "state"],
    profile(profile: Record<string, unknown>) {
      return {
        id: profile.sub ?? profile.id ?? profile.user_id ?? profile.oid ?? profile.uid,
        name:
          profile.name ??
          [profile.given_name, profile.family_name].filter(Boolean).join(" ") ??
          profile.preferred_username ??
          profile.email ??
          null,
        email: profile.email ?? profile.upn ?? profile.preferred_username ?? null,
        image: profile.picture ?? null,
      };
    },
  } as const;
}

type NextAuthProvider = NonNullable<NextAuthOptions["providers"]>[number];

export const authOptions: NextAuthOptions = {
  // Make cookie security explicit (prod-safe defaults).
  useSecureCookies,
  cookies: useSecureCookies
    ? {
        // Note: __Host- requires Path=/, Secure, and no Domain.
        csrfToken: {
          name: "__Host-next-auth.csrf-token",
          options: {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure: true,
          },
        },
        sessionToken: {
          name: "__Secure-next-auth.session-token",
          options: {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure: true,
          },
        },
        callbackUrl: {
          name: "__Secure-next-auth.callback-url",
          options: {
            sameSite: "lax",
            path: "/",
            secure: true,
          },
        },
      }
    : undefined,

  providers: [
    Credentials({
      id: "manual-password",
      name: "Email and Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email || "").trim().toLowerCase();
        const password = normalizeExactPasswordInput(credentials?.password || "", MANUAL_PASSWORD_MAX_LEN);
        if (!isLikelyEmail(email)) return null;
        if (!password) return null;
        const user = await verifyManualCredentials(email, password);
        if (!user) return null;
        return {
          id: user.email,
          email: user.email,
          name: user.name,
        };
      },
    }),

    ...(isGoogleConfigured
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        ]
      : []),

    ...(isEnterpriseSsoConfigured ? [enterpriseOidcProvider() as unknown as NextAuthProvider] : []),
  ],

  pages: {
    signIn: "/signin",
  },

  session: { strategy: "jwt" },

  callbacks: {
    async signIn({ user, account, profile }) {
      const email = String((user as { email?: string | null } | undefined)?.email || "").trim().toLowerCase();
      const provider = String(account?.provider || "").trim().toLowerCase();
      if (!isLikelyEmail(email)) return false;

      if (provider === "manual-password") {
        return true;
      }

      if (provider === "google") {
        if (claimEmailVerified(profile) !== true) {
          return "/signin?error=email_not_verified";
        }
      }

      if (provider === "enterprise-sso") {
        const requireVerified = parseBooleanEnv("OIDC_REQUIRE_EMAIL_VERIFIED", true);
        if (requireVerified && claimEmailVerified(profile) !== true) {
          return "/signin?error=email_not_verified";
        }
      }

      if (provider === "google" || provider === "enterprise-sso") {
        let userExists = false;
        try {
          const rows = (await sql`
            select 1
            from public.users
            where lower(email) = lower(${email})
            limit 1
          `) as unknown as Array<{ "?column?": number }>;
          userExists = rows.length > 0;
        } catch {
          userExists = false;
        }

        if (!userExists) {
          if (!isSignupEnabled()) {
            return "/signin?error=signup_disabled";
          }
          const hasConsent = await hasSignupConsentCookie();
          if (!hasConsent) {
            return "/signup?error=terms_required";
          }
          try {
            await recordTermsAcceptance(email, provider);
          } catch {
            // Non-blocking if legal acceptance table has not been rolled out yet.
          }
        }
      }

      return true;
    },

    async jwt({ token, user }) {
      // On first sign-in, `user` is present. Afterwards rely on token.email.
      const tokenLike = token as { email?: string | null; role?: "owner" | "viewer" };
      const email = (user as { email?: string | null } | undefined)?.email ?? tokenLike.email ?? null;
      tokenLike.role = computeRole(email);
      return token;
    },

    async session({ session, token }) {
      // Expose role to server components (layouts) and client UI if needed.
      const tokenLike = token as { role?: "owner" | "viewer" };
      (session.user as { role?: "owner" | "viewer" }).role = tokenLike.role ?? "viewer";
      return session;
    },

    async redirect({ url, baseUrl }) {
      try {
        const u = new URL(url, baseUrl);

        // Keep NextAuth system routes functioning.
        if (u.origin === baseUrl && u.pathname.startsWith("/api/auth")) {
          return `${baseUrl}${u.pathname}${u.search}`;
        }

        // Honor any explicit same-origin in-app redirect.
        if (u.origin === baseUrl && u.pathname.startsWith("/")) {
          return `${baseUrl}${u.pathname}${u.search}`;
        }
      } catch {
        // ignore parsing issues; fall through to the role-aware continuation route
      }

      // Default: send signed-in users through the viewer continuation route.
      return `${baseUrl}${POST_SIGN_IN_PATH}`;
    },
  },
};
