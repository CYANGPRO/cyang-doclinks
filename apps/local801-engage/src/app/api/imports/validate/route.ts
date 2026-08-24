import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { mapHeaders, shouldIncludeLocal801 } from "@/lib/imports";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { ControlledImportError, publicImportError } from "@/lib/import-errors";
import { hasExactSameOrigin } from "@/lib/request-security";
import { acceptDurableImport } from "@/lib/import-async-acceptance";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export async function GET() {
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;

  const headers = [
    "Local Name",
    "Preferred/First Name",
    "Last Name",
    "Department",
    "Section Name",
    "Work Email",
    "Work Phone",
    "Cell Phone",
    "Home Phone",
    "Home Email",
    "Appointment Employment Status Name",
    "MAPE Hire Date",
  ];
  return NextResponse.json({
    mappedHeaders: mapHeaders(headers),
    local0801Included: shouldIncludeLocal801("801"),
    obsoleteWorksheetsIgnoredByDefault: true,
    sourceRowsStoredPrivately: true,
  });
}

export async function POST(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return NextResponse.json(
      { error: "FORBIDDEN_ORIGIN", message: "This import request must come from the signed-in Local 801 application." },
      { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;

  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, "import");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "MISSING_FILE", message: "Select an .xlsx or .csv file to import." }, { status: 400 });
    }
    const processingMode = form.get("processingMode");
    if (processingMode === "durable" || processingMode === "durable_preview") {
      const accepted = await acceptDurableImport({
        actor: { organizationId: context.organizationId, role: context.role, userId: context.userId },
        file,
        importKind: form.get("importKind"),
      });
      return NextResponse.json(accepted, {
        status: 202,
        headers: { "Cache-Control": "no-store, max-age=0", Location: accepted.statusLocation },
      });
    }
    if (process.env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1") {
      return NextResponse.json(
        {
          error: "PROTECTED_DURABLE_IMPORT_REQUIRED",
          message: "Protected-only imports require the scanner-backed durable worker.",
        },
        { status: 409, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    const { persistImportReview } = await import("@/lib/import-persistence");
    const summary = await persistImportReview({
      actor: { organizationId: context.organizationId, role: context.role, userId: context.userId },
      file,
      importKind: form.get("importKind"),
    });
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    const failure = publicImportError(error);
    console.error("[local801-import-safe-failure]", JSON.stringify({
      code: failure.code,
      status: failure.status,
      stage: error instanceof ControlledImportError ? error.safeStage : null,
    }));
    return NextResponse.json(
      { error: failure.code, message: failure.message },
      { status: failure.status, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
