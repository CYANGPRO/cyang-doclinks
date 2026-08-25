import "server-only";

import { writeAuditEvent, type AuditEvent } from "./audit.ts";
import { writeSecuritySignal } from "./security-signal.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export type AuditedReportView =
  | "overview"
  | "membership"
  | "new-hires"
  | "engagement"
  | "campaigns"
  | "cat-actions"
  | "data-quality";

export async function recordReportAccess(
  context: Pick<WorkspaceContext, "organizationId" | "userId">,
  view: AuditedReportView,
  audit: (event: AuditEvent) => Promise<unknown> = writeAuditEvent,
) {
  await audit({
    eventType: "report.run",
    actorId: context.userId,
    organizationId: context.organizationId,
    subjectType: "report",
    // audit_events.subject_id is UUID-only. The report key belongs in the
    // metadata payload because a report view is not a durable database row.
    payload: { view, outcome: "success" },
  });
  writeSecuritySignal("warn", "protected_access", {
    outcome: "success", operation: `report.${view}`, actorId: context.userId,
    organizationId: context.organizationId,
  });
}

function diagnosticField(error: unknown, key: string, maxLength: number) {
  try {
    if (!error || typeof error !== "object") return null;
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value.slice(0, maxLength) : null;
  } catch {
    return null;
  }
}

export function reportFailureDiagnostic(error: unknown, view: AuditedReportView) {
  const code = diagnosticField(error, "code", 80);
  const constraint = diagnosticField(error, "constraint_name", 120) ?? diagnosticField(error, "constraint", 120);
  const table = diagnosticField(error, "table_name", 120) ?? diagnosticField(error, "table", 120);
  return {
    name: diagnosticField(error, "name", 80) ?? "UnknownError",
    view,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
    ...(table ? { table } : {}),
  };
}
