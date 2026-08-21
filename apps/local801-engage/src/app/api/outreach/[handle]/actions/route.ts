import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import {
  EngagementWriteError,
  recordOutreachActionPosture,
  recordOutreachActionResponse,
} from "@/lib/engagement-recording";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 16_384;

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
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new EngagementWriteError("REQUEST_TOO_LARGE", "Action Readiness request is too large.", 413);
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new EngagementWriteError("INVALID_JSON", "Action Readiness request is invalid.", 400); }
}

type RouteContext = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (process.env.VERCEL_ENV === "production" || process.env.LOCAL801_PREVIEW_AUTH_ENABLED !== "1") return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Preview application." }, 403);
  const auth = await requirePreviewUser("recordEngagement");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }

  try {
    const [{ handle }, body, context] = await Promise.all([params, readJson(request), resolveWorkspaceContext(auth.user)]);
    const result = body.posture === "declines_all"
      ? await recordOutreachActionPosture(context, { personHandle: handle, posture: body.posture, engagementHandle: body.engagementHandle })
      : await recordOutreachActionResponse(context, { personHandle: handle, actionHandle: body.actionHandle, response: body.response, engagementHandle: body.engagementHandle });
    return json({ actionReadiness: "ok", ...result });
  } catch (error) {
    if (error instanceof EngagementWriteError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "ACTION_READINESS_UNAVAILABLE", message: "Action Readiness could not be recorded safely." }, 503);
  }
}
