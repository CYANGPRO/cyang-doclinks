import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { listImportBatches } from "@/lib/import-persistence";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;
  try {
    const context = await resolveWorkspaceContext(auth.user);
    const rows = await listImportBatches({ organizationId: context.organizationId, role: context.role, userId: context.userId });
    return NextResponse.json({ imports: rows }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return NextResponse.json({ error: "IMPORT_QUEUE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
