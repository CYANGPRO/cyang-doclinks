import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { publicImportApprovalError } from "@/lib/import-approval-errors";
import { clearImportRowResolution, setImportRowResolution } from "@/lib/import-approval";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store, max-age=0" };

function forbiddenOrigin() {
  return NextResponse.json(
    { error: "FORBIDDEN", message: "This request must come from the signed-in preview." },
    { status: 403, headers: noStore },
  );
}

function failureResponse(error: unknown) {
  const failure = publicImportApprovalError(error);
  return NextResponse.json(
    { error: failure.code, message: failure.message },
    { status: failure.status, headers: noStore },
  );
}

type RouteContext = { params: Promise<{ batchId: string; rowId: string }> };

export async function PUT(request: Request, { params }: RouteContext) {
  if (!hasExactSameOrigin(request)) return forbiddenOrigin();
  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  try {
    const [{ batchId, rowId }, body, context] = await Promise.all([
      params,
      request.json() as Promise<{ resolutionType?: unknown }>,
      resolveWorkspaceContext(auth.user),
    ]);
    const result = await setImportRowResolution(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      { batchId, rowId, resolutionType: body?.resolutionType },
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return failureResponse(error);
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!hasExactSameOrigin(request)) return forbiddenOrigin();
  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  try {
    const [{ batchId, rowId }, context] = await Promise.all([
      params,
      resolveWorkspaceContext(auth.user),
    ]);
    const result = await clearImportRowResolution(
      { organizationId: context.organizationId, userId: context.userId, role: context.role },
      { batchId, rowId },
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return failureResponse(error);
  }
}
