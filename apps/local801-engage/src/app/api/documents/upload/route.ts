import { NextResponse } from "next/server";
import { writeAuditEvent } from "@/lib/audit";
import { requirePreviewUser } from "@/lib/authz.server";
import { getAppConfig } from "@/lib/config";
import { deleteEncryptedDocument, storeEncryptedDocument } from "@/lib/document-storage";
import { DocumentUploadError, uploadDocument } from "@/lib/document-upload";
import { getImportMalwareScanner as getSharedMalwareScanner } from "@/lib/import-scanner";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { writeSecuritySignal } from "@/lib/security-signal";

const multipartOverheadAllowanceBytes = 1_048_576;

function jsonNoStore(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV === "production" || process.env.LOCAL801_PREVIEW_AUTH_ENABLED !== "1") {
    return jsonNoStore({ error: "NOT_FOUND" }, 404);
  }
  if (!hasExactSameOrigin(request)) {
    return jsonNoStore({ error: "FORBIDDEN_ORIGIN", message: "Document uploads must come from the signed-in Preview application." }, 403);
  }

  const auth = await requirePreviewUser("manageDocuments");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    return auth.response;
  }

  try {
    const context = await resolveWorkspaceContext(auth.user);
    const maxBytes = getAppConfig().LOCAL801_IMPORT_MAX_BYTES;
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0
        || declaredBytes > maxBytes + multipartOverheadAllowanceBytes) {
        return jsonNoStore({ error: "FILE_TOO_LARGE", message: "The document exceeds the maximum supported upload size." }, 413);
      }
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonNoStore({ error: "INVALID_UPLOAD", message: "Select a document to upload." }, 400);
    }

    const result = await uploadDocument({
      actor: { organizationId: context.organizationId, userId: context.userId, role: context.role },
      file,
      title: form.get("title"),
      category: form.get("category"),
      visibility: form.get("visibility"),
    }, {
      maxBytes,
      scanner: getSharedMalwareScanner(),
      store: storeEncryptedDocument,
      remove: deleteEncryptedDocument,
      audit: writeAuditEvent,
    });

    return jsonNoStore({ documentUpload: "ok", ...result }, 201);
  } catch (error) {
    if (error instanceof DocumentUploadError) {
      if (error.code === "MALWARE_REJECTED" || error.code === "SCANNER_TEMPORARY_FAILURE" || error.code === "SCANNER_UNAVAILABLE") {
        writeSecuritySignal(error.code === "MALWARE_REJECTED" ? "warn" : "error", "scanner.failure", {
          component: "document_upload", safeCode: error.code, outcome: "fail_closed",
        });
      }
      return jsonNoStore({ error: error.code, message: error.message, retryable: error.retryable }, error.status);
    }
    return jsonNoStore({ error: "UPLOAD_UNAVAILABLE", message: "The document could not be securely stored. No document was shared." }, 503);
  }
}
