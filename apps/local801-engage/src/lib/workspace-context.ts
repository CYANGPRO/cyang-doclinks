import "server-only";

import { createHash } from "node:crypto";
import type { PreviewUser } from "./authz.server.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import {
  createPiiBlindIndex,
  decryptPiiField,
  getPiiKeyConfiguration,
  normalizePiiEmail,
} from "./pii-protection.ts";
import { getPiiProtectedReadMode } from "./pii-protected-read.ts";

export type WorkspaceContext = {
  organizationId: string;
  organizationSlug: string;
  userId: string;
  email: string;
  role: PreviewUser["role"];
};

type WorkspaceContextRow = {
  organization_id: string;
  organization_slug: string;
  user_id: string;
  role: string;
};

type OrganizationRow = {
  organization_id: string;
  organization_slug: string;
};

type ProtectedWorkspaceContextRow = {
  organization_id: string;
  organization_slug: string;
  user_id: string;
  role: string;
  email_encrypted_payload: string;
  email_encryption_key_version: string;
  email_encryption_format_version: number | string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceContextError extends Error {
  constructor() {
    super("Authenticated database workspace context could not be established.");
    this.name = "WorkspaceContextError";
  }
}

function invalidWorkspace(): never {
  throw new WorkspaceContextError();
}

async function resolveProtectedWorkspaceContext(
  authenticatedUser: Pick<PreviewUser, "organizationId" | "email" | "role">,
  query: DatabaseQuery,
): Promise<WorkspaceContext> {
  const organizations = await query<OrganizationRow>(`
    /* workspace-context:protected-organization */
    SELECT id::text AS organization_id, slug AS organization_slug
    FROM local801.organizations
    WHERE slug = $1::text AND archived_at IS NULL
    LIMIT 2
  `, [authenticatedUser.organizationId]);
  const organization = organizations.length === 1 ? organizations[0] : undefined;
  if (!organization || !uuidPattern.test(organization.organization_id)
    || organization.organization_slug !== authenticatedUser.organizationId) invalidWorkspace();

  const keyConfig = getPiiKeyConfiguration();
  const normalizedEmail = normalizePiiEmail(authenticatedUser.email);
  const emailIndex = createPiiBlindIndex(
    normalizedEmail,
    { organizationId: organization.organization_id, domain: "user:email" },
    keyConfig,
  );
  const rows = await query<ProtectedWorkspaceContextRow>(`
    /* workspace-context:protected-user-email */
    SELECT organization.id::text AS organization_id, organization.slug AS organization_slug,
      workspace_user.id::text AS user_id, workspace_role.code AS role,
      protected.email_encrypted_payload, protected.email_encryption_key_version,
      protected.email_encryption_format_version
    FROM local801.organizations organization
    JOIN local801.pii_exact_indexes email_index
      ON email_index.organization_id = organization.id
     AND email_index.entity_type = 'user'
     AND email_index.index_domain = 'user:email'
     AND email_index.index_key_version = $2::text
     AND email_index.index_hash = $3::text
    JOIN local801.users workspace_user
      ON workspace_user.organization_id = organization.id
     AND workspace_user.id = email_index.entity_id
     AND workspace_user.deactivated_at IS NULL
    JOIN local801.user_pii protected
      ON protected.organization_id = organization.id AND protected.user_id = workspace_user.id
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = workspace_user.id
    JOIN local801.workspace_roles workspace_role
      ON workspace_role.id = user_role.role_id AND workspace_role.organization_id = organization.id
    WHERE organization.id = $1::uuid
      AND organization.archived_at IS NULL
      AND workspace_role.code = $4::text
    LIMIT 2
  `, [organization.organization_id, emailIndex.blindIndexKeyVersion, emailIndex.blindIndex, authenticatedUser.role]);

  const row = rows.length === 1 ? rows[0] : undefined;
  const formatVersion = Number(row?.email_encryption_format_version);
  if (!row || row.organization_id !== organization.organization_id
    || row.organization_slug !== authenticatedUser.organizationId
    || !uuidPattern.test(row.user_id) || row.role !== authenticatedUser.role
    || typeof row.email_encrypted_payload !== "string"
    || typeof row.email_encryption_key_version !== "string" || formatVersion !== 1) invalidWorkspace();

  let storedEmail: string;
  try {
    storedEmail = decryptPiiField({
      encryptedPayload: row.email_encrypted_payload,
      encryptionKeyVersion: row.email_encryption_key_version,
      encryptionFormatVersion: 1,
    }, {
      organizationId: row.organization_id,
      entity: "user",
      recordId: row.user_id,
      field: "email",
    }, keyConfig);
  } catch {
    invalidWorkspace();
  }
  if (normalizePiiEmail(storedEmail) !== normalizedEmail) invalidWorkspace();
  return {
    organizationId: row.organization_id,
    organizationSlug: row.organization_slug,
    userId: row.user_id,
    email: storedEmail,
    role: authenticatedUser.role,
  };
}

function syntheticPreviewUserId(role: PreviewUser["role"]) {
  const bytes = createHash("sha256").update(`local801-synthetic:user:${role}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function resolveWorkspaceContext(
  authenticatedUser: Pick<PreviewUser, "id" | "organizationId" | "email" | "role" | "authentication">,
  query: DatabaseQuery = queryLocal801,
): Promise<WorkspaceContext> {
  if (getPiiProtectedReadMode() !== "legacy") {
    return resolveProtectedWorkspaceContext(authenticatedUser, query);
  }
  const productionIdentity = authenticatedUser.authentication === "production";
  const expectedUserId = productionIdentity ? authenticatedUser.id : syntheticPreviewUserId(authenticatedUser.role);
  const rows = await query<WorkspaceContextRow>(
    `
      SELECT
        organization.id AS organization_id,
        organization.slug AS organization_slug,
        workspace_user.id AS user_id,
        workspace_role.code AS role
      FROM local801.organizations organization
      JOIN local801.users workspace_user
        ON workspace_user.organization_id = organization.id
       AND workspace_user.deactivated_at IS NULL
      JOIN local801.workspace_user_roles user_role
        ON user_role.user_id = workspace_user.id
      JOIN local801.workspace_roles workspace_role
        ON workspace_role.id = user_role.role_id
       AND workspace_role.organization_id = organization.id
      WHERE organization.slug = $1
        AND organization.archived_at IS NULL
        AND workspace_role.code = $2
        AND workspace_user.id::text = $3
      LIMIT 2
    `,
    [authenticatedUser.organizationId, authenticatedUser.role, expectedUserId],
  );

  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    typeof row.organization_id !== "string" ||
    typeof row.organization_slug !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.role !== "string" ||
    row.organization_slug !== authenticatedUser.organizationId ||
    row.user_id !== expectedUserId ||
    row.role !== authenticatedUser.role
  ) {
    throw new WorkspaceContextError();
  }

  return {
    organizationId: row.organization_id,
    organizationSlug: row.organization_slug,
    userId: row.user_id,
    email: authenticatedUser.email,
    role: authenticatedUser.role,
  };
}
