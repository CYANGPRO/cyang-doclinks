import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { mapHeaders, shouldIncludeLocal801 } from "@/lib/imports";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { persistImportReview } from "@/lib/import-persistence";
import { publicImportError } from "@/lib/import-errors";
import { hasExactSameOrigin } from "@/lib/request-security";
import { acceptDurablePreviewCsv } from "@/lib/import-async-acceptance";

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
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "MISSING_FILE", message: "Select an .xlsx or .csv file to import." }, { status: 400 });
    }
    if (form.get("processingMode") === "durable_preview") {
      const accepted = await acceptDurablePreviewCsv({
        actor: { organizationId: context.organizationId, role: context.role, userId: context.userId },
        file,
        importKind: form.get("importKind"),
      });
      return NextResponse.json(accepted, {
        status: 202,
        headers: { "Cache-Control": "no-store, max-age=0", Location: accepted.statusLocation },
      });
    }
    const summary = await persistImportReview({
      actor: { organizationId: context.organizationId, role: context.role, userId: context.userId },
      file,
      importKind: form.get("importKind"),
    });
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    const failure = publicImportError(error);
    return NextResponse.json(
      { error: failure.code, message: failure.message },
      { status: failure.status, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
