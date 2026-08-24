import { NextResponse } from "next/server";
import { writeAuditEvent } from "@/lib/audit";
import { requirePreviewUser } from "@/lib/authz.server";
import { downloadDocument } from "@/lib/document-storage";
import { resolveDocumentDownloadId } from "@/lib/documents";
import { writeSecuritySignal } from "@/lib/security-signal";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

const safeDocumentMediaTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
]);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeDownloadFilename(value: string | null | undefined) {
  const cleaned = (value ?? "document")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 255);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "document";
}

function jsonNoStore(body: Record<string, string>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}

function contentDisposition(filename: string) {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_") || "document";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!operationalRuntimeEnabled()) return jsonNoStore({ error: "NOT_FOUND" }, 404);
  const auth = await requirePreviewUser("viewDocuments");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    return auth.response;
  }

  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, "download");
    const { handle } = await params;
    const documentId = await resolveDocumentDownloadId(context, handle);
    if (!documentId) {
      return jsonNoStore({ error: "DOCUMENT_NOT_FOUND" }, 404);
    }

    const downloaded = await downloadDocument({
      actor: { organizationId: context.organizationId, userId: context.userId, role: context.role },
      organizationId: context.organizationId,
      documentId,
    });
    await writeAuditEvent({
      eventType: "record.read",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "document",
      subjectId: documentId,
      payload: { operation: "download", byteSize: downloaded.plaintext.byteLength },
    });

    const filename = safeDownloadFilename(downloaded.originalFilename);
    const mediaType = downloaded.mediaType && safeDocumentMediaTypes.has(downloaded.mediaType)
      ? downloaded.mediaType
      : "application/octet-stream";

    writeSecuritySignal("warn", "protected_access", {
      outcome: "success", operation: "document.download", actorId: context.userId,
      organizationId: context.organizationId, subjectId: documentId,
    });

    return new Response(Uint8Array.from(downloaded.plaintext), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        "Content-Disposition": contentDisposition(filename),
        "Content-Length": String(downloaded.plaintext.byteLength),
        "Content-Type": mediaType,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    return jsonNoStore({ error: "DOCUMENT_UNAVAILABLE" }, 503);
  }
}
