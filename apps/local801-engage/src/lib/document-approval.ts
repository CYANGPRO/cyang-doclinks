import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { canAccessStoredDocument } from "./document-access.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_PATTERN = /^[a-f0-9]{64}$/i;

export class DocumentApprovalError extends Error {
  readonly code: "FORBIDDEN" | "INVALID_DOCUMENT" | "DOCUMENT_NOT_FOUND" | "DOCUMENT_NOT_PENDING";
  readonly status: number;

  constructor(code: DocumentApprovalError["code"], message: string, status: number) {
    super(message);
    this.name = "DocumentApprovalError";
    this.code = code;
    this.status = status;
  }
}

type ApprovalDependencies = {
  transaction?: <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;
  prepareAudit?: typeof prepareAtomicAuditStatement;
};

export async function approveDocument(
  context: WorkspaceContext,
  handleInput: unknown,
  dependencies: ApprovalDependencies = {},
) {
  if (!can(context.role, "approveDocuments")) {
    throw new DocumentApprovalError("FORBIDDEN", "Document approval is not authorized.", 403);
  }
  if (typeof handleInput !== "string" || !HANDLE_PATTERN.test(handleInput)) {
    throw new DocumentApprovalError("INVALID_DOCUMENT", "The document reference is invalid.", 400);
  }
  const handle = handleInput.toLowerCase();
  const transaction = dependencies.transaction ?? withLocal801Transaction;

  return transaction(async (query) => {
    const [document] = await query<{
      id: string;
      visibility: string;
      status: string;
      created_by: string | null;
      uploaded_by_role: string | null;
    }>(`
      /* documents:approval-lock */
      SELECT document.id, document.visibility, document.status,
        document.created_by, document.uploaded_by_role
      FROM local801.documents document
      WHERE document.organization_id = $1::uuid
        AND document.archived_at IS NULL
        AND encode(
          public.digest(document.organization_id::text || ':' || document.id::text, 'sha256'),
          'hex'
        ) = $2::text
      FOR UPDATE OF document
    `, [context.organizationId, handle]);

    if (!document || !canAccessStoredDocument(context, {
      visibility: document.visibility,
      createdBy: document.created_by,
      uploadedByRole: document.uploaded_by_role,
    })) {
      throw new DocumentApprovalError("DOCUMENT_NOT_FOUND", "The document is not available to approve.", 404);
    }
    if (document.status !== "under_review") {
      throw new DocumentApprovalError("DOCUMENT_NOT_PENDING", "This document is no longer waiting for approval.", 409);
    }

    const [updated] = await query<{ id: string }>(`
      /* documents:approve */
      UPDATE local801.documents document
      SET status = 'approved', approved_by = $3::uuid, approved_at = now()
      WHERE document.organization_id = $1::uuid
        AND document.id = $2::uuid
        AND document.archived_at IS NULL
        AND document.status = 'under_review'
        AND EXISTS (
          SELECT 1
          FROM local801.users actor
          JOIN local801.workspace_user_roles assignment ON assignment.user_id = actor.id
          JOIN local801.workspace_roles role
            ON role.id = assignment.role_id
           AND role.organization_id = actor.organization_id
          WHERE actor.organization_id = $1::uuid
            AND actor.id = $3::uuid
            AND actor.deactivated_at IS NULL
            AND role.code = $4::text
        )
      RETURNING document.id
    `, [context.organizationId, document.id, context.userId, context.role]);
    if (!updated) {
      throw new DocumentApprovalError("DOCUMENT_NOT_PENDING", "This document changed before it could be approved.", 409);
    }

    const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({
      eventType: "record.update",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "document",
      subjectId: document.id,
      payload: { operation: "approve", previousStatus: "under_review", status: "approved" },
    }, query);
    await query(audit.sql, audit.parameters);

    return { approved: true as const, status: "approved" as const };
  });
}
