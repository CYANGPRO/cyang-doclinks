import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { completeOutreachFollowup, EngagementWriteError } from "@/lib/engagement-recording";
import { FollowupUpdateError, updateOutreachFollowup } from "@/lib/follow-up-management";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 4_096;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function readJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new FollowupUpdateError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new FollowupUpdateError("REQUEST_TOO_LARGE", "Request body is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new FollowupUpdateError("REQUEST_TOO_LARGE", "Follow-up request is too large.", 413);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new FollowupUpdateError("INVALID_JSON", "Follow-up request is invalid.", 400);
  }
}

type RouteContext = { params: Promise<{ handle: string; followupHandle: string }> };

async function authorize(request: Request) {
  if (!operationalRuntimeEnabled()) return { response: json({ error: "NOT_FOUND" }, 404) } as const;
  if (!hasExactSameOrigin(request)) {
    return {
      response: json(
        { error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Local 801 application." },
        403,
      ),
    } as const;
  }
  const auth = await requirePreviewUser("recordEngagement");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return { response: auth.response } as const;
  }
  return { auth } as const;
}

export async function PUT(request: Request, { params }: RouteContext) {
  const authorized = await authorize(request);
  if ("response" in authorized) return authorized.response;

  try {
    const [{ handle, followupHandle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await completeOutreachFollowup(context, { personHandle: handle, followupHandle });
    return json({ followup: "ok", ...result });
  } catch (error) {
    if (error instanceof EngagementWriteError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "FOLLOWUP_UNAVAILABLE", message: "The follow-up could not be completed safely." }, 503);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const authorized = await authorize(request);
  if ("response" in authorized) return authorized.response;

  try {
    const [{ handle, followupHandle }, body, context] = await Promise.all([
      params,
      readJson(request),
      resolveWorkspaceContext(authorized.auth.user),
    ]);
    const result = await updateOutreachFollowup(context, {
      personHandle: handle,
      followupHandle,
      ...(Object.prototype.hasOwnProperty.call(body, "dueAt") ? { dueAt: body.dueAt } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "assigneeHandle") ? { assigneeHandle: body.assigneeHandle } : {}),
    });
    return json({ followup: "ok", ...result });
  } catch (error) {
    if (error instanceof FollowupUpdateError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "FOLLOWUP_UNAVAILABLE", message: "The follow-up could not be updated safely." }, 503);
  }
}
