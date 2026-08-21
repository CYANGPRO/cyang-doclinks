import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authorizeProductionIdentity,
  getProductionAuthConfig,
  productionIdentityFromProfile,
  profileHasRequiredMfa,
  resolveProductionSessionBinding,
  ProductionAuthError,
} from "../src/lib/production-auth.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const config = {
  enabled: true,
  organizationSlug: "local801",
  providerId: "local801-oidc",
  providerName: "Organization sign-in",
  wellKnown: "https://idp.example.test/.well-known/openid-configuration",
  clientId: "client",
  clientSecret: "secret",
  mfaClaim: "amr",
  mfaValue: "mfa",
};

const identity = {
  providerId: "local801-oidc",
  subject: "oidc-subject-123",
  email: "person@example.test",
  emailVerified: true,
  mfaVerified: true,
};

function bindingRow(overrides = {}) {
  return {
    organization_slug: "local801",
    user_id: userId,
    email: "person@example.test",
    auth_session_version: "3",
    role: "cat_lead",
    linked_subject: null,
    ...overrides,
  };
}

test("production auth config is disabled by default and requires complete HTTPS OIDC settings when enabled", () => {
  assert.equal(getProductionAuthConfig({}).enabled, false);
  assert.throws(() => getProductionAuthConfig({ LOCAL801_PRODUCTION_AUTH_ENABLED: "1" }), /ORGANIZATION_SLUG/);
  const parsed = getProductionAuthConfig({
    LOCAL801_PRODUCTION_AUTH_ENABLED: "1",
    LOCAL801_ORGANIZATION_SLUG: "local801",
    LOCAL801_OIDC_WELL_KNOWN: "https://idp.example.test/.well-known/openid-configuration",
    LOCAL801_OIDC_CLIENT_ID: "client",
    LOCAL801_OIDC_CLIENT_SECRET: "secret",
  });
  assert.equal(parsed.providerId, "local801-oidc");
  assert.equal(parsed.mfaClaim, "amr");
  assert.equal(parsed.mfaValue, "mfa");
});

test("OIDC profile requires subject, verified email, and configured MFA assurance", () => {
  assert.equal(profileHasRequiredMfa({ amr: ["pwd", "mfa"] }, config), true);
  assert.equal(profileHasRequiredMfa({ amr: ["pwd"] }, config), false);
  assert.equal(profileHasRequiredMfa({ acr: "urn:example:loa:2" }, { mfaClaim: "acr", mfaValue: "urn:example:loa:2" }), true);
  const parsed = productionIdentityFromProfile({
    sub: "oidc-subject-123",
    email: "Person@Example.Test",
    email_verified: true,
    amr: ["pwd", "mfa"],
  }, config);
  assert.deepEqual(parsed, identity);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", email: "person@example.test", email_verified: false, amr: ["mfa"] }, config), /verify/i);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", email: "person@example.test", email_verified: true, amr: ["pwd"] }, config), /MFA/i);
});

test("production identity binding requires one active provisioned user with one valid role and links subject atomically", async () => {
  const transactions = [];
  let sqlText = "";
  const result = await authorizeProductionIdentity(identity, config, {
    query: async (sql, parameters) => {
      sqlText = sql;
      assert.deepEqual(parameters, ["local801", "person@example.test", "local801-oidc"]);
      return [bindingRow()];
    },
    transaction: async (statements) => transactions.push(statements),
  });
  assert.deepEqual(result, {
    organizationSlug: "local801",
    userId,
    email: "person@example.test",
    role: "cat_lead",
    sessionVersion: 3,
  });
  assert.match(sqlText, /organization\.slug = \$1::text/);
  assert.match(sqlText, /app_user\.deactivated_at IS NULL/);
  assert.match(sqlText, /lower\(app_user\.email\) = lower\(\$2::text\)/);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  assert.match(transactions[0][0].sql, /INSERT INTO local801\.auth_identities/);
  assert.match(transactions[0][0].sql, /WHERE local801\.auth_identities\.provider_subject = excluded\.provider_subject/);
  assert.match(transactions[0][1].sql, /last_authenticated_at = now\(\), last_mfa_at = now\(\)/);
  assert.match(transactions[0][1].sql, /auth_session_version = \$3::integer/);
});

