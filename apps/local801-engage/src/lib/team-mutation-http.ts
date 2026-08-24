import "server-only";

import { NextResponse } from "next/server";
import { requirePreviewUser } from "./authz.server.ts";
import { hasExactSameOrigin } from "./request-security.ts";
import { TeamAccessError } from "./team-access.ts";
import { EntraOnboardingError } from "./entra-user-onboarding.ts";
import { enforceWorkspaceRateLimit, RateLimitError } from "./rate-limit.ts";
import { rateLimitResponse } from "./rate-limit-response.ts";
import { resolveWorkspaceContext } from "./workspace-context.ts";

const MAX_JSON_BYTES = 4_096;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

export function teamJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function authorizeTeamMutation(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return { response: teamJson({ error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Local 801 application." }, 403) } as const;
  }
  const auth = await requirePreviewUser("manageUsers");
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

export async function readTeamJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new TeamAccessError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) throw new TeamAccessError("REQUEST_TOO_LARGE", "Team access request is too large.", 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new TeamAccessError("REQUEST_TOO_LARGE", "Team access request is too large.", 413);
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body as Record<string, unknown>;
  } catch {
    throw new TeamAccessError("INVALID_JSON", "Team access request is invalid.", 400);
  }
}

function safeFailureDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return { name: "UnknownError", category: "UNCLASSIFIED" };
  const record = error as Record<string, unknown>;
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = typeof record.code === "string" ? record.code.slice(0, 80) : undefined;
  const constraint = typeof record.constraint_name === "string"
    ? record.constraint_name.slice(0, 120)
    : typeof record.constraint === "string" ? record.constraint.slice(0, 120) : undefined;
  const table = typeof record.table_name === "string"
    ? record.table_name.slice(0, 120)
    : typeof record.table === "string" ? record.table.slice(0, 120) : undefined;

  let category = "UNCLASSIFIED";
  if (error instanceof Error) {
    const message = error.message;
    if (/unsupported legacy PII transaction/i.test(message)) category = "PII_DUAL_WRITE_UNSUPPORTED";
    else if (/PII dual write/i.test(message)) category = "PII_DUAL_WRITE_CONFIGURATION";
    else if (/PII backfill dataset/i.test(message)) category = "PII_BACKFILL_PLAN";
    else if (/Durable audit event/i.test(message)) category = "AUDIT_WRITE";
    else if (/workspace context/i.test(message)) category = "WORKSPACE_CONTEXT";
  }

  return { name, category, ...(code ? { code } : {}), ...(constraint ? { constraint } : {}), ...(table ? { table } : {}) };
}

export function teamMutationFailure(error: unknown) {
  if (error instanceof TeamAccessError) return teamJson({ error: error.code, message: error.message }, error.status);
  if (error instanceof EntraOnboardingError) return teamJson({ error: error.code, message: error.message }, error.status);
  console.error("[local801-team-safe-failure]", JSON.stringify(safeFailureDiagnostic(error)));
  return teamJson({ error: "TEAM_ACCESS_UNAVAILABLE", message: "The team access change could not be completed safely." }, 503);
}

export const __testing = { MAX_JSON_BYTES };
