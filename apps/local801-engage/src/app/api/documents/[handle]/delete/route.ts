import { NextResponse } from "next/server";
import { writeAuditEvent } from "@/lib/audit";
import { requirePreviewUser } from "@/lib/authz.server";
import { deleteEncryptedDocument } from "@/lib/document-storage";
import { resolveDocumentDownloadId } from "@/lib/documents";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) {
    return json({
      error: "FORBIDDEN_ORIGIN",
      message: "Document deletion must come from the signed-in Local 801 application.",
    }, 403);
  }

  const auth = await requirePreviewUser("manageDocuments");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }

  try {
    const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const documentId = await resolveDocumentDownloadId(context, handle);
    if (!documentId) return json({ error: "DOCUMENT_NOT_FOUND" }, 404);

    await writeAuditEvent({
      eventType: "record.archive",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "document",
      subjectId: documentId,
      payload: { operation: "delete_requested" },
    });

    const result = await deleteEncryptedDocument({
      actor: { organizationId: context.organizationId, userId: context.userId, role: context.role },
      organizationId: context.organizationId,
      documentId,
    });

    if (!result.deleted) return json({ error: "DOCUMENT_NOT_FOUND" }, 404);
    return json({ documentDelete: "ok", deleted: true }, 200);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    return json({ error: "DELETE_UNAVAILABLE", message: "The document could not be deleted securely." }, 503);
  }
}
