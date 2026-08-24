import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildOnboardingInvitationMessage,
  __testing,
  EntraOnboardingError,
  getEntraProvisioningConfig,
  onboardTeamMemberWithEntra,
} from "../src/lib/entra-user-onboarding.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const providerUserId = "33333333-3333-4333-8333-333333333333";
const enterpriseAppObjectId = "44444444-4444-4444-8444-444444444444";
const clientId = "55555555-5555-4555-8555-555555555555";

const target = {
  organizationId,
  userId,
  email: "organizer@example.test",
  displayName: "Synthetic Organizer",
  role: "cat_member",
};

function environment(overrides = {}) {
  return {
    LOCAL801_ENTRA_USER_PROVISIONING_ENABLED: "1",
    LOCAL801_OIDC_TENANT_ID: organizationId,
    LOCAL801_OIDC_CLIENT_ID: clientId,
    LOCAL801_OIDC_CLIENT_SECRET: "server-only-secret-value",
    LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID: enterpriseAppObjectId,
    LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID: "00000000-0000-0000-0000-000000000000",
    LOCAL801_APP_URL: "https://cat.cyang.io",
    LOCAL801_ACCESS_SUPPORT_EMAIL: "support@example.test",
    ...overrides,
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("role-specific invitation explains identity, MFA, policy acceptance, protected-data duties, auditing, and support", () => {
  const message = buildOnboardingInvitationMessage(target, getEntraProvisioningConfig(environment()));
  for (const required of [
    "Assigned role: CAT",
    "exactly organizer@example.test",
    "never creates or emails a password",
    "multifactor authentication",
    "Privacy and acceptable use",
    "must not be forwarded",
    "protect member and employee information",
    "security-relevant activity is audited",
    "support@example.test",
  ]) assert.match(message, new RegExp(required, "i"), required);
  assert.doesNotMatch(message, /client.secret|access.token|redeem\?rd=/i);
});

test("one-step onboarding sends a Microsoft invitation, assigns the enterprise app, and records ready state", async () => {
  const queries = [];
  const fetches = [];
  const query = async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (/RETURNING provider_user_id::text, status/.test(sql)) return [{ provider_user_id: null, status: "processing" }];
    return [];
  };
  const fetcher = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes("/oauth2/v2.0/token")) return response({ access_token: "t".repeat(64) });
    if (String(url).endsWith("/invitations")) return response({ status: "PendingAcceptance", invitedUser: { id: providerUserId } }, 201);
    if (init.method === "GET") return response({ value: [] });
    return response({ id: "assignment-id" }, 201);
  };

  const result = await onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() });
  assert.deepEqual(result, { onboarding: "ready", invitationSent: true });
  assert.equal(fetches.length, 4);
  assert.equal(
    fetches[2].url,
    `https://graph.microsoft.com/v1.0/servicePrincipals/${enterpriseAppObjectId}/appRoleAssignedTo`,
  );
  const invitation = JSON.parse(fetches[1].init.body);
  assert.equal(invitation.invitedUserEmailAddress, target.email);
  assert.equal(invitation.sendInvitationMessage, true);
  assert.equal(invitation.inviteRedirectUrl, "https://cat.cyang.io/sign-in");
  assert.match(invitation.invitedUserMessageInfo.customizedMessageBody, /Assigned role: CAT/);
  const assignment = JSON.parse(fetches[3].init.body);
  assert.deepEqual(assignment, {
    principalId: providerUserId,
    resourceId: enterpriseAppObjectId,
    appRoleId: "00000000-0000-0000-0000-000000000000",
  });
  assert.ok(queries.some(({ sql }) => /provider_user_id = \$3::uuid[\s\S]*invitation_sent_at = now\(\)/.test(sql)));
  assert.ok(queries.some(({ sql }) => /status = 'ready'/.test(sql)));
  assert.ok(queries.some(({ sql }) => /target_user\.deactivated_at IS NULL/.test(sql)));
  assert.equal(JSON.stringify(queries).includes("server-only-secret-value"), false);
});

test("retry with a recorded Entra user is idempotent and does not send a second invitation", async () => {
  const fetches = [];
  const query = async (sql) => /RETURNING provider_user_id::text, status/.test(sql)
    ? [{ provider_user_id: providerUserId, status: "processing" }]
    : [];
  const fetcher = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes("/oauth2/v2.0/token")) return response({ access_token: "t".repeat(64) });
    if (!String(url).includes("skiptoken=second-page")) return response({
      value: [{ id: "wrong-user", principalId: userId, appRoleId: "00000000-0000-0000-0000-000000000000", resourceId: enterpriseAppObjectId }],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/servicePrincipals/${enterpriseAppObjectId}/appRoleAssignedTo?skiptoken=second-page`,
    });
    return response({ value: [
      { id: "existing", principalId: providerUserId.toUpperCase(), appRoleId: "00000000-0000-0000-0000-000000000000", resourceId: enterpriseAppObjectId.toUpperCase() },
    ] });
  };
  const result = await onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() });
  assert.deepEqual(result, { onboarding: "ready", invitationSent: false });
  assert.equal(fetches.length, 3);
  assert.equal(
    fetches[1].url,
    `https://graph.microsoft.com/v1.0/servicePrincipals/${enterpriseAppObjectId}/appRoleAssignedTo`,
  );
  assert.match(fetches[2].url, /skiptoken=second-page/);
  assert.equal(fetches.some(({ url }) => url.endsWith("/invitations")), false);
  assert.equal(fetches.some(({ init }) => init.method === "POST" && !String(init.body ?? "").includes("client_credentials")), false);
});

