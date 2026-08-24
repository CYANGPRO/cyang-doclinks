import "server-only";

import { randomUUID } from "node:crypto";
import type { Role } from "./access.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import {
  createPiiBlindIndex,
  decryptPiiField,
  encryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
  normalizePiiIdentifier,
  type EncryptedPiiField,
} from "./pii-protection.ts";
import type { ProductionAuthBinding, ProductionAuthConfig, ProductionIdentity } from "./production-auth.ts";
import { CURRENT_ACCESS_POLICY } from "./policy-contract.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProtectedAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductionAuthError";
    this.code = code;
  }
}

type OrganizationRow = { id: string; slug: string };
type UserRow = {
  organization_slug: string;
  organization_id: string;
  user_id: string;
  auth_session_version: number | string;
  role: string;
  email_encrypted_payload: string;
  email_encryption_key_version: string;
  email_encryption_format_version: number;
  policy_acknowledged: boolean;
};
type IdentityRow = {
  auth_identity_id: string;
  user_id: string;
  provider_subject_encrypted_payload: string;
  provider_subject_encryption_key_version: string;
  provider_subject_encryption_format_version: number;
};
type SubjectBoundUserRow = UserRow & IdentityRow;
type BoundUserRow = UserRow & IdentityRow;

type ProtectedSessionInput = {
  organizationSlug: string;
  userId: string;
  sessionVersion: number;
};

function asRole(value: string): Role | null {
  return value === "system_owner" || value === "local_admin" || value === "membership_data_manager"
    || value === "cat_admin" || value === "cat_lead" || value === "cat_member" || value === "report_viewer"
    ? value : null;
}

function authError(code: string, message: string): never {
  throw new ProtectedAuthError(code, message);
}

function directoryObjectId(identity: ProductionIdentity) {
  if (!identity.directoryObjectVerified) return null;
  const parts = identity.subject.split(":");
  return parts.length === 2 && UUID_RE.test(parts[0]) && UUID_RE.test(parts[1])
    ? parts[1].toLowerCase()
    : null;
}

async function protectedAuthStage<T>(code: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProtectedAuthError) throw error;
    if (error && typeof error === "object") {
      const name = "name" in error && typeof error.name === "string" ? error.name : "";
      const errorCode = "code" in error && typeof error.code === "string" ? error.code : "";
      if (name === "PiiProtectionError" || name === "PostgresError" || /^[0-9A-Z]{5}$/.test(errorCode)
        || name.startsWith("Local801TransactionError:")) {
        throw error;
      }
    }
    throw new ProtectedAuthError(code, "A protected production authorization stage failed.");
  }
}

function encrypted(payload: string, keyVersion: string, formatVersion: number): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  if (typeof payload !== "string" || typeof keyVersion !== "string" || Number(formatVersion) !== 1) {
    authError("PROTECTED_PII_INVALID", "The protected account record is invalid.");
  }
  return { encryptedPayload: payload, encryptionKeyVersion: keyVersion, encryptionFormatVersion: 1 };
}

function subjectDomain(providerId: string) {
  return `auth:provider-subject:${providerId}`;
}

function protectedUserAccount(organization: OrganizationRow, row: UserRow) {
  const role = asRole(row.role);
  const sessionVersion = Number(row.auth_session_version);
  if (!role || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
    authError("USER_NOT_PROVISIONED", "The Local 801 account is not provisioned with one valid role.");
  }
  const keyConfig = getPiiKeyConfiguration();
  const email = decryptPiiField(
    encrypted(row.email_encrypted_payload, row.email_encryption_key_version, row.email_encryption_format_version),
    { organizationId: organization.id, entity: "user", recordId: row.user_id, field: "email" },
    keyConfig,
  );
  return { row, role, sessionVersion, email, keyConfig };
}

async function resolveOrganization(config: ProductionAuthConfig, query: DatabaseQuery) {
  const rows = await query<OrganizationRow>(`
    /* production-auth:protected-organization */
    SELECT id::text, slug
    FROM local801.organizations
    WHERE slug = $1::text AND archived_at IS NULL
    LIMIT 2
  `, [config.organizationSlug]);
  if (rows.length !== 1 || !UUID_RE.test(rows[0].id)) authError("ORGANIZATION_NOT_PROVISIONED", "The Local 801 organization is not uniquely provisioned.");
  return rows[0];
}

