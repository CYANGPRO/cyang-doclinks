import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acceptRequiredAccessPolicies,
  PolicyAcknowledgementError,
} from "../src/lib/policy-acknowledgement.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const acknowledgementId = "33333333-3333-4333-8333-333333333333";
const mapeAcknowledgementId = "44444444-4444-4444-8444-444444444444";

function transactionWith(rows, capture) {
  return async (callback) => callback(async (sql, parameters) => {
    capture.sql = sql;
    capture.parameters = parameters;
    return rows;
  });
}

const acknowledgementRows = (inserted) => [{
  acknowledgement_id: mapeAcknowledgementId,
  organization_id: organizationId,
  policy_key: "mape-data-privacy-agreement",
  policy_version: "2026-09-02",
  inserted,
}, {
  acknowledgement_id: acknowledgementId,
  organization_id: organizationId,
  policy_key: "privacy-acceptable-use",
  policy_version: "2026-08-18",
  inserted,
}];

test("required policy acceptance locks the live tenant user and records two separate redacted audit events atomically", async () => {
  const capture = {};
  const audits = [];
  const result = await acceptRequiredAccessPolicies({
    organizationSlug: "local801",
    userId,
    sessionVersion: 7,
  }, {
    transaction: transactionWith(acknowledgementRows(true), capture),
    audit: async (event, query) => {
      audits.push(event);
      assert.equal(typeof query, "function");
    },
  });

  assert.deepEqual(capture.parameters, [
    "local801", userId, 7,
    "privacy-acceptable-use", "2026-08-18",
    "mape-data-privacy-agreement", "2026-09-02",
  ]);
  assert.match(capture.sql, /app_user\.auth_session_version = \$3::integer/);
  assert.match(capture.sql, /app_user\.deactivated_at IS NULL/);
  assert.match(capture.sql, /organization\.archived_at IS NULL/);
  assert.match(capture.sql, /FOR UPDATE OF app_user/);
  assert.match(capture.sql, /ON CONFLICT \(organization_id, user_id, policy_key, policy_version\) DO NOTHING/);
  assert.match(capture.sql, /VALUES \(\$4::text, \$5::text\), \(\$6::text, \$7::text\)/);
  assert.equal(result.newlyAcknowledgedCount, 2);
  assert.equal(result.acknowledgements.length, 2);
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[1], {
    eventType: "policy.acknowledged",
    actorId: userId,
    organizationId,
    subjectType: "policy_acknowledgement",
    subjectId: acknowledgementId,
    payload: { policyKey: "privacy-acceptable-use", policyVersion: "2026-08-18" },
  });
  assert.deepEqual(audits[0].payload, { policyKey: "mape-data-privacy-agreement", policyVersion: "2026-09-02" });
});

test("replayed policy acceptance is idempotent and does not duplicate audit", async () => {
  let auditCalls = 0;
  const result = await acceptRequiredAccessPolicies({ organizationSlug: "local801", userId, sessionVersion: 7 }, {
    transaction: transactionWith(acknowledgementRows(false), {}),
    audit: async () => { auditCalls += 1; },
  });
  assert.equal(result.newlyAcknowledgedCount, 0);
  assert.equal(auditCalls, 0);
});

test("policy acceptance rejects invalid or stale identity evidence", async () => {
  await assert.rejects(acceptRequiredAccessPolicies({ organizationSlug: "", userId, sessionVersion: 7 }), PolicyAcknowledgementError);
  await assert.rejects(acceptRequiredAccessPolicies({ organizationSlug: "local801", userId, sessionVersion: 0 }), PolicyAcknowledgementError);
  await assert.rejects(acceptRequiredAccessPolicies({ organizationSlug: "local801", userId, sessionVersion: 7 }, {
    transaction: transactionWith([], {}),
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
  assert.match(page, /name="acceptedCatPolicy" required type="checkbox"/);
  assert.match(page, /name="acceptedMapePolicy" required type="checkbox"/);
  assert.match(page, /You must follow MAPE&amp;apos;s Data Privacy Agreement|You must follow MAPE&apos;s Data Privacy Agreement/);
  assert.match(page, /MAPE Data Privacy Agreement Form/);
  assert.match(page, /target="_blank"/);
  assert.match(action, /acceptedCatPolicy/);
  assert.match(action, /acceptedMapePolicy/);
  assert.match(action, /pendingUser\.sessionVersion/);
  assert.match(productionAuth, /user_policy_acknowledgements/);
  assert.match(productionAuth, /2 = \(/);
  assert.match(protectedAuth, /user_policy_acknowledgements/);
  assert.match(protectedAuth, /2 = \(/);
  assert.match(frame, /pathname === "\/privacy"/);
});
