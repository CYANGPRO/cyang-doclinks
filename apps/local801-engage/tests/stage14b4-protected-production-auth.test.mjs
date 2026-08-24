import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authorizeProtectedProductionIdentity } from "../src/lib/pii-protected-production-auth.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const protectedAuthUrl = new URL("../src/lib/pii-protected-production-auth.ts", import.meta.url);
const productionAuthUrl = new URL("../src/lib/production-auth.ts", import.meta.url);
const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const authIdentityId = "33333333-3333-4333-8333-333333333333";

function protectedPiiEnv() {
  return {
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 41).toString("base64") }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 43).toString("base64") }),
    LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
  };
}

test("protected production auth resolves email and provider subject through blind indexes", async () => {
  const source = await readFile(protectedAuthUrl, "utf8");
  assert.match(source, /index_domain = 'user:email'/);
  assert.match(source, /auth:provider-subject:/);
  assert.match(source, /pii_exact_indexes/);
  assert.match(source, /decryptPiiField/);
  assert.match(source, /normalizePiiEmail\(account\.email\)/);
  assert.doesNotMatch(source, /lower\(app_user\.email\)\s*=\s*lower/);
  assert.doesNotMatch(source, /provider_subject\s*=\s*\$[0-9]+/);
  assert.match(source, /production_initializations/);
  assert.match(source, /initial_system_owner_id/);
  assert.match(source, /identity\.bootstrapObjectMatched/);
  assert.match(source, /role\.code = 'system_owner'/);
  assert.ok(source.indexOf("resolveUserByProtectedSubject") < source.indexOf("resolveBootstrapOwner(organization, query)"));
});

