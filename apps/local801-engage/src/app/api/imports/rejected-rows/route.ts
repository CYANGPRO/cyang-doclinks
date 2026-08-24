import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { hasExactSameOrigin } from "@/lib/request-security";

export async function POST(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return NextResponse.json({ error: "FORBIDDEN_ORIGIN" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;
  void request;
  return NextResponse.json({ error: "USE_PERSISTED_BATCH_ERRORS_ENDPOINT" }, { status: 405 });
}