async function resolveUserByProtectedEmail(
  organization: OrganizationRow,
  identity: ProductionIdentity,
  query: DatabaseQuery,
) {
  const keyConfig = getPiiKeyConfiguration();
  const normalizedEmail = normalizePiiEmail(identity.email);
  const lookup = createPiiBlindIndex(normalizedEmail, { organizationId: organization.id, domain: "user:email" }, keyConfig);
  const rows = await query<UserRow>(`
    /* production-auth:protected-email-lookup */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      protected.email_encrypted_payload, protected.email_encryption_key_version, protected.email_encryption_format_version,
      EXISTS (
        SELECT 1 FROM local801.user_policy_acknowledgements acknowledgement
        WHERE acknowledgement.organization_id = organization.id
          AND acknowledgement.user_id = app_user.id
          AND acknowledgement.policy_key = $4::text
          AND acknowledgement.policy_version = $5::text
      ) AS policy_acknowledged
    FROM local801.organizations organization
    JOIN local801.pii_exact_indexes email_index
      ON email_index.organization_id = organization.id
      AND email_index.entity_type = 'user'
      AND email_index.index_domain = 'user:email'
      AND email_index.index_key_version = $2::text
      AND email_index.index_hash = $3::text
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
      AND app_user.id = email_index.entity_id
      AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii protected
      ON protected.organization_id = organization.id AND protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = organization.id
    WHERE organization.id = $1::uuid AND organization.archived_at IS NULL
    LIMIT 2
  `, [
    organization.id,
    lookup.blindIndexKeyVersion,
    lookup.blindIndex,
    CURRENT_ACCESS_POLICY.key,
    CURRENT_ACCESS_POLICY.version,
  ]);
  if (rows.length !== 1) authError("USER_NOT_PROVISIONED", "No unique active Local 801 account is provisioned for this identity.");
  const account = protectedUserAccount(organization, rows[0]);
  if (normalizePiiEmail(account.email) !== normalizedEmail) authError("IDENTITY_MISMATCH", "The protected Local 801 email did not match the verified identity-provider email.");
  return account;
}

async function resolveUserByProtectedSubject(
  organization: OrganizationRow,
  identity: ProductionIdentity,
  query: DatabaseQuery,
) {
  const keyConfig = getPiiKeyConfiguration();
  const domain = subjectDomain(identity.providerId);
  const normalizedSubject = normalizePiiIdentifier(identity.subject);
  const lookup = createPiiBlindIndex(normalizedSubject, { organizationId: organization.id, domain }, keyConfig);
  const rows = await query<SubjectBoundUserRow>(`
    /* production-auth:protected-bound-subject */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      user_protected.email_encrypted_payload, user_protected.email_encryption_key_version,
      user_protected.email_encryption_format_version,
      auth_identity.id::text AS auth_identity_id,
      identity_protected.provider_subject_encrypted_payload,
      identity_protected.provider_subject_encryption_key_version,
      identity_protected.provider_subject_encryption_format_version
    FROM local801.pii_exact_indexes subject_index
    JOIN local801.auth_identities auth_identity
      ON auth_identity.organization_id = subject_index.organization_id
      AND auth_identity.id = subject_index.entity_id
      AND auth_identity.provider_id = $3::text
    JOIN local801.auth_identity_pii identity_protected
      ON identity_protected.organization_id = auth_identity.organization_id
      AND identity_protected.auth_identity_id = auth_identity.id
    JOIN local801.organizations organization
      ON organization.id = auth_identity.organization_id AND organization.archived_at IS NULL
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
      AND app_user.id = auth_identity.user_id
      AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii user_protected
      ON user_protected.organization_id = organization.id AND user_protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = organization.id
    WHERE subject_index.organization_id = $1::uuid
      AND subject_index.entity_type = 'auth_identity'
      AND subject_index.index_domain = $2::text
      AND subject_index.index_key_version = $4::text
      AND subject_index.index_hash = $5::text
    LIMIT 2
  `, [organization.id, domain, identity.providerId, lookup.blindIndexKeyVersion, lookup.blindIndex]);
  if (rows.length > 1) authError("IDENTITY_MISMATCH", "The identity-provider subject is not uniquely linked.");
  if (rows.length === 0) return null;
  const row = rows[0];
  const storedSubject = decryptPiiField(
    encrypted(
      row.provider_subject_encrypted_payload,
      row.provider_subject_encryption_key_version,
      row.provider_subject_encryption_format_version,
    ),
    { organizationId: organization.id, entity: "auth-identity", recordId: row.auth_identity_id, field: "provider-subject" },
    keyConfig,
  );
  if (normalizePiiIdentifier(storedSubject) !== normalizedSubject) {
    authError("IDENTITY_MISMATCH", "The protected identity-provider subject did not match its lookup index.");
  }
  return { ...protectedUserAccount(organization, row), authIdentityId: row.auth_identity_id };
}

