import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authorizeProductionIdentity,
  getProductionAuthConfig,
  productionAuthClaimShape,
  productionAuthSafeCode,
  productionIdentityFromProfile,
  profileHasVerifiedEmail,
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
  tenantId: "",
  mfaClaim: "amr",
  mfaValue: "mfa",
};

const identity = {
  providerId: "local801-oidc",
  subject: "oidc-subject-123",
  objectId: "",
  email: "person@example.test",
  emailVerified: true,
  bootstrapObjectMatched: false,
  mfaVerified: true,
  directoryObjectVerified: false,
};

function bindingRow(overrides = {}) {
  return {
    organization_slug: "local801",
    organization_id: organizationId,
    user_id: userId,
    email: "person@example.test",
    auth_session_version: "3",
    role: "cat_lead",
    linked_subject: null,
    policy_acknowledged: true,
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
  assert.equal(parsed.tenantId, "");
});

test("OIDC directory identities require the exact tenant, a valid object ID, and MFA without trusting mutable usernames", () => {
  const immutableConfig = {
    ...config,
    tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
  };
  assert.deepEqual(productionIdentityFromProfile({
    sub: "provider-pairwise-subject",
    tid: "aaaaaaaa-0000-4000-8000-000000000001",
    oid: "bbbbbbbb-0000-4000-8000-000000000002",
    preferred_username: "mutable@example.test",
    amr: ["pwd", "mfa"],
  }, immutableConfig), {
    providerId: "local801-oidc",
    subject: "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002",
    email: "",
    emailVerified: false,
    mfaVerified: true,
    directoryObjectVerified: true,
  });
  assert.deepEqual(productionIdentityFromProfile({
    sub: "provider-pairwise-subject",
    tid: "aaaaaaaa-0000-4000-8000-000000000001",
    oid: "cccccccc-0000-4000-8000-000000000003",
    preferred_username: "mutable@example.test",
    amr: ["mfa"],
  }, immutableConfig), {
    providerId: "local801-oidc",
    subject: "aaaaaaaa-0000-4000-8000-000000000001:cccccccc-0000-4000-8000-000000000003",
    email: "",
    emailVerified: false,
    mfaVerified: true,
    directoryObjectVerified: true,
  });
  assert.deepEqual(productionIdentityFromProfile({
    sub: "provider-pairwise-subject",
    tid: "aaaaaaaa-0000-4000-8000-000000000001",
    oid: "bbbbbbbb-0000-4000-8000-000000000002",
    preferred_username: "mutable@example.test",
    amr: ["mfa"],
  }, {
    ...immutableConfig,
    bootstrapObjectId: "bbbbbbbb-0000-4000-8000-000000000002",
  }), {
    providerId: "local801-oidc",
    subject: "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002",
    objectId: "bbbbbbbb-0000-4000-8000-000000000002",
    email: "",
    emailVerified: false,
    bootstrapObjectMatched: true,
    mfaVerified: true,
    directoryObjectVerified: true,
  });
  assert.throws(() => productionIdentityFromProfile({
    sub: "provider-pairwise-subject",
    tid: "dddddddd-0000-4000-8000-000000000004",
    oid: "cccccccc-0000-4000-8000-000000000003",
    preferred_username: "mutable@example.test",
    amr: ["mfa"],
  }, immutableConfig), /email/i);
  assert.throws(() => productionIdentityFromProfile({
    sub: "provider-pairwise-subject",
    tid: "aaaaaaaa-0000-4000-8000-000000000001",
    oid: "bbbbbbbb-0000-4000-8000-000000000002",
    amr: ["pwd"],
  }, immutableConfig), /MFA/i);
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
  assert.equal(profileHasVerifiedEmail({ verified_primary_email: "Person@Example.Test" }, "person@example.test"), true);
  assert.deepEqual(productionIdentityFromProfile({
    sub: "oidc-subject-123",
    email: "Person@Example.Test",
    verified_primary_email: "person@example.test",
    amr: ["mfa"],
  }, config), identity);
  assert.deepEqual(productionIdentityFromProfile({
    sub: "oidc-subject-123",
    verified_primary_email: "Person@Example.Test",
    amr: ["mfa"],
  }, config), identity);
  assert.equal(profileHasVerifiedEmail({ local801_email: "Person@Example.Test", xms_edov: true }, "person@example.test"), true);
  assert.deepEqual(productionIdentityFromProfile({
    sub: "oidc-subject-123",
    local801_email: "Person@Example.Test",
    xms_edov: true,
    amr: ["mfa"],
  }, config), identity);
  assert.equal(profileHasVerifiedEmail({ local801_email: "Person@Example.Test", xms_edov: false }, "person@example.test"), false);
  assert.equal(profileHasVerifiedEmail({ local801_email: "Person@Example.Test", email_verified: true }, "person@example.test"), false);
  assert.equal(profileHasVerifiedEmail({ local801_email: "other@example.test", xms_edov: true }, "person@example.test"), false);
  assert.equal(profileHasVerifiedEmail({ verified_primary_email: "other@example.test" }, "person@example.test"), false);
  assert.equal(profileHasVerifiedEmail({ verified_primary_email: ["person@example.test"] }, "person@example.test"), false);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", email: "person@example.test", verified_primary_email: "other@example.test", amr: ["mfa"] }, config), /verify/i);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", email: "person@example.test", email_verified: false, amr: ["mfa"] }, config), /verify/i);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", preferred_username: "person@example.test", amr: ["mfa"] }, config), /email/i);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", local801_email: "person@example.test", xms_edov: false, amr: ["mfa"] }, config), /verify/i);
  assert.throws(() => productionIdentityFromProfile({ sub: "x", email: "person@example.test", email_verified: true, amr: ["pwd"] }, config), /MFA/i);
  const bootstrapObjectId = "834e272c-3b2b-40ae-92e6-017803ce3525";
  assert.deepEqual(productionIdentityFromProfile({
    sub: "bootstrap-subject",
    oid: bootstrapObjectId,
    email: "owner@example.test",
    amr: ["pwd", "mfa"],
  }, { ...config, bootstrapObjectId }), {
    providerId: "local801-oidc",
    subject: "bootstrap-subject",
    objectId: bootstrapObjectId,
    email: "owner@example.test",
    emailVerified: false,
    bootstrapObjectMatched: true,
    mfaVerified: true,
  });
});

