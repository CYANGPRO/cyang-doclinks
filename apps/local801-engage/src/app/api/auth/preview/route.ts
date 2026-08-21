import { NextResponse } from "next/server";
import { normalizeRole, previewAuthEnabled, setPreviewAuthCookies } from "@/lib/authz.server";
import { auditPreviewEvent } from "@/lib/audit";

export async function POST(request: Request) {
  if (!previewAuthEnabled()) {
    return NextResponse.json({ error: "PREVIEW_AUTH_DISABLED" }, { status: 404 });
  }

  const form = await request.formData();
  const role = normalizeRole(String(form.get("role") ?? ""));
  if (!role) return NextResponse.json({ error: "INVALID_ROLE" }, { status: 400 });

  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  setPreviewAuthCookies(response, role);
  await auditPreviewEvent({
    eventType: "auth.sign_in",
    actorId: `preview-${role}`,
    organizationId: "local801-preview",
    payload: { role },
  });
  return response;
}
