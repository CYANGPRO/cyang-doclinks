import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  __testing,
  changeTeamMemberRole,
  getTeamAccessPage,
  provisionTeamMember,
  preflightTeamMemberRemoval,
  removeTeamMemberFromCat,
  resolveTeamMemberRemovalTarget,
  revokeTeamMemberSessions,
  setTeamMemberActive,
  teamReadSafeCode,
  TeamAccessError,
} from "../src/lib/team-access.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const newUserId = "44444444-4444-4444-8444-444444444444";
const handle = "a".repeat(64);
const context = (role = "system_owner") => ({ organizationId, organizationSlug: "local801-preview", userId: actorId, email: `${role}@example.test`, role });

function target(overrides = {}) {
  return { id: targetId, role: "cat_lead", deactivated_at: null, ...overrides };
}

function deps(overrides = {}) {
  const transactions = [];
  return {
    transactions,
    values: {
      transaction: async (statements) => transactions.push(statements),
      uuid: () => newUserId,
      ...overrides,
    },
  };
}

test("Team read diagnostics expose only allowlisted non-PII failure codes", () => {
  assert.equal(teamReadSafeCode({ name: "PiiProtectionError", code: "AUTHENTICATION_FAILED", email: "hidden@example.test" }), "AUTHENTICATION_FAILED");
  assert.equal(teamReadSafeCode({ name: "WorkspaceContextError" }), "WORKSPACE_CONTEXT_UNAVAILABLE");
  assert.equal(teamReadSafeCode({ code: "42P01", detail: "hidden@example.test" }), "DATABASE_42P01");
  assert.equal(teamReadSafeCode({ code: "hidden@example.test" }), "TEAM_ACCESS_UNAVAILABLE");
  assert.equal(teamReadSafeCode(new Error("hidden@example.test")), "TEAM_ACCESS_UNAVAILABLE");
});

test("Team page exposes opaque handles and bounded authorization metadata, not provider subjects or session versions", async () => {
  let sqlText = "";
  const page = await getTeamAccessPage(context(), async (sql, parameters) => {
    sqlText = sql;
    assert.deepEqual(parameters, [organizationId]);
    return [{
      handle,
      display_name: "Synthetic Lead",
      email: "lead@example.test",
      role: "cat_lead",
      deactivated_at: null,
      invited_at: "2026-08-15T00:00:00.000Z",
      last_authenticated_at: null,
      last_mfa_at: null,
      identity_linked: false,
    }];
  });
  assert.equal(page.members[0].handle, handle);
  assert.equal(page.members[0].active, true);
  assert.equal(page.members[0].identityLinked, false);
  assert.equal("userId" in page.members[0], false);
  assert.match(sqlText, /public\.digest\('user:' \|\| \$1::text/);
  assert.match(sqlText, /LIMIT 500/);
  assert.doesNotMatch(sqlText, /provider_subject|auth_session_version/);
});

test("system owners can assign all roles while local administrators can assign only lower roles", () => {
  for (const role of __testing.assignableRoles) assert.doesNotThrow(() => __testing.assertRoleAssignable("system_owner", role));
  for (const role of __testing.lowerRoles) assert.doesNotThrow(() => __testing.assertRoleAssignable("local_admin", role));
  assert.throws(() => __testing.assertRoleAssignable("local_admin", "system_owner"), /cannot assign/i);
  assert.throws(() => __testing.assertRoleAssignable("local_admin", "local_admin"), /cannot assign/i);
  assert.throws(() => __testing.assertTargetManageable("local_admin", "system_owner"), /system owner/i);
  assert.throws(() => __testing.assertTargetManageable("local_admin", "local_admin"), /system owner/i);
  assert.doesNotThrow(() => __testing.assertTargetManageable("local_admin", "cat_admin"));
});

test("provisioning creates a passwordless application user and one role atomically with audit", async () => {
  const state = deps({ query: async (sql, parameters) => {
    if (sql.includes("SELECT event_hash")) return [];
    assert.match(sql, /SELECT 1/);
    assert.deepEqual(parameters, [organizationId, "new.user@example.test"]);
    return [];
  } });
  await provisionTeamMember(context(), { email: " New.User@Example.Test ", displayName: " New  User ", role: "cat_member" }, state.values);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].length, 2);
  const mutation = state.transactions[0][0];
  assert.match(mutation.sql, /INSERT INTO local801\.users/);
  assert.match(mutation.sql, /INSERT INTO local801\.workspace_user_roles/);
  assert.match(mutation.sql, /role\.code = \$6::text/);
  assert.match(mutation.sql, /role\.code IN \('system_owner','local_admin'\)/);
  assert.deepEqual(mutation.parameters, [organizationId, actorId, "system_owner", newUserId, "new.user@example.test", "cat_member", "New User"]);
  assert.doesNotMatch(mutation.sql, /password|totp|secret/i);
  assert.match(state.transactions[0][1].sql, /local801\.audit_events/);
});

