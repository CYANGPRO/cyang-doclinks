import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { getImportBatch, getImportErrors } from "@/lib/import-persistence";
import { neutralizeSpreadsheetFormula } from "@/lib/imports";
import { writeAuditEvent } from "@/lib/audit";
import { writeSecuritySignal } from "@/lib/security-signal";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = String(neutralizeSpreadsheetFormula(value ?? ""));
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const auth = await requirePreviewUser("manageImports");
  if (!auth.ok) return auth.response;
  const { batchId } = await params;
  try {
    const context = await resolveWorkspaceContext(auth.user);
    const actor = { organizationId: context.organizationId, role: context.role, userId: context.userId };
    const batch = await getImportBatch(actor, batchId);
    if (!batch) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const errors = await getImportErrors(actor, batchId);
    const csv = [
      ["rowNumber", "severity", "field", "message"].join(","),
      ...errors.map((error) => [error.row_number ?? "", error.severity, error.field_name ?? "", error.message].map(csvCell).join(",")),
    ].join("\n");
    await writeAuditEvent({
      eventType: "import.reject_errors_download",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "import_batch",
      subjectId: batchId,
      payload: { errorCount: errors.length },
    });
    writeSecuritySignal("warn", "protected_access", {
      outcome: "success", operation: "import_errors.export", actorId: context.userId,
      organizationId: context.organizationId, subjectId: batchId,
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="local801-import-${batchId}-errors.csv"`,
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch {
    return NextResponse.json({ error: "IMPORT_ERRORS_UNAVAILABLE", message: "The complete bounded error export is unavailable. No partial CSV was returned." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
