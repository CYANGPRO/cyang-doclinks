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
    subjectId: view,
    payload: { view, outcome: "success" },
  });
  writeSecuritySignal("warn", "protected_access", {
    outcome: "success", operation: `report.${view}`, actorId: context.userId,
    organizationId: context.organizationId,
  });
}