async function resolveBootstrapOwner(
  organization: OrganizationRow,
  query: DatabaseQuery,
) {
  let rows = await query<UserRow>(`
    /* production-auth:protected-bootstrap-owner */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      protected.email_encrypted_payload, protected.email_encryption_key_version, protected.email_encryption_format_version
    FROM local801.production_initializations initialization
    JOIN local801.organizations organization
      ON organization.id = initialization.organization_id AND organization.archived_at IS NULL
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
      AND app_user.id = initialization.initial_system_owner_id
      AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii protected
      ON protected.organization_id = organization.id AND protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
      AND role.organization_id = organization.id
      AND role.code = 'system_owner'
    WHERE organization.id = $1::uuid
    LIMIT 2
  `, [organization.id]);
  if (rows.length === 0) {
    // Compatibility path for an already-provisioned deployment that predates the guarded
    // production-initialization marker. It remains fail-closed unless exactly one active
    // system owner exists in the configured organization.
    rows = await query<UserRow>(`
      /* production-auth:protected-legacy-bootstrap-owner */
      SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
        app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
        protected.email_encrypted_payload, protected.email_encryption_key_version,
        protected.email_encryption_format_version
      FROM local801.organizations organization
      JOIN local801.users app_user
        ON app_user.organization_id = organization.id AND app_user.deactivated_at IS NULL
      JOIN local801.user_pii protected
        ON protected.organization_id = organization.id AND protected.user_id = app_user.id
      JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
      JOIN local801.workspace_roles role
        ON role.id = user_role.role_id
        AND role.organization_id = organization.id
        AND role.code = 'system_owner'
      WHERE organization.id = $1::uuid AND organization.archived_at IS NULL
      LIMIT 2
    `, [organization.id]);
  }
  if (rows.length !== 1) authError("BOOTSTRAP_OWNER_NOT_PROVISIONED", "The initial Local 801 system owner is not uniquely provisioned.");
  const row = rows[0];
  const account = protectedUserAccount(organization, row);
  if (account.role !== "system_owner") {
    authError("BOOTSTRAP_OWNER_NOT_PROVISIONED", "The initial Local 801 system owner does not have the required role.");
  }
  return { ...account, role: "system_owner" as const };
}

async function resolveUserByOnboardingObjectId(
  organization: OrganizationRow,
  identity: ProductionIdentity,
  query: DatabaseQuery,
) {
  const providerUserId = directoryObjectId(identity);
  if (!providerUserId) authError("IDENTITY_INVALID", "The verified directory object identifier is invalid.");
  const rows = await query<UserRow>(`
    /* production-auth:protected-onboarding-object-lookup */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      protected.email_encrypted_payload, protected.email_encryption_key_version, protected.email_encryption_format_version,
      EXISTS (
        SELECT 1 FROM local801.user_policy_acknowledgements acknowledgement
        WHERE acknowledgement.organization_id = organization.id
          AND acknowledgement.user_id = app_user.id
          AND acknowledgement.policy_key = $3::text
          AND acknowledgement.policy_version = $4::text
      ) AS policy_acknowledged
    FROM local801.user_identity_onboarding onboarding
    JOIN local801.organizations organization
      ON organization.id = onboarding.organization_id
      AND organization.archived_at IS NULL
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
      AND app_user.id = onboarding.user_id
      AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii protected
      ON protected.organization_id = organization.id AND protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = organization.id
    WHERE organization.id = $1::uuid
      AND onboarding.provider_id = 'microsoft-entra-b2b'
      AND onboarding.provider_user_id = $2::uuid
      AND onboarding.status = 'ready'
    LIMIT 2
  `, [organization.id, providerUserId, CURRENT_ACCESS_POLICY.key, CURRENT_ACCESS_POLICY.version]);
  if (rows.length !== 1) authError("USER_NOT_PROVISIONED", "No unique active Local 801 account is approved for this directory identity.");
  const row = rows[0];
  const role = asRole(row.role);
  const sessionVersion = Number(row.auth_session_version);
  if (!role || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
    authError("USER_NOT_PROVISIONED", "The approved Local 801 account is not provisioned with one valid role.");
  }
  const keyConfig = getPiiKeyConfiguration();
  const email = decryptPiiField(
    encrypted(row.email_encrypted_payload, row.email_encryption_key_version, row.email_encryption_format_version),
    { organizationId: organization.id, entity: "user", recordId: row.user_id, field: "email" },
    keyConfig,
  );
  normalizePiiEmail(email);
  return { row, role, sessionVersion, email, keyConfig };
}

