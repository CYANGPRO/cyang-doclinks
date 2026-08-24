import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { getImportProcessingStatus } from "@/lib/import-persistence";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const auth = await requirePreviewUser("manageImports", { skipRateLimit: true });
  if (!auth.ok) return auth.response;
  try {
    const [{ batchId }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    const status = await getImportProcessingStatus(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      batchId,
    );
    if (!status) return NextResponse.json({ error: "IMPORT_NOT_FOUND" }, { status: 404, headers: noStore });
    return NextResponse.json({
      processingStage: status.processing_stage,
      processedRowCount: status.processed_row_count,
      totalRowCount: status.total_row_count,
      errorCode: status.processing_error_code,
    }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "IMPORT_STATUS_UNAVAILABLE" }, { status: 503, headers: noStore });
  }
}
