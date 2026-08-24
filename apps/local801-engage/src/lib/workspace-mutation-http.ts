import "server-only";

import { NextResponse } from "next/server";
import type { Permission } from "./access.ts";
import { requirePreviewUser } from "./authz.server.ts";
import { hasExactSameOrigin } from "./request-security.ts";
import { enforceWorkspaceRateLimit, RateLimitError, type RateLimitScope } from "./rate-limit.ts";
import { rateLimitResponse } from "./rate-limit-response.ts";
import { resolveWorkspaceContext } from "./workspace-context.ts";

const MAX_JSON_BYTES = 16_384;
const cacheControl = "private, no-store, max-age=0, must-revalidate";

export function workspaceJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": cacheControl } });
}

export async function authorizeWorkspaceMutation(request: Request, permission: Permission, rateLimitScope: RateLimitScope = "mutation") {
  if (!hasExactSameOrigin(request)) {
    return { response: workspaceJson({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in application." }, 403) } as const;
  }
  const auth = await requirePreviewUser(permission, { skipRateLimit: true });
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", cacheControl);
    return { response: auth.response } as const;
  }
  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, rateLimitScope);
    return { auth, context } as const;
  } catch (error) {
    return { response: rateLimitResponse(error instanceof RateLimitError
      ? error
      : new RateLimitError("RATE_LIMIT_UNAVAILABLE")) } as const;
  }
}

export async function readWorkspaceJson(request: Request, maxBytes = MAX_JSON_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 131_072) {
    throw Object.assign(new Error("Request limit is invalid."), { code: "REQUEST_UNAVAILABLE", status: 503 });
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw Object.assign(new Error("Request body must be JSON."), { code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > maxBytes)) {
    throw Object.assign(new Error("Request is too large."), { code: "REQUEST_TOO_LARGE", status: 413 });
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw Object.assign(new Error("Request is too large."), { code: "REQUEST_TOO_LARGE", status: 413 });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Request body is invalid."), { code: "INVALID_JSON", status: 400 });
  }
}

export function workspaceMutationFailure(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string"
      && typeof candidate.status === "number" && candidate.status >= 400 && candidate.status <= 599) {
      return workspaceJson({ error: candidate.code, message: candidate.message }, candidate.status);
    }
  }
  return workspaceJson({ error: "CHANGE_UNAVAILABLE", message: fallback }, 503);
}

export const __testing = { MAX_JSON_BYTES };
