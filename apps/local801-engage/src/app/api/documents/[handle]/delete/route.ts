import { NextResponse } from "next/server";
import { writeAuditEvent } from "@/lib/audit";
import { requirePreviewUser } from "@/lib/authz.server";
import { deleteEncryptedDocument } from "@/lib/document-storage";
import { resolveDocumentDownloadId } from "@/lib/documents";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (process.env.VERCEL_ENV === "production" || process.env.LOCAL801_PREVIEW_AUTH_ENABLED !== "1") {
    return json({ error: "NOT_FOUND" }, 404);
  }

  if (!hasExactSameOrigin(request)) {
    return json({
      error: "FORBIDDEN_ORIGIN",
      message: "Document deletion must come from the signed-in Preview application.",
    }, 403);
  }

  const auth = await requirePreviewUser("manageDocuments");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }

  try {
    const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
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
      actor: { organizationId: context.organizationId, role: context.role },
      organizationId: context.organizationId,
      documentId,
    });

    if (!result.deleted) return json({ error: "DOCUMENT_NOT_FOUND" }, 404);
    return json({ documentDelete: "ok", deleted: true }, 200);
  } catch {
    return json({ error: "DELETE_UNAVAILABLE", message: "The document could not be deleted securely." }, 503);
  }
}
