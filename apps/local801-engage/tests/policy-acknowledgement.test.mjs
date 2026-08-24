import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acceptCurrentAccessPolicy,
  PolicyAcknowledgementError,
} from "../src/lib/policy-acknowledgement.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const acknowledgementId = "33333333-3333-4333-8333-333333333333";

function transactionWith(row, capture) {
  return async (callback) => callback(async (sql, parameters) => {
    capture.sql = sql;
    capture.parameters = parameters;
    return [row];
  });
}

test("current policy acceptance locks the live tenant user and records one redacted audit event atomically", async () => {
  const capture = {};
  const audits = [];
  const result = await acceptCurrentAccessPolicy({
    organizationSlug: "local801",
    userId,
    sessionVersion: 7,
  }, {
    transaction: transactionWith({ acknowledgement_id: acknowledgementId, organization_id: organizationId, inserted: true }, capture),
    audit: async (event, query) => {
      audits.push(event);
      assert.equal(typeof query, "function");
    },
  });

  assert.deepEqual(capture.parameters, ["local801", userId, 7, "privacy-acceptable-use", "2026-08-18"]);
  assert.match(capture.sql, /app_user\.auth_session_version = \$3::integer/);
  assert.match(capture.sql, /app_user\.deactivated_at IS NULL/);
  assert.match(capture.sql, /organization\.archived_at IS NULL/);
  assert.match(capture.sql, /FOR UPDATE OF app_user/);
  assert.match(capture.sql, /ON CONFLICT \(organization_id, user_id, policy_key, policy_version\) DO NOTHING/);
  assert.equal(result.newlyAcknowledged, true);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    eventType: "policy.acknowledged",
    actorId: userId,
    organizationId,
    subjectType: "policy_acknowledgement",
    subjectId: acknowledgementId,
    payload: { policyKey: "privacy-acceptable-use", policyVersion: "2026-08-18" },
  });
});

test("replayed policy acceptance is idempotent and does not duplicate audit", async () => {
  let auditCalls = 0;
  const result = await acceptCurrentAccessPolicy({ organizationSlug: "local801", userId, sessionVersion: 7 }, {
    transaction: transactionWith({ acknowledgement_id: acknowledgementId, organization_id: organizationId, inserted: false }, {}),
    audit: async () => { auditCalls += 1; },
  });
  assert.equal(result.newlyAcknowledged, false);
  assert.equal(auditCalls, 0);
});

test("policy acceptance rejects invalid or stale identity evidence", async () => {
  await assert.rejects(acceptCurrentAccessPolicy({ organizationSlug: "", userId, sessionVersion: 7 }), PolicyAcknowledgementError);
  await assert.rejects(acceptCurrentAccessPolicy({ organizationSlug: "local801", userId, sessionVersion: 0 }), PolicyAcknowledgementError);
  await assert.rejects(acceptCurrentAccessPolicy({ organizationSlug: "local801", userId, sessionVersion: 7 }, {
    transaction: transactionWith(undefined, {}),
  }), PolicyAcknowledgementError);
});

test("policy migration and authenticated route enforce versioned append-only evidence", async () => {
  const [migration, authz, page, action, productionAuth, protectedAuth, frame] = await Promise.all([
    readFile(new URL("../db/migrations/0028__user_policy_acknowledgements.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/authz.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/privacy/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/privacy/actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/production-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/pii-protected-production-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/RouteAwareFrame.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /^begin;/i);
  assert.match(migration, /create table local801\.user_policy_acknowledgements/);
  assert.match(migration, /unique \(organization_id, user_id, policy_key, policy_version\)/);
  assert.doesNotMatch(migration, /ip_address|user_agent|email|display_name/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(authz, /return user\?\.policyAcknowledged \? user : null/);
  assert.match(authz, /getPolicyAcknowledgementUser/);
  assert.match(page, /Do not store or synchronize protected member records for offline use/);
  assert.match(page, /required type="checkbox"/);
  assert.match(action, /pendingUser\.sessionVersion/);
  assert.match(productionAuth, /user_policy_acknowledgements/);
  assert.match(protectedAuth, /user_policy_acknowledgements/);
  assert.match(frame, /pathname === "\/privacy"/);
});