async function resolveAccountByProtectedSubject(
  organization: OrganizationRow,
  identity: ProductionIdentity,
  query: DatabaseQuery,
) {
  const keyConfig = getPiiKeyConfiguration();
  const domain = subjectDomain(identity.providerId);
  const subjectIndex = createPiiBlindIndex(
    normalizePiiIdentifier(identity.subject),
    { organizationId: organization.id, domain },
    keyConfig,
  );
  const rows = await query<BoundUserRow>(`
    /* production-auth:protected-bound-subject-account */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      user_protected.email_encrypted_payload,
      user_protected.email_encryption_key_version,
      user_protected.email_encryption_format_version,
      auth_identity.id::text AS auth_identity_id,
      identity_protected.provider_subject_encrypted_payload,
      identity_protected.provider_subject_encryption_key_version,
      identity_protected.provider_subject_encryption_format_version,
      EXISTS (
        SELECT 1 FROM local801.user_policy_acknowledgements acknowledgement
        WHERE acknowledgement.organization_id = organization.id
          AND acknowledgement.user_id = app_user.id
          AND acknowledgement.policy_key = $6::text
          AND acknowledgement.policy_version = $7::text
      ) AS policy_acknowledged
    FROM local801.pii_exact_indexes subject_index
    JOIN local801.auth_identities auth_identity
      ON auth_identity.organization_id = subject_index.organization_id
      AND auth_identity.id = subject_index.entity_id
      AND auth_identity.provider_id = $3::text
    JOIN local801.auth_identity_pii identity_protected
      ON identity_protected.organization_id = auth_identity.organization_id
      AND identity_protected.auth_identity_id = auth_identity.id
    JOIN local801.organizations organization
      ON organization.id = auth_identity.organization_id
      AND organization.archived_at IS NULL
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id
      AND app_user.id = auth_identity.user_id
      AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii user_protected
      ON user_protected.organization_id = organization.id
      AND user_protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role
      ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id
      AND role.organization_id = organization.id
    WHERE subject_index.organization_id = $1::uuid
      AND subject_index.entity_type = 'auth_identity'
      AND subject_index.index_domain = $2::text
      AND subject_index.index_key_version = $4::text
      AND subject_index.index_hash = $5::text
    LIMIT 2
  `, [
    organization.id,
    domain,
    identity.providerId,
    subjectIndex.blindIndexKeyVersion,
    subjectIndex.blindIndex,
    CURRENT_ACCESS_POLICY.key,
    CURRENT_ACCESS_POLICY.version,
  ]);
  if (rows.length > 1) authError("IDENTITY_MISMATCH", "The identity-provider subject is not uniquely linked.");
  if (rows.length === 0) return null;
  const row = rows[0];
  const storedSubject = decryptPiiField(
    encrypted(
      row.provider_subject_encrypted_payload,
      row.provider_subject_encryption_key_version,
      row.provider_subject_encryption_format_version,
    ),
    { organizationId: organization.id, entity: "auth-identity", recordId: row.auth_identity_id, field: "provider-subject" },
    keyConfig,
  );
  if (storedSubject !== identity.subject) authError("IDENTITY_MISMATCH", "The protected identity-provider subject did not match.");
  const role = asRole(row.role);
  const sessionVersion = Number(row.auth_session_version);
  if (!role || !Number.isSafeInteger(sessionVersion) || sessionVersion < 1) {
    authError("USER_NOT_PROVISIONED", "The linked Local 801 account is not provisioned with one valid role.");
  }
  const email = decryptPiiField(
    encrypted(row.email_encrypted_payload, row.email_encryption_key_version, row.email_encryption_format_version),
    { organizationId: organization.id, entity: "user", recordId: row.user_id, field: "email" },
    keyConfig,
  );
  normalizePiiEmail(email);
  return { row, role, sessionVersion, email, authIdentityId: row.auth_identity_id };
}

