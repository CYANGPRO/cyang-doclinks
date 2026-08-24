import "server-only";

import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import {
  safeProductionAuthClaimPresence,
  safeProductionAuthFailureCode,
  safeProductionAuthInternalFailure,
} from "./auth-failure-diagnostics.ts";
import {
  authorizeProductionIdentity,
  getProductionAuthConfig,
  productionAuthClaimShape,
  productionAuthSafeCode,
  productionIdentityFromProfile,
  type ProductionAuthBinding,
} from "./production-auth.ts";
import { productionAuthRuntimeEnabled } from "./production-launch-policy.ts";
import { writeSecuritySignal } from "./security-signal.ts";

const secureCookie = process.env.NODE_ENV === "production";

function oidcProvider(): OAuthConfig<Record<string, unknown>> | null {
  const config = getProductionAuthConfig();
  if (!config.enabled || !productionAuthRuntimeEnabled()) return null;
  return {
    id: config.providerId,
    name: config.providerName,
    type: "oauth",
    wellKnown: config.wellKnown,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    idToken: true,
    checks: ["pkce", "state"],
    authorization: { params: { scope: "openid email profile" } },
    profile(profile) {
      const email = typeof profile.email === "string" ? profile.email : null;
      const name = typeof profile.name === "string" ? profile.name : email;
      const image = typeof profile.picture === "string" ? profile.picture : null;
      return { id: String(profile.sub ?? ""), name, email, image };
    },
  };
}

async function bindingFromProfile(profile: unknown): Promise<ProductionAuthBinding> {
  if (!productionAuthRuntimeEnabled()) throw new Error("Production authentication is not runtime-enabled.");
  const config = getProductionAuthConfig();
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("OIDC profile unavailable.");
  const identity = productionIdentityFromProfile(profile as Record<string, unknown>, config);
  return authorizeProductionIdentity(identity, config);
}

const provider = oidcProvider();

export const authOptions: NextAuthOptions = {
  providers: provider ? [provider] : [],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: "jwt",
    maxAge: Number(process.env.LOCAL801_ADMIN_SESSION_SECONDS ?? 43_200),
  },
  cookies: {
    sessionToken: {
      name: secureCookie ? "__Secure-local801.session-token" : "local801.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: secureCookie,
      },
    },
  },
  pages: {
    signIn: "/sign-in",
    error: "/sign-in",
  },
  callbacks: {
    async signIn({ account, profile }) {
      if (!productionAuthRuntimeEnabled()) return false;
      const config = getProductionAuthConfig();
      if (!config.enabled || !account || account.provider !== config.providerId || !profile) return false;
      try {
        await bindingFromProfile(profile);
        return true;
      } catch (error) {
        writeSecuritySignal("warn", "authorization.denied", {
          component: "production_auth",
          operation: "sign_in",
          outcome: "denied",
          reason: productionAuthClaimShape(profile as Record<string, unknown>),
          safeCode: productionAuthSafeCode(error),
        });
        return false;
      }
    },
    async jwt({ token, account, profile }) {
      if (account && profile) {
        if (!productionAuthRuntimeEnabled()) return token;
        const binding = await bindingFromProfile(profile);
        token.local801Auth = {
          organizationSlug: binding.organizationSlug,
          userId: binding.userId,
          sessionVersion: binding.sessionVersion,
          mfaVerifiedAt: new Date().toISOString(),
        };
      }
      // The verified email is needed only during initial server-side OIDC binding. Persist only
      // opaque Local 801 session state in the encrypted JWT and expose no profile PII to the client.
      delete token.email;
      delete token.name;
      delete token.picture;
      return token;
    },
    async session({ session, token }) {
      session.user = undefined;
      if (token.local801Auth && productionAuthRuntimeEnabled()) session.local801Auth = token.local801Auth;
      return session;
    },
  },
};
