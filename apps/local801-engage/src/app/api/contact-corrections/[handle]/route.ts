import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { ContactCorrectionError, decideContactCorrection } from "@/lib/contact-corrections";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 1_024;

type RouteContext = { params: Promise<{ handle: string }> };

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403);
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }
  try {
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return json({ error: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must be JSON." }, 415);
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      const bytes = Number(declaredLength);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
        return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
      }
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      body = parsed as Record<string, unknown>;
    }
    catch { return json({ error: "INVALID_JSON", message: "Request body is invalid." }, 400); }
    const [{ handle }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    const result = await decideContactCorrection(context, { handle, decision: body.decision, revision: body.revision });
    return json({ correction: "decided", ...result });
  } catch (error) {
    if (error instanceof ContactCorrectionError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "CORRECTION_UNAVAILABLE", message: "The contact correction could not be reviewed safely." }, 503);
  }
}