test("provisioning rejects an existing protected email before attempting another user insert", async () => {
  let transactions = 0;
  await assert.rejects(
    provisionTeamMember(context(), { email: "existing@example.test", displayName: "Existing User", role: "cat_lead" }, {
      query: async () => [{ found: true }],
      transaction: async () => { transactions += 1; },
    }),
    (error) => error instanceof TeamAccessError
      && error.code === "EMAIL_EXISTS"
      && /Retry onboarding/.test(error.message),
  );
  assert.equal(transactions, 0);
});

test("local administrator provisioning cannot escalate to admin or owner", async () => {
  let calls = 0;
  await assert.rejects(provisionTeamMember(context("local_admin"), { email: "x@example.test", displayName: "X", role: "system_owner" }, {
    query: async () => { calls += 1; return []; },
  }), (error) => error instanceof TeamAccessError && error.code === "ROLE_NOT_ASSIGNABLE");
  assert.equal(calls, 0);
});

test("role changes revoke sessions, recheck manager privilege in SQL, and are audited atomically", async () => {
  const state = deps({ query: async (sql, parameters) => {
    if (sql.includes("resolve-target")) {
      assert.deepEqual(parameters, [organizationId, handle]);
      return [target()];
    }
    if (sql.includes("SELECT event_hash")) return [];
    return [];
  } });
  await changeTeamMemberRole(context(), handle, "cat_admin", state.values);
  const mutation = state.transactions[0][0];
  assert.match(mutation.sql, /DELETE FROM local801\.workspace_user_roles/);
  assert.match(mutation.sql, /INSERT INTO local801\.workspace_user_roles/);
  assert.match(mutation.sql, /auth_session_version = auth_session_version \+ 1/);
  assert.match(mutation.sql, /role\.code = \$3::text/);
  assert.match(mutation.sql, /role\.code IN \('system_owner','local_admin'\)/);
  assert.deepEqual(mutation.parameters, [organizationId, actorId, "system_owner", targetId, "cat_admin"]);
  assert.match(state.transactions[0][1].sql, /local801\.audit_events/);
});

test("Team management blocks self changes and protects owner/admin peers from local administrators", async () => {
  const selfQuery = async () => [target({ id: actorId })];
  await assert.rejects(changeTeamMemberRole(context(), handle, "cat_member", { query: selfQuery }), /own role/i);
  await assert.rejects(setTeamMemberActive(context(), handle, false, { query: selfQuery }), /own account/i);

  for (const protectedRole of ["system_owner", "local_admin"]) {
    const protectedQuery = async () => [target({ role: protectedRole })];
    await assert.rejects(changeTeamMemberRole(context("local_admin"), handle, "cat_member", { query: protectedQuery }), /system owner/i);
    await assert.rejects(setTeamMemberActive(context("local_admin"), handle, false, { query: protectedQuery }), /system owner/i);
    await assert.rejects(revokeTeamMemberSessions(context("local_admin"), handle, { query: protectedQuery }), /system owner/i);
  }
});

test("deactivate/reactivate and revoke sessions always increment auth session version with hierarchy recheck", async () => {
  for (const operation of [
    (state) => setTeamMemberActive(context(), handle, false, state),
    (state) => revokeTeamMemberSessions(context(), handle, state),
  ]) {
    const transactions = [];
    await operation({
      query: async (sql) => sql.includes("resolve-target") ? [target()] : [],
      transaction: async (statements) => transactions.push(statements),
    });
    assert.match(transactions[0][0].sql, /auth_session_version = auth_session_version \+ 1/);
    assert.match(transactions[0][0].sql, /protected_role\.code IN \('system_owner','local_admin'\)/);
    assert.match(transactions[0][1].sql, /local801\.audit_events/);
  }

  const reactivateTransactions = [];
  await setTeamMemberActive(context(), handle, true, {
    query: async (sql) => sql.includes("resolve-target") ? [target({ deactivated_at: "2026-08-15T00:00:00.000Z" })] : [],
    transaction: async (statements) => reactivateTransactions.push(statements),
  });
  assert.match(reactivateTransactions[0][0].sql, /deactivated_at = CASE WHEN \$5::boolean THEN NULL ELSE now\(\) END/);
  assert.match(reactivateTransactions[0][0].sql, /auth_session_version = auth_session_version \+ 1/);
});

