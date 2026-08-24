import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { approveDocument, DocumentApprovalError } from "@/lib/document-approval";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";

export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN_ORIGIN", message: "Document approval must come from the signed-in application." }, 403);
  }

  const auth = await requirePreviewUser("approveDocuments");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    return auth.response;
  }

  try {
    const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    await enforceWorkspaceRateLimit(context, "mutation");
    return json({ documentApproval: "ok", ...(await approveDocument(context, handle)) }, 200);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof DocumentApprovalError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    return json({ error: "APPROVAL_UNAVAILABLE", message: "The document could not be approved safely." }, 503);
  }
}
