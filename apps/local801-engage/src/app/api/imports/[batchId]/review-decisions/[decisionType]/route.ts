import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { clearImportReviewDecision, setImportReviewDecision, type ImportReviewDecisionType } from "@/lib/import-review";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store, max-age=0" };
function isDecision(value: string): value is ImportReviewDecisionType { return value === "allow_proposed_new" || value === "acknowledge_existing_changes"; }
function forbidden() { return NextResponse.json({ error: "FORBIDDEN", message: "This request must come from the signed-in Local 801 application." }, { status: 403, headers: noStore }); }
function unavailable() { return NextResponse.json({ error: "REVIEW_UPDATE_FAILED", message: "The batch review decision could not be saved. No roster changes were made." }, { status: 409, headers: noStore }); }

async function contextFor(request: Request, params: Promise<{ batchId: string; decisionType: string }>) {
  if (!hasExactSameOrigin(request)) return { response: forbidden() };
  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return { response: auth.response };
  const [values, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
  if (!isDecision(values.decisionType)) return { response: unavailable() };
  return { values: { ...values, decisionType: values.decisionType }, actor: { organizationId: context.organizationId, userId: context.userId, role: context.role } };
}

export async function PUT(request: Request, { params }: { params: Promise<{ batchId: string; decisionType: string }> }) {
  try {
    const resolved = await contextFor(request, params); if ("response" in resolved) return resolved.response;
    const body = await request.json() as { expectedHash?: unknown };
    if (typeof body.expectedHash !== "string") return unavailable();
    await setImportReviewDecision(resolved.actor, resolved.values.batchId, resolved.values.decisionType, body.expectedHash);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch { return unavailable(); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ batchId: string; decisionType: string }> }) {
  try {
    const resolved = await contextFor(request, params); if ("response" in resolved) return resolved.response;
    await clearImportReviewDecision(resolved.actor, resolved.values.batchId, resolved.values.decisionType);
    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch { return unavailable(); }
}