test("an established protected subject binding is resolved before the bootstrap marker", async () => {
  const previous = Object.fromEntries(Object.keys(protectedPiiEnv()).map((key) => [key, process.env[key]]));
  Object.assign(process.env, protectedPiiEnv());
  try {
    const keyConfig = getPiiKeyConfiguration();
    const email = "owner@example.test";
    const subject = "entra-subject-123";
    const protectedEmail = encryptPiiField(email, {
      organizationId, entity: "user", recordId: userId, field: "email",
    }, keyConfig);
    const protectedSubject = encryptPiiField(subject, {
      organizationId, entity: "auth-identity", recordId: authIdentityId, field: "provider-subject",
    }, keyConfig);
    const queries = [];
    const transactions = [];
    const binding = await authorizeProtectedProductionIdentity({
      providerId: "local801-oidc",
      subject,
      objectId: "834e272c-3b2b-40ae-92e6-017803ce3525",
      email,
      emailVerified: false,
      bootstrapObjectMatched: true,
      mfaVerified: true,
    }, {
      enabled: true,
      organizationSlug: "local801",
      providerId: "local801-oidc",
      providerName: "Microsoft Entra ID",
      wellKnown: "https://login.microsoftonline.com/example/v2.0/.well-known/openid-configuration",
      clientId: "client",
      clientSecret: "secret",
      bootstrapObjectId: "834e272c-3b2b-40ae-92e6-017803ce3525",
      mfaClaim: "amr",
      mfaValue: "mfa",
    }, {
      query: async (sql, parameters) => {
        queries.push(sql);
        if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
        if (sql.includes("protected-bound-subject")) return [{
          organization_slug: "local801",
          organization_id: organizationId,
          user_id: userId,
          auth_session_version: 4,
          role: "system_owner",
          email_encrypted_payload: protectedEmail.encryptedPayload,
          email_encryption_key_version: protectedEmail.encryptionKeyVersion,
          email_encryption_format_version: protectedEmail.encryptionFormatVersion,
          auth_identity_id: authIdentityId,
          provider_subject_encrypted_payload: protectedSubject.encryptedPayload,
          provider_subject_encryption_key_version: protectedSubject.encryptionKeyVersion,
          provider_subject_encryption_format_version: protectedSubject.encryptionFormatVersion,
        }];
        throw new Error(`Unexpected fallback query: ${sql}`);
      },
      transaction: async (statements) => transactions.push(statements),
    });
    assert.deepEqual(binding, {
      organizationSlug: "local801",
      userId,
      email,
      role: "system_owner",
      sessionVersion: 4,
    });
    assert.equal(queries.length, 2);
    assert.doesNotMatch(queries.join("\n"), /protected-bootstrap-owner|protected-email-lookup/);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].length, 2);
    assert.match(transactions[0][0].sql, /UPDATE local801\.auth_identities SET last_sign_in_at/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the configured bootstrap object can atomically rebind one legacy active system owner", async () => {
  const previous = Object.fromEntries(Object.keys(protectedPiiEnv()).map((key) => [key, process.env[key]]));
  Object.assign(process.env, protectedPiiEnv());
  try {
    const keyConfig = getPiiKeyConfiguration();
    const email = "owner@example.test";
    const currentSubject = "current-entra-subject";
    const protectedEmail = encryptPiiField(email, {
      organizationId, entity: "user", recordId: userId, field: "email",
    }, keyConfig);
    const userRow = {
      organization_slug: "local801",
      organization_id: organizationId,
      user_id: userId,
      auth_session_version: 4,
      role: "system_owner",
      email_encrypted_payload: protectedEmail.encryptedPayload,
      email_encryption_key_version: protectedEmail.encryptionKeyVersion,
      email_encryption_format_version: protectedEmail.encryptionFormatVersion,
    };
    const queries = [];
    const transactions = [];
    const binding = await authorizeProtectedProductionIdentity({
      providerId: "local801-oidc",
      subject: currentSubject,
      objectId: "834e272c-3b2b-40ae-92e6-017803ce3525",
      email,
      emailVerified: false,
      bootstrapObjectMatched: true,
      mfaVerified: true,
    }, {
      enabled: true,
      organizationSlug: "local801",
      providerId: "local801-oidc",
      providerName: "Microsoft Entra ID",
      wellKnown: "https://login.microsoftonline.com/example/v2.0/.well-known/openid-configuration",
      clientId: "client",
      clientSecret: "secret",
      bootstrapObjectId: "834e272c-3b2b-40ae-92e6-017803ce3525",
      mfaClaim: "amr",
      mfaValue: "mfa",
    }, {
      query: async (sql, parameters) => {
        queries.push(sql);
        if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
        if (sql.includes("protected-bound-subject")) return [];
        if (sql.includes("protected-bootstrap-owner")) return [];
        if (sql.includes("protected-legacy-bootstrap-owner")) return [userRow];
        if (sql.includes("protected-subject-lookup")) {
          assert.equal(parameters.length, 5);
          assert.deepEqual(parameters.slice(0, 3), [organizationId, "auth:provider-subject:local801-oidc", "local801-oidc"]);
          assert.doesNotMatch(sql, /\$6/);
          return [];
        }
        if (sql.includes("protected-user-identity")) return [{
          auth_identity_id: authIdentityId,
          user_id: userId,
          provider_subject_encrypted_payload: "stale-unreadable-ciphertext",
          provider_subject_encryption_key_version: "retired-key",
          provider_subject_encryption_format_version: 1,
        }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      transaction: async (statements) => transactions.push(statements),
    });
    assert.deepEqual(binding, {
      organizationSlug: "local801",
      userId,
      email,
      role: "system_owner",
      sessionVersion: 4,
    });
    assert.match(queries.join("\n"), /protected-legacy-bootstrap-owner/);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].length, 5);
    assert.match(transactions[0][0].sql, /protected-bootstrap-rebind-delete-indexes/);
    assert.match(transactions[0][1].sql, /protected-bootstrap-rebind-identity/);
    assert.match(transactions[0][2].sql, /protected-bootstrap-rebind-indexes/);
    assert.doesNotMatch(transactions.map((statements) => statements.map((statement) => statement.sql).join("\n")).join("\n"),
      /INSERT INTO local801\.auth_identities/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("new protected OIDC links place only non-PII placeholders in legacy identity columns", async () => {
  const source = await readFile(protectedAuthUrl, "utf8");
  assert.match(source, /placeholderSubject = `protected:\$\{identityId\}`/);
  assert.match(source, /placeholderEmail = `protected-\$\{identityId\}@invalid\.local`/);
  assert.match(source, /INSERT INTO local801\.auth_identity_pii/);
  assert.match(source, /provider_subject_encrypted_payload/);
  assert.match(source, /linked_email_encrypted_payload/);
});

test("production auth dispatches to protected implementation only after the database protection switch", async () => {
  const source = await readFile(productionAuthUrl, "utf8");
  const gates = source.match(/LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/g) ?? [];
  assert.equal(gates.length >= 2, true);
  assert.match(source, /authorizeProtectedProductionIdentity/);
  assert.match(source, /resolveProtectedProductionSessionBinding/);
});
