import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { assignOutreachOrganizer, deleteMemberOutreach, OutreachAssignmentError } from "@/lib/outreach-assignment";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };
const MAX_JSON_BYTES = 2_048;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function readJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new OutreachAssignmentError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new OutreachAssignmentError("REQUEST_TOO_LARGE", "Assignment request is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new OutreachAssignmentError("REQUEST_TOO_LARGE", "Assignment request is too large.", 413);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new OutreachAssignmentError("INVALID_JSON", "Assignment request is invalid.", 400);
  }
}

type RouteContext = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403);
  }
  const auth = await requirePreviewUser("assignOutreach");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }
  try {
    const [{ handle }, body, context] = await Promise.all([
      params,
      readJson(request),
      resolveWorkspaceContext(auth.user),
    ]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const result = await assignOutreachOrganizer(context, {
      personHandle: handle,
      assigneeHandle: body.assigneeHandle,
    });
    return json({ assignment: "ok", ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof OutreachAssignmentError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "ASSIGNMENT_UNAVAILABLE", message: "The outreach assignment could not be saved safely." }, 503);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403);
  }
  const auth = await requirePreviewUser("assignOutreach");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }
  try {
    const [{ handle }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(auth.user),
    ]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const result = await deleteMemberOutreach(context, { personHandle: handle });
    return json({ assignment: "deleted", ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof OutreachAssignmentError) return json({ error: error.code, message: error.message }, error.status);
    return json({ error: "DELETE_UNAVAILABLE", message: "The member outreach assignment could not be deleted safely." }, 503);
  }
}
