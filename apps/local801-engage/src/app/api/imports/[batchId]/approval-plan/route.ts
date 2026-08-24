import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { publicImportApprovalError } from "@/lib/import-approval-errors";
import { saveImportApprovalPlan } from "@/lib/import-approval";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function PUT(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  if (!hasExactSameOrigin(request)) {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "This request must come from the signed-in Local 801 application." },
      { status: 403, headers: noStore },
    );
  }
  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  try {
    const [{ batchId }, body, context] = await Promise.all([
      params,
      request.json() as Promise<{ snapshotDate?: unknown; effectiveDate?: unknown }>,
      resolveWorkspaceContext(auth.user),
    ]);
    await enforceWorkspaceRateLimit(context, "import");
    const result = await saveImportApprovalPlan(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      { batchId, snapshotDate: body?.snapshotDate, effectiveDate: body?.effectiveDate },
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const failure = publicImportApprovalError(error);
    return NextResponse.json(
      { error: failure.code, message: failure.message },
      { status: failure.status, headers: noStore },
    );
  }
}
