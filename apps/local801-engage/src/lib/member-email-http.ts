import "server-only";

import { NextResponse } from "next/server";
import { requirePreviewUser } from "./authz.server.ts";
import { MemberEmailBroadcastError } from "./member-email-broadcasts.ts";
import { memberEmailPreviewEnabled, MemberEmailPreviewPolicyError } from "./member-email-preview-policy.ts";
import { hasExactSameOrigin } from "./request-security.ts";
import { enforceWorkspaceRateLimit, RateLimitError } from "./rate-limit.ts";
import { rateLimitResponse } from "./rate-limit-response.ts";
import { resolveWorkspaceContext } from "./workspace-context.ts";

const MAX_JSON_BYTES = 32_768;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

export function memberEmailJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function authorizeMemberEmailMutation(request: Request) {
  if (!memberEmailPreviewEnabled()) return { response: memberEmailJson({ error: "NOT_FOUND" }, 404) } as const;
  if (!hasExactSameOrigin(request)) {
    return { response: memberEmailJson({
      error: "FORBIDDEN_ORIGIN",
      message: "This request must come from the signed-in Local 801 Preview application.",
    }, 403) } as const;
  }
  const auth = await requirePreviewUser("sendMemberEmail");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return { response: auth.response } as const;
  }
  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, "mutation");
    return { auth, context } as const;
  } catch (error) {
    return { response: rateLimitResponse(error instanceof RateLimitError
      ? error : new RateLimitError("RATE_LIMIT_UNAVAILABLE")) } as const;
  }
}

export async function readMemberEmailJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new MemberEmailBroadcastError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new MemberEmailBroadcastError("REQUEST_TOO_LARGE", "Broadcast request is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new MemberEmailBroadcastError("REQUEST_TOO_LARGE", "Broadcast request is too large.", 413);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MemberEmailBroadcastError("INVALID_JSON", "Broadcast request is invalid.", 400);
  }
}

export function memberEmailFailure(error: unknown) {
  if (error instanceof MemberEmailBroadcastError || error instanceof MemberEmailPreviewPolicyError) {
    return memberEmailJson({ error: error.code, message: error.message }, error.status);
  }
  return memberEmailJson({ error: "BROADCAST_UNAVAILABLE", message: "The Preview broadcast operation could not be completed safely." }, 503);
}

export const __testing = { MAX_JSON_BYTES };