async function resolveIdentityBindings(
  organizationId: string,
  userId: string,
  identity: ProductionIdentity,
  query: DatabaseQuery,
  allowBootstrapRebind = false,
) {
  const keyConfig = getPiiKeyConfiguration();
  const domain = subjectDomain(identity.providerId);
  const subjectIndex = createPiiBlindIndex(normalizePiiIdentifier(identity.subject), { organizationId, domain }, keyConfig);
  const bySubject = await protectedAuthStage("PROTECTED_AUTH_SUBJECT_QUERY_FAILED", () => query<IdentityRow>(`
    /* production-auth:protected-subject-lookup */
    SELECT auth_identity.id::text AS auth_identity_id, auth_identity.user_id::text AS user_id,
      protected.provider_subject_encrypted_payload,
      protected.provider_subject_encryption_key_version,
      protected.provider_subject_encryption_format_version
    FROM local801.pii_exact_indexes subject_index
    JOIN local801.auth_identities auth_identity
      ON auth_identity.organization_id = subject_index.organization_id
      AND auth_identity.id = subject_index.entity_id
      AND auth_identity.provider_id = $3::text
    JOIN local801.auth_identity_pii protected
      ON protected.organization_id = auth_identity.organization_id
      AND protected.auth_identity_id = auth_identity.id
    WHERE subject_index.organization_id = $1::uuid
      AND subject_index.entity_type = 'auth_identity'
      AND subject_index.index_domain = $2::text
      AND subject_index.index_key_version = $4::text
      AND subject_index.index_hash = $5::text
    LIMIT 2
  `, [organizationId, domain, identity.providerId, subjectIndex.blindIndexKeyVersion, subjectIndex.blindIndex]));
  if (bySubject.length > 1) authError("IDENTITY_MISMATCH", "The identity-provider subject is not uniquely linked.");
  if (bySubject[0] && bySubject[0].user_id !== userId) {
    authError("IDENTITY_MISMATCH", "This identity-provider subject is already linked to a different Local 801 account.");
  }

  const byUser = await protectedAuthStage("PROTECTED_AUTH_USER_QUERY_FAILED", () => query<IdentityRow>(`
    /* production-auth:protected-user-identity */
    SELECT auth_identity.id::text AS auth_identity_id, auth_identity.user_id::text AS user_id,
      protected.provider_subject_encrypted_payload,
      protected.provider_subject_encryption_key_version,
      protected.provider_subject_encryption_format_version
    FROM local801.auth_identities auth_identity
    JOIN local801.auth_identity_pii protected
      ON protected.organization_id = auth_identity.organization_id
      AND protected.auth_identity_id = auth_identity.id
    WHERE auth_identity.organization_id = $1::uuid
      AND auth_identity.user_id = $2::uuid
      AND auth_identity.provider_id = $3::text
    LIMIT 2
  `, [organizationId, userId, identity.providerId]));
  if (byUser.length > 1) authError("IDENTITY_MISMATCH", "The Local 801 account has multiple provider bindings.");
  let requiresRebind = false;
  if (byUser[0]) {
    // A configured immutable bootstrap object with MFA can replace an orphaned/stale binding
    // when its current subject is not linked to any CAT user. Do not require the stale ciphertext
    // to decrypt first: the replacement transaction overwrites it and its indexes atomically.
    if (allowBootstrapRebind && !bySubject[0]) {
      requiresRebind = true;
    } else {
      const storedSubject = decryptPiiField(
        encrypted(
          byUser[0].provider_subject_encrypted_payload,
          byUser[0].provider_subject_encryption_key_version,
          byUser[0].provider_subject_encryption_format_version,
        ),
        { organizationId, entity: "auth-identity", recordId: byUser[0].auth_identity_id, field: "provider-subject" },
        keyConfig,
      );
      const storedSubjectMatches = normalizePiiIdentifier(storedSubject) === normalizePiiIdentifier(identity.subject);
      const indexedSubjectMatches = bySubject[0]?.auth_identity_id === byUser[0].auth_identity_id;
      if (!storedSubjectMatches || !indexedSubjectMatches) {
        authError("IDENTITY_MISMATCH", "This Local 801 account is already linked to a different identity-provider subject.");
      }
    }
  }
  return { existing: byUser[0] ?? null, requiresRebind, subjectIndex, keyConfig };
}

function protectedIdentityValues(
  organizationId: string,
  identityId: string,
  identity: ProductionIdentity,
) {
  const keyConfig = getPiiKeyConfiguration();
  return {
    subject: encryptPiiField(identity.subject, {
      organizationId, entity: "auth-identity", recordId: identityId, field: "provider-subject",
    }, keyConfig),
    linkedEmail: encryptPiiField(identity.email, {
      organizationId, entity: "auth-identity", recordId: identityId, field: "linked-email",
    }, keyConfig),
    linkedEmailIndex: createPiiBlindIndex(
      normalizePiiEmail(identity.email),
      { organizationId, domain: "auth:linked-email" },
      keyConfig,
    ),
  };
}

