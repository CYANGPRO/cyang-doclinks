import { NextResponse } from "next/server";
import { normalizeRole, previewAuthEnabled, setPreviewAuthCookies } from "@/lib/authz.server";
import { auditPreviewEvent } from "@/lib/audit";
import { safeReturnPath } from "@/lib/safe-return-path";
import { hasExactSameOrigin } from "@/lib/request-security";
import { verifyPreviewCsrfToken } from "@/lib/preview-csrf";

const MAX_FORM_BYTES = 4_096;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

function json(body: Record<string, string>, status: number) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function POST(request: Request) {
  if (!previewAuthEnabled()) {
    return json({ error: "PREVIEW_AUTH_DISABLED" }, 404);
  }
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin && suppliedOrigin !== "null" && !hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN_ORIGIN" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_FORM_BYTES) {
    return json({ error: "REQUEST_TOO_LARGE" }, 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FORM_BYTES) return json({ error: "REQUEST_TOO_LARGE" }, 413);
  const form = new URLSearchParams(text);
  const role = normalizeRole(form.get("role"));
  if (!role) return json({ error: "INVALID_ROLE" }, 400);
  const nextPath = safeReturnPath(form.get("next"));
  if (!verifyPreviewCsrfToken(form.get("csrfToken"), nextPath)) {
    return json({ error: "FORBIDDEN_CSRF" }, 403);
  }

  const response = NextResponse.redirect(new URL(nextPath, request.url), { status: 303 });
  response.headers.set("Cache-Control", noStore["Cache-Control"]);
  setPreviewAuthCookies(response, role);
  await auditPreviewEvent({
    eventType: "auth.sign_in",
    actorId: `preview-${role}`,
    organizationId: "local801-preview",
    payload: { role },
  });
  return response;
}
