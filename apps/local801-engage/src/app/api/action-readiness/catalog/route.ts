import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { createEmployeeActionDefinition } from "@/lib/employee-actions";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_JSON_BYTES = 2_048;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function readJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new Error("Action catalog request must be JSON.");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new Error("Action catalog request is too large.");
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new Error("Action catalog request is too large.");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Action catalog request is invalid.");
  }
}

export async function POST(request: Request) {
  if (!operationalRuntimeEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) return json({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403);
  const auth = await requirePreviewUser("manageActionCatalog");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return auth.response;
  }
  try {
    const [context, body] = await Promise.all([resolveWorkspaceContext(auth.user), readJson(request)]);
    await enforceWorkspaceRateLimit(context, "mutation");
    const result = await createEmployeeActionDefinition(context, {
      label: body.label,
      engagementLevel: body.engagementLevel,
    });
    return json({ action: "created", ...result }, 201);
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const message = error instanceof Error && /^(Action|Employee action)/.test(error.message)
      ? error.message
      : "The custom action could not be created safely.";
    const status = /too large/i.test(message) ? 413 : /must be JSON/i.test(message) ? 415 : /invalid|must be/i.test(message) ? 400 : /authorized/i.test(message) ? 403 : 409;
    return json({ error: "ACTION_CATALOG_UNAVAILABLE", message }, status);
  }
}