function newIdentityStatements(
  organizationId: string,
  userId: string,
  identity: ProductionIdentity,
  identityId: string,
  subjectIndex: ReturnType<typeof createPiiBlindIndex>,
) {
  const { subject, linkedEmail, linkedEmailIndex } = protectedIdentityValues(organizationId, identityId, identity);
  const placeholderSubject = `protected:${identityId}`;
  const placeholderEmail = `protected-${identityId}@invalid.local`;
  return [
    {
      sql: `
        /* production-auth:protected-bind-identity */
        INSERT INTO local801.auth_identities
          (id, organization_id, user_id, provider_id, provider_subject, linked_email, linked_at, last_sign_in_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, now(), now())
      `,
      parameters: [identityId, organizationId, userId, identity.providerId, placeholderSubject, placeholderEmail],
    },
    {
      sql: `
        INSERT INTO local801.auth_identity_pii
          (organization_id, auth_identity_id,
           provider_subject_encrypted_payload, provider_subject_encryption_key_version, provider_subject_encryption_format_version,
           linked_email_encrypted_payload, linked_email_encryption_key_version, linked_email_encryption_format_version, updated_at)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::integer, $6, $7, $8::integer, now())
      `,
      parameters: [
        organizationId, identityId,
        subject.encryptedPayload, subject.encryptionKeyVersion, subject.encryptionFormatVersion,
        linkedEmail.encryptedPayload, linkedEmail.encryptionKeyVersion, linkedEmail.encryptionFormatVersion,
      ],
    },
    {
      sql: `
        INSERT INTO local801.pii_exact_indexes
          (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        VALUES
          ($1::uuid, 'auth_identity', $2::uuid, $3::text, $4::text, $5::text),
          ($1::uuid, 'auth_identity', $2::uuid, 'auth:linked-email', $6::text, $7::text)
      `,
      parameters: [
        organizationId, identityId, subjectDomain(identity.providerId), subjectIndex.blindIndexKeyVersion, subjectIndex.blindIndex,
        linkedEmailIndex.blindIndexKeyVersion, linkedEmailIndex.blindIndex,
      ],
    },
  ] satisfies DatabaseStatement[];
}

function rebindIdentityStatements(
  organizationId: string,
  userId: string,
  identity: ProductionIdentity,
  identityId: string,
  subjectIndex: ReturnType<typeof createPiiBlindIndex>,
) {
  const { subject, linkedEmail, linkedEmailIndex } = protectedIdentityValues(organizationId, identityId, identity);
  return [
    {
      sql: `
        /* production-auth:protected-bootstrap-rebind-delete-indexes */
        DELETE FROM local801.pii_exact_indexes
        WHERE organization_id = $1::uuid
          AND entity_type = 'auth_identity'
          AND entity_id = $2::uuid
          AND index_domain IN ($3::text, 'auth:linked-email')
      `,
      parameters: [organizationId, identityId, subjectDomain(identity.providerId)],
    },
    {
      sql: `
        /* production-auth:protected-bootstrap-rebind-identity */
        WITH updated AS (
          UPDATE local801.auth_identity_pii protected
          SET provider_subject_encrypted_payload = $5::text,
            provider_subject_encryption_key_version = $6::text,
            provider_subject_encryption_format_version = $7::integer,
            linked_email_encrypted_payload = $8::text,
            linked_email_encryption_key_version = $9::text,
            linked_email_encryption_format_version = $10::integer,
            updated_at = now()
          FROM local801.auth_identities auth_identity
          WHERE protected.organization_id = $1::uuid
            AND protected.auth_identity_id = $2::uuid
            AND auth_identity.organization_id = protected.organization_id
            AND auth_identity.id = protected.auth_identity_id
            AND auth_identity.user_id = $3::uuid
            AND auth_identity.provider_id = $4::text
          RETURNING protected.auth_identity_id
        )
        SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS identity_rebound
        FROM updated
      `,
      parameters: [
        organizationId, identityId, userId, identity.providerId,
        subject.encryptedPayload, subject.encryptionKeyVersion, subject.encryptionFormatVersion,
        linkedEmail.encryptedPayload, linkedEmail.encryptionKeyVersion, linkedEmail.encryptionFormatVersion,
      ],
    },
    {
      sql: `
        /* production-auth:protected-bootstrap-rebind-indexes */
        INSERT INTO local801.pii_exact_indexes
          (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
        VALUES
          ($1::uuid, 'auth_identity', $2::uuid, $3::text, $4::text, $5::text),
          ($1::uuid, 'auth_identity', $2::uuid, 'auth:linked-email', $6::text, $7::text)
      `,
      parameters: [
        organizationId, identityId, subjectDomain(identity.providerId),
        subjectIndex.blindIndexKeyVersion, subjectIndex.blindIndex,
        linkedEmailIndex.blindIndexKeyVersion, linkedEmailIndex.blindIndex,
      ],
    },
  ] satisfies DatabaseStatement[];
}

