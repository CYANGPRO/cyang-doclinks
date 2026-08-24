import assert from "node:assert/strict";
import test from "node:test";

import {
  safeProductionAuthClaimPresence,
  safeProductionAuthFailureCode,
  safeProductionAuthInternalFailure,
} from "../src/lib/auth-failure-diagnostics.ts";

test("production auth diagnostics expose only allowlisted denial codes", () => {
  assert.equal(safeProductionAuthFailureCode({ code: "MFA_REQUIRED" }), "MFA_REQUIRED");
  assert.equal(safeProductionAuthFailureCode({ code: "USER_NOT_PROVISIONED" }), "USER_NOT_PROVISIONED");
  assert.equal(safeProductionAuthFailureCode({ code: "secret@example.test" }), "AUTH_DENIED");
  assert.equal(safeProductionAuthFailureCode(new Error("protected member email")), "AUTH_DENIED");
  assert.equal(safeProductionAuthFailureCode(null), "AUTH_DENIED");
});

test("production auth diagnostics do not trust throwing or inherited code access", () => {
  const throwingCode = new Proxy({}, {
    has() { return true; },
    get() { throw new Error("do not serialize me"); },
  });
  assert.equal(safeProductionAuthFailureCode(throwingCode), "AUTH_DENIED");
  assert.equal(safeProductionAuthFailureCode(Object.create({ code: "MFA_REQUIRED" })), "MFA_REQUIRED");
});

test("production auth internal diagnostics expose only fixed categories and allowlisted codes", () => {
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "PiiProtectionError", code: "AUTHENTICATION_FAILED", message: "protected@example.test" }),
    { category: "pii", code: "AUTHENTICATION_FAILED" },
  );
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "PostgresError", code: "42P01", detail: "protected@example.test" }),
    { category: "database-query", code: "42P01" },
  );
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "Error", code: "42703", detail: "protected@example.test" }),
    { category: "database-query", code: "42703" },
  );
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "Local801TransactionError:USER_PROVISION", code: "23505" }),
    { category: "database-transaction", code: "USER_PROVISION" },
  );
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "ProductionAuthError", code: "PROTECTED_AUTH_ACCOUNT_FAILED" }),
    { category: "auth", code: "PROTECTED_AUTH_ACCOUNT_FAILED" },
  );
  assert.deepEqual(
    safeProductionAuthInternalFailure({ name: "Error", code: "protected@example.test" }),
    { category: "unknown", code: "UNCLASSIFIED" },
  );
  assert.doesNotMatch(JSON.stringify(safeProductionAuthInternalFailure({
    name: "PiiProtectionError",
    code: "protected@example.test",
  })), /protected|example\.test/);
});

test("production auth claim diagnostics expose presence booleans without values", () => {
  const diagnostics = safeProductionAuthClaimPresence({
    sub: "opaque-subject",
    tid: "opaque-tenant",
    oid: "opaque-object",
    emails: ["protected@example.test"],
    local801_email: "protected@example.test",
    preferred_username: "protected@example.test",
    email_verified: true,
    xms_edov: true,
    amr: ["pwd", "mfa"],
  });
  assert.deepEqual(diagnostics, {
    subject: true,
    tenant: true,
    objectId: true,
    email: false,
    emails: true,
    local801Email: true,
    verifiedPrimaryEmail: false,
    preferredUsername: true,
    emailVerified: true,
    emailDomainVerified: true,
    amrMfa: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /protected|example\.test|opaque/);
});

test("production auth claim diagnostics fail closed for hostile profiles", () => {
  const hostileProfile = new Proxy({}, { get() { throw new Error("protected@example.test"); } });
  assert.deepEqual(safeProductionAuthClaimPresence(hostileProfile), {
    subject: false,
    tenant: false,
    objectId: false,
    email: false,
    emails: false,
    local801Email: false,
    verifiedPrimaryEmail: false,
    preferredUsername: false,
    emailVerified: false,
    emailDomainVerified: false,
    amrMfa: false,
  });
});