test("production auth exposes only allowlisted, PII-free rejection codes", () => {
  assert.equal(productionAuthSafeCode(new ProductionAuthError("MFA_REQUIRED", "details")), "MFA_REQUIRED");
  assert.equal(productionAuthSafeCode(new ProductionAuthError("BOOTSTRAP_OWNER_NOT_PROVISIONED", "details")), "BOOTSTRAP_OWNER_NOT_PROVISIONED");
  assert.equal(productionAuthSafeCode(new ProductionAuthError("BOOTSTRAP_REBIND_FAILED", "details")), "BOOTSTRAP_REBIND_FAILED");
  assert.equal(productionAuthSafeCode({ code: "USER_NOT_PROVISIONED", email: "person@example.test" }), "USER_NOT_PROVISIONED");
  assert.equal(productionAuthSafeCode({ code: "person@example.test" }), "AUTHORIZATION_FAILED");
  assert.equal(productionAuthSafeCode(new Error("token details")), "AUTHORIZATION_FAILED");
});

test("production auth diagnostics expose only claim-presence bits", () => {
  assert.equal(productionAuthClaimShape({
    email: "person@example.test",
    verified_primary_email: "person@example.test",
    emails: ["person@example.test"],
    email_verified: true,
    xms_edov: true,
    amr: ["pwd", "mfa"],
    acr: "value",
  }), "email1-primary1-emails1-verified1-domain1-oid0-amr1-acr1");
  assert.equal(productionAuthClaimShape({ email: "", emails: [], token: "secret" }),
    "email0-primary0-emails0-verified0-domain0-oid0-amr0-acr0");
});