function authenticationStatements(organizationId: string, userId: string, sessionVersion: number, authIdentityId: string | null) {
  const statements: DatabaseStatement[] = [];
  if (authIdentityId) statements.push({
    sql: `UPDATE local801.auth_identities SET last_sign_in_at = now() WHERE organization_id = $1::uuid AND id = $2::uuid AND user_id = $3::uuid`,
    parameters: [organizationId, authIdentityId, userId],
  });
  statements.push({
    sql: `
      WITH updated AS (
        UPDATE local801.users app_user
        SET last_authenticated_at = now(), last_mfa_at = now()
        WHERE app_user.organization_id = $1::uuid
          AND app_user.id = $2::uuid
          AND app_user.deactivated_at IS NULL
          AND app_user.auth_session_version = $3::integer
        RETURNING app_user.id
      )
      SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS authentication_marked
      FROM updated
    `,
    parameters: [organizationId, userId, sessionVersion],
  });
  return statements;
}

export async function authorizeProtectedProductionIdentity(
  identity: ProductionIdentity,
  config: ProductionAuthConfig,
  dependencies: {
    query?: DatabaseQuery;
    transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>;
  } = {},
): Promise<ProductionAuthBinding> {
  if (!config.enabled) authError("AUTH_DISABLED", "Production authentication is disabled.");
  if (identity.providerId !== config.providerId
    || (!identity.emailVerified && !identity.bootstrapObjectMatched && !identity.directoryObjectVerified)
    || !identity.mfaVerified) {
    authError("IDENTITY_INVALID", "The production identity did not satisfy the configured assurance requirements.");
  }
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const organization = await protectedAuthStage(
    "PROTECTED_AUTH_ORGANIZATION_FAILED",
    () => resolveOrganization(config, query),
  );
  // An established, encrypted provider-subject binding is the authoritative account selector.
  // Resolve it before any bootstrap fallback so a provisioned owner does not depend on the
  // one-time production-initialization marker or a mutable email claim on later sign-ins.
  let boundAccount;
  try {
    boundAccount = identity.directoryObjectVerified
      ? await resolveAccountByProtectedSubject(organization, identity, query)
      : await resolveUserByProtectedSubject(organization, identity, query);
  } catch (error) {
    if (error instanceof ProtectedAuthError) throw error;
    authError("PROTECTED_PII_INVALID", "The protected subject binding could not be validated.");
  }
  if (boundAccount) {
    await transaction(authenticationStatements(
      organization.id,
      boundAccount.row.user_id,
      boundAccount.sessionVersion,
      boundAccount.authIdentityId,
    ));
    return {
      organizationSlug: boundAccount.row.organization_slug,
      organizationId: boundAccount.row.organization_id,
      userId: boundAccount.row.user_id,
      email: boundAccount.email,
      role: boundAccount.role,
      sessionVersion: boundAccount.sessionVersion,
      policyAcknowledged: boundAccount.row.policy_acknowledged === true,
    };
  }
  // The bootstrap identity is authorized by the immutable Entra object ID and is resolved
  // through the recorded initial-system-owner relationship. Its mutable email claim never
  // selects or authorizes a database account.
  let account;
  try {
    account = identity.directoryObjectVerified
      ? await protectedAuthStage(
        "PROTECTED_AUTH_ACCOUNT_FAILED",
        () => resolveUserByOnboardingObjectId(organization, identity, query),
      )
      : identity.bootstrapObjectMatched
        ? await resolveBootstrapOwner(organization, query)
        : await resolveUserByProtectedEmail(organization, identity, query);
  } catch (error) {
    if (error instanceof ProtectedAuthError) throw error;
    if (identity.bootstrapObjectMatched) {
      authError("BOOTSTRAP_OWNER_RECORD_INVALID", "The protected bootstrap-owner record could not be validated.");
    }
    authError("PROTECTED_PII_INVALID", "The protected account record could not be validated.");
  }
  const bindingIdentity = identity.emailVerified
    ? identity
    : { ...identity, email: account.email, emailVerified: true };
  let linked;
  try {
    linked = await resolveIdentityBindings(
      organization.id,
      account.row.user_id,
      bindingIdentity,
      query,
      identity.bootstrapObjectMatched,
    );
  } catch (error) {
    if (error instanceof ProtectedAuthError) throw error;
    if (identity.bootstrapObjectMatched) {
      authError("BOOTSTRAP_IDENTITY_RECORD_INVALID", "The protected bootstrap identity record could not be validated.");
    }
    authError("PROTECTED_PII_INVALID", "The protected identity record could not be validated.");
  }
  if (linked.existing && linked.requiresRebind) {
    try {
      await transaction([
        ...rebindIdentityStatements(
          organization.id,
          account.row.user_id,
          bindingIdentity,
          linked.existing.auth_identity_id,
          linked.subjectIndex,
        ),
        ...authenticationStatements(
          organization.id,
          account.row.user_id,
          account.sessionVersion,
          linked.existing.auth_identity_id,
        ),
      ]);
    } catch {
      authError("BOOTSTRAP_REBIND_FAILED", "The protected bootstrap identity rebind did not commit.");
    }
  } else if (linked.existing) {
    await transaction(authenticationStatements(organization.id, account.row.user_id, account.sessionVersion, linked.existing.auth_identity_id));
  } else {
    const identityId = randomUUID();
    await protectedAuthStage(
      "PROTECTED_AUTH_TRANSACTION_FAILED",
      () => transaction([
        ...newIdentityStatements(organization.id, account.row.user_id, bindingIdentity, identityId, linked.subjectIndex),
        ...authenticationStatements(organization.id, account.row.user_id, account.sessionVersion, null),
      ]),
    );
  }
  return {
    organizationSlug: account.row.organization_slug,
    organizationId: account.row.organization_id,
    userId: account.row.user_id,
    email: account.email,
    role: account.role,
    sessionVersion: account.sessionVersion,
    policyAcknowledged: account.row.policy_acknowledged === true,
  };
}

