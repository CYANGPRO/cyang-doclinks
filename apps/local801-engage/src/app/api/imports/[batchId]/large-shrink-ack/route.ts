import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import {
  acknowledgeLargeRosterShrink,
  ImportExecutionPreflightError,
} from "@/lib/import-execution-preflight";
import { hasExactSameOrigin } from "@/lib/request-security";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_BODY_BYTES = 512;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  if (!operationalRuntimeEnabled()) {
    return json({ error: "NOT_FOUND" }, 404);
  }
  if (!hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN", message: "This request must come from the signed-in Local 801 application." }, 403);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return json({ error: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must be JSON." }, 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_BODY_BYTES)) {
    return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
  }

  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
    const body = JSON.parse(text) as { fingerprint?: unknown };
    const [{ batchId }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    await enforceWorkspaceRateLimit(context, "import");
    const result = await acknowledgeLargeRosterShrink(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      batchId,
      typeof body.fingerprint === "string" ? body.fingerprint : "",
    );
    return json(result);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof ImportExecutionPreflightError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "PREFLIGHT_UNAVAILABLE", message: "The acknowledgement could not be saved safely." }, 503);
  }
}
