import "server-only";

import type { PreviewUser } from "./authz.server.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";

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
  email: string;
  role: string;
};

export class WorkspaceContextError extends Error {
  constructor() {
    super("Authenticated database workspace context could not be established.");
    this.name = "WorkspaceContextError";
  }
}

export async function resolveWorkspaceContext(
  authenticatedUser: Pick<PreviewUser, "organizationId" | "email" | "role">,
  query: DatabaseQuery = queryLocal801,
): Promise<WorkspaceContext> {
  const rows = await query<WorkspaceContextRow>(
    `
      SELECT
        organization.id AS organization_id,
        organization.slug AS organization_slug,
        workspace_user.id AS user_id,
        workspace_user.email,
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
        AND lower(workspace_user.email) = lower($2)
        AND workspace_role.code = $3
      LIMIT 2
    `,
    [authenticatedUser.organizationId, authenticatedUser.email, authenticatedUser.role],
  );

  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    typeof row.organization_id !== "string" ||
    typeof row.organization_slug !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.email !== "string" ||
    typeof row.role !== "string" ||
    row.organization_slug !== authenticatedUser.organizationId ||
    row.email.toLowerCase() !== authenticatedUser.email.toLowerCase() ||
    row.role !== authenticatedUser.role
  ) {
    throw new WorkspaceContextError();
  }

  return {
    organizationId: row.organization_id,
    organizationSlug: row.organization_slug,
    userId: row.user_id,
    email: row.email,
    role: authenticatedUser.role,
  };
}