test("assignment lookup requires both the requested user and configured app role before treating retry as complete", async () => {
  const fetches = [];
  const query = async (sql) => /RETURNING provider_user_id::text, status/.test(sql)
    ? [{ provider_user_id: providerUserId, status: "processing" }]
    : [];
  const fetcher = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes("/oauth2/v2.0/token")) return response({ access_token: "t".repeat(64) });
    if (init.method === "GET") return response({ value: [
      { id: "wrong-role", principalId: providerUserId, appRoleId: userId, resourceId: enterpriseAppObjectId },
      { id: "wrong-user", principalId: userId, appRoleId: "00000000-0000-0000-0000-000000000000", resourceId: enterpriseAppObjectId },
    ] });
    return response({ id: "assignment-id" }, 201);
  };
  const result = await onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() });
  assert.deepEqual(result, { onboarding: "ready", invitationSent: false });
  assert.equal(fetches.length, 3);
  assert.equal(fetches[1].init.method, "GET");
  assert.equal(fetches[2].init.method, "POST");
  assert.deepEqual(JSON.parse(fetches[2].init.body), {
    principalId: providerUserId,
    resourceId: enterpriseAppObjectId,
    appRoleId: "00000000-0000-0000-0000-000000000000",
  });
});

test("assignment pagination rejects an untrusted next link without creating an assignment", async () => {
  const queries = [];
  const fetches = [];
  const query = async (sql, parameters) => {
    queries.push({ sql, parameters });
    return /RETURNING provider_user_id::text, status/.test(sql)
      ? [{ provider_user_id: providerUserId, status: "processing" }]
      : [];
  };
  const fetcher = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes("/oauth2/v2.0/token")) return response({ access_token: "t".repeat(64) });
    return response({ value: [], "@odata.nextLink": "https://example.invalid/assignments?skiptoken=unsafe" });
  };
  await assert.rejects(
    onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() }),
    (error) => error instanceof EntraOnboardingError && error.code === "ENTRA_ASSIGNMENT_CHECK_INVALID",
  );
  assert.equal(fetches.length, 2);
  assert.equal(fetches.some(({ init }) => init.method === "POST" && !String(init.body ?? "").includes("client_credentials")), false);
  assert.equal(queries.find(({ sql }) => /status = 'failed'/.test(sql)).parameters[2], "ENTRA_ASSIGNMENT_CHECK_INVALID");
});

test("assignment pagination fails closed at the page limit", async () => {
  let graphPages = 0;
  const query = async (sql) => /RETURNING provider_user_id::text, status/.test(sql)
    ? [{ provider_user_id: providerUserId, status: "processing" }]
    : [];
  const fetcher = async (url) => {
    if (String(url).includes("/oauth2/v2.0/token")) return response({ access_token: "t".repeat(64) });
    graphPages += 1;
    return response({
      value: [],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/servicePrincipals/${enterpriseAppObjectId}/appRoleAssignedTo?skiptoken=page-${graphPages}`,
    });
  };
  await assert.rejects(
    onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() }),
    (error) => error instanceof EntraOnboardingError && error.code === "ENTRA_ASSIGNMENT_CHECK_LIMIT",
  );
  assert.equal(graphPages, __testing.MAX_ASSIGNMENT_PAGES);
});

test("Graph failures store only a bounded safe code and preserve a retryable CAT account", async () => {
  const queries = [];
  const query = async (sql, parameters) => {
    queries.push({ sql, parameters });
    if (/RETURNING provider_user_id::text, status/.test(sql)) return [{ provider_user_id: null, status: "processing" }];
    return [];
  };
  const fetcher = async (url) => String(url).includes("/oauth2/v2.0/token")
    ? response({ access_token: "t".repeat(64) })
    : response({ error: { code: "Authorization_RequestDenied", message: "raw tenant diagnostic must not persist" } }, 403);

  await assert.rejects(
    onboardTeamMemberWithEntra(target, { query, fetch: fetcher, env: environment() }),
    (error) => error instanceof EntraOnboardingError && error.code === "ENTRA_INVITATION_REJECTED_AUTHORIZATION_REQUESTDENIED",
  );
  const failure = queries.find(({ sql }) => /status = 'failed'/.test(sql));
  assert.ok(failure);
  assert.equal(failure.parameters[2], "ENTRA_INVITATION_REJECTED_AUTHORIZATION_REQUESTDENIED");
  assert.equal(JSON.stringify(queries).includes("raw tenant diagnostic"), false);
});

test("provisioning configuration fails closed without exact identifiers and monitored support", () => {
  assert.throws(() => getEntraProvisioningConfig(environment({ LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID: "client-id-not-object-id" })), /not configured correctly/i);
  assert.throws(() => getEntraProvisioningConfig(environment({ LOCAL801_ACCESS_SUPPORT_EMAIL: "" })), /support email/i);
  assert.equal(getEntraProvisioningConfig(environment({ LOCAL801_ENTRA_USER_PROVISIONING_ENABLED: "0" })).enabled, false);
});

test("migration and routes wire durable onboarding without storing passwords or invitation links", async () => {
  const [migration, createRoute, updateRoute, controls] = await Promise.all([
    readFile(new URL("../db/migrations/0029__entra_user_onboarding.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/team/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/team/users/[userHandle]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/TeamAccessControls.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /create table local801\.user_identity_onboarding/);
  assert.match(migration, /provider_user_id uuid/);
  assert.doesNotMatch(migration, /password|access_token|invite_redeem|client_secret/i);
  assert.match(createRoute, /onboardTeamMemberWithEntra/);
  assert.match(updateRoute, /retry_onboarding/);
  assert.match(controls, /Add user and send invitation/);
  assert.match(controls, /Retry onboarding/);
});