test("production identity binding requires one active provisioned user with one valid role and links subject atomically", async () => {
  const transactions = [];
  let sqlText = "";
  const result = await authorizeProductionIdentity(identity, config, {
    query: async (sql, parameters) => {
      sqlText = sql;
      assert.deepEqual(parameters, ["local801", "person@example.test", "local801-oidc", "privacy-acceptable-use", "2026-08-18"]);
      return [bindingRow()];
    },
    transaction: async (statements) => transactions.push(statements),
  });
  assert.deepEqual(result, {
    organizationSlug: "local801",
    organizationId,
    userId,
    email: "person@example.test",
    role: "cat_lead",
    sessionVersion: 3,
    policyAcknowledged: true,
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
  assert.equal(valid?.organizationId, organizationId);
  assert.equal(valid?.email, "person@example.test");
  assert.equal(valid?.policyAcknowledged, true);
  assert.deepEqual(parameters, ["local801", userId, 3, "privacy-acceptable-use", "2026-08-18"]);
  const pending = await resolveProductionSessionBinding({ organizationSlug: "local801", userId, sessionVersion: 3 }, async () => [bindingRow({ policy_acknowledged: false })]);
  assert.equal(pending?.policyAcknowledged, false);
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
  const [options, route, authz, signIn, signInButton, example, authTypes] = await Promise.all([
    readFile(new URL("../src/lib/auth-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/auth/[...nextauth]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/authz.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sign-in/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ProductionSignInButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../src/types/next-auth.d.ts", import.meta.url), "utf8"),
  ]);
  assert.match(options, /wellKnown: config\.wellKnown/);
  assert.match(options, /checks: \["pkce", "state"\]/);
  assert.match(options, /strategy: "jwt"/);
  assert.match(options, /productionIdentityFromProfile/);
  assert.match(options, /authorizeProductionIdentity/);
  assert.match(options, /writeSecuritySignal\("warn", "authorization\.denied"/);
  assert.match(options, /safeCode: productionAuthSafeCode\(error\)/);
  assert.match(options, /reason: productionAuthClaimShape\(profile as Record<string, unknown>\)/);
  assert.match(options, /productionAuthRuntimeEnabled\(\)/);
  assert.match(options, /delete token\.email/);
  assert.match(options, /session\.user = undefined/);
  assert.doesNotMatch(authTypes, /email:/);
  assert.match(route, /productionAuthRuntimeEnabled\(\)/);
  assert.match(authz, /const getAuthenticatedUserForRequest = cache/);
  assert.match(authz, /if \(previewAuthEnabled\(\)\) return getSyntheticPreviewUser\(\)/);
  assert.match(authz, /getServerSession\(authOptions\)/);
  assert.match(authz, /resolveProductionSessionBinding/);
  assert.doesNotMatch(authz, /sessionAuth\.email/);
  assert.match(authz, /productionAuthRuntimeEnabled\(\)/);
  assert.doesNotMatch(authz, /process\.env\.LOCAL801_PRODUCTION_AUTH_ENABLED === "1"/);
  assert.match(signIn, /does not create an account, change Production access, or connect to Production member records/);
  assert.match(signIn, /isolated Preview records/);
  assert.match(signIn, /ProductionSignInButton/);
  assert.match(signIn, /production\.enabled && productionAuthRuntimeEnabled\(\)/);
  assert.match(signIn, /Sign-in is not open yet/);
  assert.match(example, /LOCAL801_PRODUCTION_AUTH_ENABLED=0/);
  assert.match(example, /verified_primary_email/);
  assert.match(example, /LOCAL801_OIDC_MFA_CLAIM=amr/);
  assert.match(example, /LOCAL801_OIDC_MFA_VALUE=mfa/);
});
