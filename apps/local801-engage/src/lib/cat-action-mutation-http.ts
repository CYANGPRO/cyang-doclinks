import "server-only";

import { NextResponse } from "next/server";
import { requirePreviewUser } from "./authz.server.ts";
import { CatActionMutationError } from "./cat-action-management.ts";
import { operationalRuntimeEnabled } from "./operational-runtime.ts";
import { hasExactSameOrigin } from "./request-security.ts";

const MAX_JSON_BYTES = 8_192;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

export function catActionJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function authorizeCatActionMutation(request: Request) {
  if (!operationalRuntimeEnabled()) return { response: catActionJson({ error: "NOT_FOUND" }, 404) } as const;
  if (!hasExactSameOrigin(request)) {
    return {
      response: catActionJson(
          { error: "FORBIDDEN_ORIGIN", message: "This request must come from the signed-in Local 801 application." },
        403,
      ),
    } as const;
  }
  const auth = await requirePreviewUser("manageCatActions");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", noStore["Cache-Control"]);
    return { response: auth.response } as const;
  }
  return { auth } as const;
}

export async function readCatActionJson(request: Request) {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new CatActionMutationError("UNSUPPORTED_MEDIA_TYPE", "Request body must be JSON.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_JSON_BYTES) {
      throw new CatActionMutationError("REQUEST_TOO_LARGE", "CAT action request is too large.", 413);
    }
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new CatActionMutationError("REQUEST_TOO_LARGE", "CAT action request is too large.", 413);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new CatActionMutationError("INVALID_JSON", "CAT action request is invalid.", 400);
  }
}

export function catActionMutationFailure(error: unknown) {
  if (error instanceof CatActionMutationError) {
    return catActionJson({ error: error.code, message: error.message }, error.status);
  }
  return catActionJson({ error: "CAT_ACTION_UNAVAILABLE", message: "The CAT action change could not be completed safely." }, 503);
}

export const __testing = { MAX_JSON_BYTES, operationalRuntimeEnabled };
