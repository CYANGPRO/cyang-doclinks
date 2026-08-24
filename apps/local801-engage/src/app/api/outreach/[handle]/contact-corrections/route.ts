import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { ContactCorrectionError, submitContactCorrection } from "@/lib/contact-corrections";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 2_048;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function readJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new ContactCorrectionError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_JSON_BYTES)) {
    throw new ContactCorrectionError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new ContactCorrectionError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new ContactCorrectionError("INVALID_JSON", "Request body is invalid.", 400); }
}

type RouteContext = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403);
  const auth = await requirePreviewUser("recordEngagement");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }
  try {
    const [{ handle }, body, context] = await Promise.all([params, readJson(request), resolveWorkspaceContext(auth.user)]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const result = await submitContactCorrection(context, { personHandle: handle, field: body.field, proposedValue: body.proposedValue });
    return json({ correction: "submitted", ...result }, 201);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof ContactCorrectionError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "CORRECTION_UNAVAILABLE", message: "The contact correction could not be submitted safely." }, 503);
  }
}