export async function resolveProtectedProductionSessionBinding(
  session: ProtectedSessionInput,
  query: DatabaseQuery = queryLocal801,
): Promise<ProductionAuthBinding | null> {
  if (!session.organizationSlug || !UUID_RE.test(session.userId) || !Number.isSafeInteger(session.sessionVersion)) return null;
  const rows = await query<UserRow>(`
    /* production-auth:protected-session */
    SELECT organization.slug AS organization_slug, organization.id::text AS organization_id,
      app_user.id::text AS user_id, app_user.auth_session_version, role.code AS role,
      protected.email_encrypted_payload, protected.email_encryption_key_version, protected.email_encryption_format_version,
      EXISTS (
        SELECT 1 FROM local801.user_policy_acknowledgements acknowledgement
        WHERE acknowledgement.organization_id = organization.id
          AND acknowledgement.user_id = app_user.id
          AND acknowledgement.policy_key = $4::text
          AND acknowledgement.policy_version = $5::text
      ) AS policy_acknowledged
    FROM local801.organizations organization
    JOIN local801.users app_user
      ON app_user.organization_id = organization.id AND app_user.id = $2::uuid AND app_user.deactivated_at IS NULL
    JOIN local801.user_pii protected
      ON protected.organization_id = organization.id AND protected.user_id = app_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = organization.id
    WHERE organization.slug = $1::text
      AND organization.archived_at IS NULL
      AND app_user.auth_session_version = $3::integer
    LIMIT 2
  `, [
    session.organizationSlug,
    session.userId,
    session.sessionVersion,
    CURRENT_ACCESS_POLICY.key,
    CURRENT_ACCESS_POLICY.version,
  ]);
  if (rows.length !== 1) return null;
  const row = rows[0];
  const role = asRole(row.role);
  if (!role || Number(row.auth_session_version) !== session.sessionVersion) return null;
  const keyConfig = getPiiKeyConfiguration();
  const email = decryptPiiField(
    encrypted(row.email_encrypted_payload, row.email_encryption_key_version, row.email_encryption_format_version),
    { organizationId: row.organization_id, entity: "user", recordId: row.user_id, field: "email" },
    keyConfig,
  );
  return {
    organizationSlug: row.organization_slug,
    organizationId: row.organization_id,
    userId: row.user_id,
    email,
    role,
    sessionVersion: session.sessionVersion,
    policyAcknowledged: row.policy_acknowledged === true,
  };
}
