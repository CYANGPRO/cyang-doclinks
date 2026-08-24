import "server-only";

import { NextResponse } from "next/server";
import { requirePreviewUser } from "./authz.server.ts";
import { hasExactSameOrigin } from "./request-security.ts";
import { WorkPreferenceError } from "./work-preferences.ts";
import { enforceWorkspaceRateLimit, RateLimitError } from "./rate-limit.ts";
import { rateLimitResponse } from "./rate-limit-response.ts";
import { resolveWorkspaceContext } from "./workspace-context.ts";

const MAX_JSON_BYTES = 4_096;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

export function workPreferenceJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function authorizeWorkPreferenceMutation(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return { response: workPreferenceJson({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Local 801 application." }, 403) } as const;
  }
  const auth = await requirePreviewUser("viewPersonalWorkspace");
  if (!auth.ok) return { response: auth.response } as const;
  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, "mutation");
    return { auth, context } as const;
  } catch (error) {
    return { response: rateLimitResponse(error instanceof RateLimitError
      ? error
      : new RateLimitError("RATE_LIMIT_UNAVAILABLE")) } as const;
  }
}

export async function readWorkPreferenceJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new WorkPreferenceError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new WorkPreferenceError("REQUEST_TOO_LARGE", "Work-preference request is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new WorkPreferenceError("REQUEST_TOO_LARGE", "Work-preference request is too large.", 413);
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new WorkPreferenceError("INVALID_JSON", "Work-preference request is invalid.", 400);
  }
}

function safeDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return { name: "UnknownError" };
  const record = error as Record<string, unknown>;
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    ...(typeof record.code === "string" ? { code: record.code.slice(0, 80) } : {}),
    ...(typeof record.constraint === "string" ? { constraint: record.constraint.slice(0, 120) } : {}),
  };
}

export function workPreferenceFailure(error: unknown) {
  if (error instanceof WorkPreferenceError) return workPreferenceJson({ error: error.code, message: error.message }, error.status);
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  if (record?.code === "23505") {
    return workPreferenceJson({ error: "DUPLICATE_SAVED_VIEW", message: "You already have a saved view with that name." }, 409);
  }
  console.error("[local801-work-preference-safe-failure]", JSON.stringify(safeDiagnostic(error)));
  return workPreferenceJson({ error: "WORK_PREFERENCE_UNAVAILABLE", message: "The work preference could not be changed safely." }, 503);
}

export const __testing = { MAX_JSON_BYTES };
