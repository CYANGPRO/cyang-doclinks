import { NextResponse } from "next/server";
import { AuditExportLimitError, writeAuditEvent } from "@/lib/audit";
import { getAuditDisplayExport } from "@/lib/audit-display";
import { buildAuditActivityWorkbook, XLSX_CONTENT_TYPE } from "@/lib/audit-export-xlsx";
import { requirePreviewUser } from "@/lib/authz.server";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";
import { writeSecuritySignal } from "@/lib/security-signal";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function jsonNoStore(body: Record<string, string>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}

export async function GET(request: Request) {
  const auth = await requirePreviewUser("manageUsers");
  if (!auth.ok) {
    auth.response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
    return auth.response;
  }

  try {
    const context = await resolveWorkspaceContext(auth.user);
    await enforceWorkspaceRateLimit(context, "export");
    const eventType = new URL(request.url).searchParams.get("eventType") ?? "";
    const exported = await getAuditDisplayExport(context, { eventType });
    const workbook = await buildAuditActivityWorkbook(exported.events);

    await writeAuditEvent({
      eventType: "export.generate",
      actorId: context.userId,
      organizationId: context.organizationId,
      subjectType: "report",
      payload: {
        reportType: "audit_activity",
        eventCount: exported.events.length,
        filtered: Boolean(exported.eventType),
      },
    });
    writeSecuritySignal("warn", "protected_access", {
      outcome: "success",
      operation: "audit_activity.export",
      actorId: context.userId,
      organizationId: context.organizationId,
    });

    const filename = `local801-audit-activity-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const responseBody = new Uint8Array(workbook.byteLength);
    responseBody.set(workbook);
    return new Response(responseBody, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(workbook.byteLength),
        "Content-Type": XLSX_CONTENT_TYPE,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof AuditExportLimitError) {
      return jsonNoStore({ error: "AUDIT_EXPORT_LIMIT", message: error.message }, 422);
    }
    return jsonNoStore({
      error: "AUDIT_EXPORT_UNAVAILABLE",
      message: "The complete bounded audit export is unavailable. No partial Excel file was returned.",
    }, 503);
  }
}
