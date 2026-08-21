import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";

export async function POST(request: Request) {
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;
  void request;
  return NextResponse.json({ error: "USE_PERSISTED_BATCH_ERRORS_ENDPOINT" }, { status: 405 });
}