test("production identity binding refuses linked-subject mismatch, duplicate user matches, and invalid role", async () => {
  for (const rows of [
    [bindingRow({ linked_subject: "different-subject" })],
    [bindingRow(), bindingRow({ user_id: "33333333-3333-4333-8333-333333333333" })],
    [bindingRow({ role: "unknown_role" })],
  ]) {
    let transactions = 0;
    await assert.rejects(authorizeProductionIdentity(identity, config, {
      query: async () => rows,
      transaction: async () => { transactions += 1; },
    }), ProductionAuthError);
    assert.equal(transactions, 0);
  }
});

test("production session is revalidated against live active user, role, organization, and session version without carrying email", async () => {
  let parameters = [];
  const valid = await resolveProductionSessionBinding({
    organizationSlug: "local801",
    userId,
    sessionVersion: 3,
  }, async (sql, values) => {
    parameters = values;
    assert.match(sql, /app_user\.deactivated_at IS NULL/);
    assert.match(sql, /app_user\.auth_session_version = \$3::integer/);
    assert.doesNotMatch(sql, /lower\(app_user\.email\)\s*=\s*lower/);
    return [bindingRow()];
  });
  assert.equal(valid?.role, "cat_lead");
  assert.equal(valid?.email, "person@example.test");
  assert.deepEqual(parameters, ["local801", userId, 3]);
  const revoked = await resolveProductionSessionBinding({ organizationSlug: "local801", userId, sessionVersion: 3 }, async () => []);
  assert.equal(revoked, null);
});

test("Stage 13 migration adds identity binding and revocable session version without storing IdP tokens", async () => {
  const migration = await readFile(new URL("../db/migrations/0011__production_auth_and_team_access.sql", import.meta.url), "utf8");
  assert.match(migration, /^begin;/i);
  assert.match(migration, /auth_session_version integer not null default 1/);
  assert.match(migration, /create table if not exists local801\.auth_identities/);
  assert.match(migration, /provider_subject text not null/);
  assert.match(migration, /unique \(organization_id, provider_id, provider_subject\)/);
  assert.match(migration, /workspace_user_roles_one_role_per_user_uq/);
  assert.doesNotMatch(migration, /access_token|refresh_token|id_token|password_hash|totp_secret/i);
  assert.match(migration, /commit;\s*$/i);
});

test("production NextAuth route and server authorization keep Preview cookies separate and JWT PII-free", async () => {
  const [options, route, authz, signIn, example, authTypes] = await Promise.all([
    readFile(new URL("../src/lib/auth-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/auth/[...nextauth]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/authz.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sign-in/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../src/types/next-auth.d.ts", import.meta.url), "utf8"),
  ]);
  assert.match(options, /wellKnown: config\.wellKnown/);
  assert.match(options, /checks: \["pkce", "state"\]/);
  assert.match(options, /strategy: "jwt"/);
  assert.match(options, /productionIdentityFromProfile/);
  assert.match(options, /authorizeProductionIdentity/);
  assert.match(options, /productionAuthRuntimeEnabled\(\)/);
  assert.match(options, /delete token\.email/);
  assert.match(options, /session\.user = undefined/);
  assert.doesNotMatch(authTypes, /email:/);
  assert.match(route, /getProductionAuthConfig\(\)\.enabled/);
  assert.match(authz, /if \(previewAuthEnabled\(\)\) return getSyntheticPreviewUser\(\)/);
  assert.match(authz, /getServerSession\(authOptions\)/);
  assert.match(authz, /resolveProductionSessionBinding/);
  assert.doesNotMatch(authz, /sessionAuth\.email/);
  assert.match(authz, /productionAuthRuntimeEnabled\(\)/);
  assert.doesNotMatch(authz, /process\.env\.LOCAL801_PRODUCTION_AUTH_ENABLED === "1"/);
  assert.match(signIn, /Preview role cookies are test state and are never accepted as production authentication/);
  assert.match(signIn, /ProductionSignInButton/);
  assert.match(example, /LOCAL801_PRODUCTION_AUTH_ENABLED=0/);
  assert.match(example, /LOCAL801_OIDC_MFA_CLAIM=amr/);
  assert.match(example, /LOCAL801_OIDC_MFA_VALUE=mfa/);
});
