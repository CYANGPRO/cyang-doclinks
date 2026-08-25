import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authorizeProtectedProductionIdentity,
  resolveProtectedProductionSessionBinding,
} from "../src/lib/pii-protected-production-auth.ts";
import { encryptPiiField, getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const protectedAuthUrl = new URL("../src/lib/pii-protected-production-auth.ts", import.meta.url);
const productionAuthUrl = new URL("../src/lib/production-auth.ts", import.meta.url);
const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const authIdentityId = "33333333-3333-4333-8333-333333333333";
const key = (byte) => Buffer.alloc(32, byte).toString("base64");
const allRoles = [
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
];

function withPiiKeys() {
  const previous = {
    encryption: process.env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS,
    activeEncryption: process.env.LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION,
    blind: process.env.LOCAL801_PII_BLIND_INDEX_KEYS,
    activeBlind: process.env.LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION,
  };
  process.env.LOCAL801_PII_ENCRYPTION_MASTER_KEYS = JSON.stringify({ v1: key(11) });
  process.env.LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION = "v1";
  process.env.LOCAL801_PII_BLIND_INDEX_KEYS = JSON.stringify({ v1: key(12) });
  process.env.LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION = "v1";
  return () => {
    for (const [name, value] of [
      ["LOCAL801_PII_ENCRYPTION_MASTER_KEYS", previous.encryption],
      ["LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION", previous.activeEncryption],
      ["LOCAL801_PII_BLIND_INDEX_KEYS", previous.blind],
      ["LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION", previous.activeBlind],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function protectedPiiEnv() {
  return {
    LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: key(41) }),
    LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
    LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: key(43) }),
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
      organizationId,
      userId,
      email,
      role: "system_owner",
      sessionVersion: 4,
      policyAcknowledged: false,
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
      organizationId,
      userId,
      email,
      role: "system_owner",
      sessionVersion: 4,
      policyAcknowledged: false,
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

test("a verified directory bootstrap object migrates the system owner without the stale onboarding object", async () => {
  const previous = Object.fromEntries(Object.keys(protectedPiiEnv()).map((key) => [key, process.env[key]]));
  Object.assign(process.env, protectedPiiEnv());
  try {
    const keyConfig = getPiiKeyConfiguration();
    const email = "owner@example.test";
    const tenantId = "aaaaaaaa-0000-4000-8000-000000000001";
    const objectId = "834e272c-3b2b-40ae-92e6-017803ce3525";
    const subject = `${tenantId}:${objectId}`;
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
      providerId: "local801-workforce",
      subject,
      objectId,
      email: "",
      emailVerified: false,
      bootstrapObjectMatched: true,
      mfaVerified: true,
      directoryObjectVerified: true,
    }, {
      enabled: true,
      organizationSlug: "local801",
      providerId: "local801-workforce",
      providerName: "Microsoft Entra ID",
      wellKnown: "https://login.microsoftonline.com/example/v2.0/.well-known/openid-configuration",
      clientId: "client",
      clientSecret: "secret",
      tenantId,
      bootstrapObjectId: objectId,
      mfaClaim: "amr",
      mfaValue: "mfa",
    }, {
      query: async (sql, parameters) => {
        queries.push(sql);
        if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
        if (sql.includes("protected-bound-subject-account")) return [];
        if (sql.includes("protected-bootstrap-owner")) return [];
        if (sql.includes("protected-legacy-bootstrap-owner")) return [userRow];
        if (sql.includes("protected-subject-lookup")) {
          assert.deepEqual(parameters.slice(0, 3), [organizationId, "auth:provider-subject:local801-workforce", "local801-workforce"]);
          return [];
        }
        if (sql.includes("protected-user-identity")) return [];
        throw new Error(`Unexpected query: ${sql}`);
      },
      transaction: async (statements) => transactions.push(statements),
    });
    assert.equal(binding.userId, userId);
    assert.equal(binding.role, "system_owner");
    assert.match(queries.join("\n"), /protected-legacy-bootstrap-owner/);
    assert.doesNotMatch(queries.join("\n"), /protected-onboarding-object-lookup/);
    assert.equal(transactions.length, 1);
    assert.match(transactions[0][0].sql, /production-auth:protected-bind-identity/);
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

test("protected session validation combines organization and active-user authorization in one query", async () => {
  const restore = withPiiKeys();
  try {
    const encryptedEmail = encryptPiiField("owner@example.test", {
      organizationId,
      entity: "user",
      recordId: userId,
      field: "email",
    }, getPiiKeyConfiguration());
    const calls = [];
    const binding = await resolveProtectedProductionSessionBinding({
      organizationSlug: "local801",
      userId,
      sessionVersion: 4,
    }, async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{
        organization_slug: "local801",
        organization_id: organizationId,
        user_id: userId,
        auth_session_version: 4,
        role: "system_owner",
        email_encrypted_payload: encryptedEmail.encryptedPayload,
        email_encryption_key_version: encryptedEmail.encryptionKeyVersion,
        email_encryption_format_version: encryptedEmail.encryptionFormatVersion,
        policy_acknowledged: true,
      }];
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /organization\.slug = \$1::text/);
    assert.match(calls[0].sql, /app_user\.id = \$2::uuid/);
    assert.deepEqual(calls[0].parameters, [
      "local801",
      userId,
      4,
      "privacy-acceptable-use",
      "2026-08-18",
    ]);
    assert.equal(binding?.organizationId, organizationId);
    assert.equal(binding?.email, "owner@example.test");
  } finally {
    restore();
  }
});

test("role assignments allow multiple users per role while keeping exactly one role per user", async () => {
  const [source, roleMigration, onboardingMigration] = await Promise.all([
    readFile(protectedAuthUrl, "utf8"),
    readFile(new URL("../db/migrations/0011__production_auth_and_team_access.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/migrations/0029__entra_user_onboarding.sql", import.meta.url), "utf8"),
  ]);
  assert.match(source, /protected-onboarding-object-lookup/);
  const onboardingLookup = source.slice(
    source.indexOf("async function resolveUserByOnboardingObjectId"),
    source.indexOf("async function resolveAccountByProtectedSubject"),
  );
  assert.doesNotMatch(onboardingLookup, /protected-bootstrap-system-owner|role\.code = 'system_owner'/);
  assert.match(roleMigration, /workspace_user_roles_one_role_per_user_uq[\s\S]*\(user_id\)/);
  assert.doesNotMatch(roleMigration, /unique[^;]*\(role_id\)/i);
  assert.match(onboardingMigration, /unique index user_identity_onboarding_provider_user_uq/);
});

test("immutable subject bindings authorize every supported role without a single-occupant assumption", async () => {
  const restore = withPiiKeys();
  try {
    const storedEmail = "person@example.test";
    const subject = "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002";
    const keyConfig = getPiiKeyConfiguration();
    const encryptedEmail = encryptPiiField(storedEmail, {
      organizationId,
      entity: "user",
      recordId: userId,
      field: "email",
    }, keyConfig);
    const encryptedSubject = encryptPiiField(subject, {
      organizationId,
      entity: "auth-identity",
      recordId: authIdentityId,
      field: "provider-subject",
    }, keyConfig);

    for (const role of allRoles) {
      const result = await authorizeProtectedProductionIdentity({
        providerId: "local801-oidc",
        subject,
        email: "",
        emailVerified: false,
        mfaVerified: true,
        directoryObjectVerified: true,
      }, {
        enabled: true,
        organizationSlug: "local801",
        providerId: "local801-oidc",
        providerName: "Microsoft Entra ID",
        wellKnown: "https://identity.example.test/.well-known/openid-configuration",
        clientId: "client",
        clientSecret: "secret",
        tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
        mfaClaim: "amr",
        mfaValue: "mfa",
      }, {
        query: async (sql) => {
          if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
          if (sql.includes("protected-bound-subject-account")) return [{
            organization_slug: "local801",
            organization_id: organizationId,
            user_id: userId,
            auth_session_version: 1,
            role,
            email_encrypted_payload: encryptedEmail.encryptedPayload,
            email_encryption_key_version: encryptedEmail.encryptionKeyVersion,
            email_encryption_format_version: encryptedEmail.encryptionFormatVersion,
            policy_acknowledged: true,
            auth_identity_id: authIdentityId,
            provider_subject_encrypted_payload: encryptedSubject.encryptedPayload,
            provider_subject_encryption_key_version: encryptedSubject.encryptionKeyVersion,
            provider_subject_encryption_format_version: encryptedSubject.encryptionFormatVersion,
          }];
          throw new Error(`unexpected query for ${role}`);
        },
        transaction: async () => {},
      });
      assert.equal(result.role, role);
    }
  } finally {
    restore();
  }
});

test("first sign-in binds the exact CAT account recorded by Entra onboarding regardless of role occupancy", async () => {
  const restore = withPiiKeys();
  try {
    const storedEmail = "owner@example.test";
    const encryptedEmail = encryptPiiField(storedEmail, {
      organizationId,
      entity: "user",
      recordId: userId,
      field: "email",
    }, getPiiKeyConfiguration());
    const onboardedAccount = {
      organization_slug: "local801",
      organization_id: organizationId,
      user_id: userId,
      auth_session_version: 1,
      role: "cat_lead",
      email_encrypted_payload: encryptedEmail.encryptedPayload,
      email_encryption_key_version: encryptedEmail.encryptionKeyVersion,
      email_encryption_format_version: encryptedEmail.encryptionFormatVersion,
      policy_acknowledged: false,
    };
    const sqlCalls = [];
    const transactions = [];
    const result = await authorizeProtectedProductionIdentity({
      providerId: "local801-oidc",
      subject: "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002",
      email: "",
      emailVerified: false,
      mfaVerified: true,
      directoryObjectVerified: true,
    }, {
      enabled: true,
      organizationSlug: "local801",
      providerId: "local801-oidc",
      providerName: "Microsoft Entra ID",
      wellKnown: "https://identity.example.test/.well-known/openid-configuration",
      clientId: "client",
      clientSecret: "secret",
      tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
      mfaClaim: "amr",
      mfaValue: "mfa",
    }, {
      query: async (sql, parameters = []) => {
        sqlCalls.push({ sql, parameters });
        if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
        if (sql.includes("protected-bound-subject-account")) return [];
        if (sql.includes("protected-onboarding-object-lookup")) return [onboardedAccount];
        return [];
      },
      transaction: async (statements) => transactions.push(statements),
    });
    assert.equal(result.email, storedEmail);
    assert.equal(result.role, "cat_lead");
    assert.equal(sqlCalls.some(({ sql }) => sql.includes("protected-email-lookup")), false);
    const onboardingLookup = sqlCalls.find(({ sql }) => sql.includes("protected-onboarding-object-lookup"));
    assert.deepEqual(onboardingLookup.parameters, [
      organizationId,
      "bbbbbbbb-0000-4000-8000-000000000002",
      "privacy-acceptable-use",
      "2026-08-18",
    ]);
    const subjectLookup = sqlCalls.find(({ sql }) => sql.includes("protected-subject-lookup"));
    assert.equal(subjectLookup.parameters.length, 5);
    assert.match(subjectLookup.sql, /provider_id = \$3::text/);
    assert.match(subjectLookup.sql, /index_key_version = \$4::text/);
    assert.match(subjectLookup.sql, /index_hash = \$5::text/);
    assert.doesNotMatch(subjectLookup.sql, /\$6/);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].length, 4);
    assert.equal(JSON.stringify(transactions).includes(storedEmail), false);
  } finally {
    restore();
  }
});

test("an existing immutable subject binding resolves its active account before onboarding lookup", async () => {
  const restore = withPiiKeys();
  try {
    const storedEmail = "owner@example.test";
    const subject = "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002";
    const encryptedEmail = encryptPiiField(storedEmail, {
      organizationId,
      entity: "user",
      recordId: userId,
      field: "email",
    }, getPiiKeyConfiguration());
    const encryptedSubject = encryptPiiField(subject, {
      organizationId,
      entity: "auth-identity",
      recordId: authIdentityId,
      field: "provider-subject",
    }, getPiiKeyConfiguration());
    const boundAccount = {
      organization_slug: "local801",
      organization_id: organizationId,
      user_id: userId,
      auth_session_version: 4,
      role: "cat_lead",
      email_encrypted_payload: encryptedEmail.encryptedPayload,
      email_encryption_key_version: encryptedEmail.encryptionKeyVersion,
      email_encryption_format_version: encryptedEmail.encryptionFormatVersion,
      policy_acknowledged: true,
      auth_identity_id: authIdentityId,
      provider_subject_encrypted_payload: encryptedSubject.encryptedPayload,
      provider_subject_encryption_key_version: encryptedSubject.encryptionKeyVersion,
      provider_subject_encryption_format_version: encryptedSubject.encryptionFormatVersion,
    };
    const sqlCalls = [];
    const transactions = [];
    const result = await authorizeProtectedProductionIdentity({
      providerId: "local801-oidc",
      subject,
      email: storedEmail,
      emailVerified: true,
      mfaVerified: true,
      directoryObjectVerified: true,
    }, {
      enabled: true,
      organizationSlug: "local801",
      providerId: "local801-oidc",
      providerName: "Microsoft Entra ID",
      wellKnown: "https://identity.example.test/.well-known/openid-configuration",
      clientId: "client",
      clientSecret: "secret",
      tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
      mfaClaim: "amr",
      mfaValue: "mfa",
    }, {
      query: async (sql) => {
        sqlCalls.push(sql);
        if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
        if (sql.includes("protected-bound-subject-account")) return [boundAccount];
        if (sql.includes("protected-onboarding-object-lookup")) throw new Error("onboarding lookup must not run for a bound subject");
        return [];
      },
      transaction: async (statements) => transactions.push(statements),
    });
    assert.deepEqual(result, {
      organizationSlug: "local801",
      organizationId,
      userId,
      email: storedEmail,
      role: "cat_lead",
      sessionVersion: 4,
      policyAcknowledged: true,
    });
    assert.equal(sqlCalls.some((sql) => sql.includes("protected-onboarding-object-lookup")), false);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].length, 2);
    assert.deepEqual(transactions[0][0].parameters, [organizationId, authIdentityId, userId]);
    assert.deepEqual(transactions[0][1].parameters, [organizationId, userId, 4]);
  } finally {
    restore();
  }
});

test("protected auth converts unclassified account failures to a fixed PII-safe stage", async () => {
  const restore = withPiiKeys();
  try {
    await assert.rejects(
      authorizeProtectedProductionIdentity({
        providerId: "local801-oidc",
        subject: "aaaaaaaa-0000-4000-8000-000000000001:bbbbbbbb-0000-4000-8000-000000000002",
        email: "",
        emailVerified: false,
        mfaVerified: true,
        directoryObjectVerified: true,
      }, {
        enabled: true,
        organizationSlug: "local801",
        providerId: "local801-oidc",
        providerName: "Microsoft Entra ID",
        wellKnown: "https://identity.example.test/.well-known/openid-configuration",
        clientId: "client",
        clientSecret: "secret",
        tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
        mfaClaim: "amr",
        mfaValue: "mfa",
      }, {
        query: async (sql) => {
          if (sql.includes("protected-organization")) return [{ id: organizationId, slug: "local801" }];
          if (sql.includes("protected-bound-subject-account")) return [];
          throw new Error("protected@example.test");
        },
      }),
      (error) => error?.code === "PROTECTED_AUTH_ACCOUNT_FAILED"
        && !String(error?.message).includes("protected@example.test"),
    );
  } finally {
    restore();
  }
});