test("unused invite removal requires no CAT sign-in or identity and performs a rollback preflight", async () => {
  const providerUserId = "55555555-5555-4555-8555-555555555555";
  const query = async (sql, parameters) => {
    if (sql.includes("resolve-target")) return [target()];
    if (sql.includes("resolve-removal-target")) {
      assert.deepEqual(parameters, [organizationId, targetId]);
      return [{ provider_user_id: providerUserId, last_authenticated_at: null, identity_linked: false }];
    }
    return [];
  };
  const removalTarget = await resolveTeamMemberRemovalTarget(context(), handle, query);
  assert.equal(removalTarget.providerUserId, providerUserId);

  const statements = [];
  const transaction = async (callback) => callback(async (sql, parameters) => {
    statements.push({ sql, parameters });
    if (/DELETE FROM local801\.users/.test(sql)) return [{ id: targetId }];
    return [];
  });
  assert.deepEqual(await preflightTeamMemberRemoval(context(), removalTarget, transaction), { removable: true });
  assert.match(statements[0].sql, /DELETE FROM local801\.pii_exact_indexes/);
  assert.match(statements[1].sql, /last_authenticated_at IS NULL/);
  assert.match(statements[1].sql, /NOT EXISTS[\s\S]*local801\.auth_identities/);
  assert.match(statements[1].sql, /role\.code IN \('system_owner','local_admin'\)/);
});

test("unused invite removal is audited atomically and releases the CAT email for re-adding", async () => {
  const removalTarget = { organizationId, userId: targetId, providerUserId: null, role: "cat_lead" };
  const statements = [];
  const result = await removeTeamMemberFromCat(context(), removalTarget, {
    query: async (sql) => sql.includes("SELECT event_hash") ? [] : [],
    transaction: async (callback) => callback(async (sql, parameters) => {
      statements.push({ sql, parameters });
      if (/DELETE FROM local801\.users/.test(sql)) return [{ id: targetId }];
      return [];
    }),
  });
  assert.deepEqual(result, { removed: true });
  assert.match(statements[0].sql, /DELETE FROM local801\.pii_exact_indexes/);
  assert.match(statements[1].sql, /DELETE FROM local801\.users/);
  assert.match(statements[2].sql, /INSERT INTO local801\.audit_events/);
});

test("accounts with sign-in or referenced CAT history fail closed and must be deactivated", async () => {
  const signedInQuery = async (sql) => sql.includes("resolve-target")
    ? [target()]
    : [{ provider_user_id: null, last_authenticated_at: "2026-08-24T00:00:00Z", identity_linked: true }];
  await assert.rejects(
    resolveTeamMemberRemovalTarget(context(), handle, signedInQuery),
    (error) => error instanceof TeamAccessError && error.code === "ACCOUNT_HAS_HISTORY",
  );

  const removalTarget = { organizationId, userId: targetId, providerUserId: null, role: "cat_lead" };
  await assert.rejects(
    preflightTeamMemberRemoval(context(), removalTarget, async (callback) => callback(async (sql) => {
      if (/DELETE FROM local801\.users/.test(sql)) throw Object.assign(new Error("foreign key"), { code: "23503" });
      return [];
    })),
    (error) => error instanceof TeamAccessError && error.code === "ACCOUNT_HAS_HISTORY",
  );
});

test("non-admin roles are denied before Team SQL", async () => {
  for (const role of ["membership_data_manager", "cat_admin", "cat_lead", "cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(getTeamAccessPage(context(role), async () => { calls += 1; return []; }), /not authorized/i);
    assert.equal(calls, 0);
  }
});

test("Team APIs are same-origin, bounded, production-capable, and server-authorized", async () => {
  const [helper, createRoute, updateRoute, page, controls] = await Promise.all([
    readFile(new URL("../src/lib/team-mutation-http.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/team/users/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/team/users/[userHandle]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/team/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/TeamAccessControls.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(helper, /hasExactSameOrigin\(request\)/);
  assert.match(helper, /requirePreviewUser\("manageUsers"\)/);
  assert.match(helper, /MAX_JSON_BYTES = 4_096/);
  assert.doesNotMatch(helper, /VERCEL_ENV.*production.*404/);
  assert.match(createRoute, /provisionTeamMember/);
  assert.match(updateRoute, /changeTeamMemberRole/);
  assert.match(updateRoute, /setTeamMemberActive/);
  assert.match(updateRoute, /revokeTeamMemberSessions/);
  assert.match(updateRoute, /remove_account/);
  assert.match(page, /CAT never creates or emails a password/);
  assert.match(page, /grants access to the Entra enterprise application/);
  assert.match(page, /System Owner required/);
  assert.match(controls, /Sign out everywhere/);
  assert.match(controls, /Confirm removal/);
  assert.match(controls, /removalConfirmation !== displayName/);
  assert.doesNotMatch(controls, /window\.prompt/);
});
