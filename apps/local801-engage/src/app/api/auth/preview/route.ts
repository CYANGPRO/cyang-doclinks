import { NextResponse } from "next/server";
import { normalizeRole, previewAuthEnabled, setPreviewAuthCookies } from "@/lib/authz.server";
import { auditPreviewEvent } from "@/lib/audit";
import { hasExactSameOrigin } from "@/lib/request-security";

const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

export async function POST(request: Request) {
  if (!previewAuthEnabled()) {
    return NextResponse.json({ error: "PREVIEW_AUTH_DISABLED" }, { status: 404, headers: noStore });
  }
  if (!hasExactSameOrigin(request)) {
    return NextResponse.json({ error: "FORBIDDEN_ORIGIN" }, { status: 403, headers: noStore });
  }

  const form = await request.formData();
  const role = normalizeRole(String(form.get("role") ?? ""));
  if (!role) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400, headers: noStore });

  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
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
