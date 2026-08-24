import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { EngagementWriteError, recordEngagement } from "@/lib/engagement-recording";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 32_768;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function readJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new EngagementWriteError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new EngagementWriteError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new EngagementWriteError("REQUEST_TOO_LARGE", "Engagement request is too large.", 413);
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new EngagementWriteError("INVALID_JSON", "Engagement request is invalid.", 400); }
}

type RouteContext = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Local 801 application." }, 403);
  const auth = await requirePreviewUser("recordEngagement");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }

  try {
    const [{ handle }, body, context] = await Promise.all([params, readJson(request), resolveWorkspaceContext(auth.user)]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const result = await recordEngagement(context, {
      personHandle: handle,
      assignmentHandle: body.assignmentHandle,
      contactMethod: body.contactMethod,
      outcome: body.outcome,
      occurredAt: body.occurredAt,
      note: body.note,
      followup: body.followup,
    });
    return json({ engagement: "ok", ...result }, 201);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof EngagementWriteError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "ENGAGEMENT_UNAVAILABLE", message: "The engagement could not be recorded safely." }, 503);
  }
}
