import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { publicImportApprovalError } from "@/lib/import-approval-errors";
import { acknowledgeDuplicateImportSource } from "@/lib/import-approval";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  if (!hasExactSameOrigin(request)) {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "This request must come from the signed-in preview." },
      { status: 403, headers: noStore },
    );
  }
  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  try {
    const [{ batchId }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    const result = await acknowledgeDuplicateImportSource(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      batchId,
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    const failure = publicImportApprovalError(error);
    return NextResponse.json(
      { error: failure.code, message: failure.message },
      { status: failure.status, headers: noStore },
    );
  }
}
