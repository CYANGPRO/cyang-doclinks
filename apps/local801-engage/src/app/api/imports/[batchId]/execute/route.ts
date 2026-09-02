import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import {
  authoritativeExecutionEnabled,
  executeAuthoritativeImport,
  ImportExecutionError,
} from "@/lib/import-execution";
import { getImportExecutionPreflight } from "@/lib/import-execution-preflight";
import {
  enterImportReviewForProtectedExecution,
  ImportExecutionLifecycleError,
} from "@/lib/import-execution-lifecycle";
import { applyPreparedProtectedImport, ProtectedImportApplyError } from "@/lib/pii-protected-import-apply";
import { applyPreparedAttendanceImport, AttendanceImportApplyError } from "@/lib/attendance-import-apply";
import { prepareProtectedImportExecution } from "@/lib/pii-protected-import-execution";
import { protectedImportMembershipTransaction } from "@/lib/pii-protected-import-membership-transaction";
import {
  safeProtectedImportExecutionDiagnostic,
  type ProtectedImportExecutionStage,
} from "@/lib/protected-import-execution-diagnostics";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import { enforceWorkspaceRateLimit, RateLimitError } from "@/lib/rate-limit";
import { rateLimitResponse } from "@/lib/rate-limit-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 512;
const noStore = { "Cache-Control": "private, no-store, max-age=0, must-revalidate" };

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

function protectedExecutionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"
    && env.LOCAL801_PII_DUAL_WRITE_ENABLED !== "1"
    && env.LOCAL801_PII_BACKFILL_ENABLED !== "1"
    && env.LOCAL801_AUTHORITATIVE_IMPORT_EXECUTION_ENABLED === "1"
    && env.LOCAL801_PROTECTED_IMPORT_PREPARATION_ENABLED === "1"
    && env.LOCAL801_PROTECTED_IMPORT_EXECUTION_ENABLED === "1";
}

function executionRouteEnabled(env: NodeJS.ProcessEnv = process.env) {
  return protectedExecutionEnabled(env) || authoritativeExecutionEnabled(env);
}

export async function POST(request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  if (!executionRouteEnabled()) return json({ error: "NOT_FOUND" }, 404);
  if (!hasExactSameOrigin(request)) {
    return json({ error: "FORBIDDEN", message: "This request must come from the signed-in Local 801 application." }, 403);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return json({ error: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must be JSON." }, 415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > MAX_BODY_BYTES)) {
    return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
  }

  const auth = await requirePreviewUser("approveImports");
  if (!auth.ok) return auth.response;

  let executionStage: ProtectedImportExecutionStage = "request";
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
    const body = JSON.parse(text) as { fingerprint?: unknown };
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
    executionStage = "workspace";
    const [{ batchId }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    executionStage = "rate-limit";
    await enforceWorkspaceRateLimit(context, "import");
    const actor = { organizationId: context.organizationId, userId: context.userId, role: context.role };

    if (protectedExecutionEnabled()) {
      executionStage = "preflight";
      const preflight = await getImportExecutionPreflight(actor, batchId);
      if (!preflight.ready || !preflight.fingerprint) {
        return json({ error: "PREFLIGHT_BLOCKED", message: "The current import execution preflight is not ready." }, 409);
      }
      if (preflight.fingerprint !== fingerprint) {
        return json({ error: "STALE_FINGERPRINT", message: "The import changed after confirmation. Refresh and confirm the current execution fingerprint." }, 409);
      }
      executionStage = "review-transition";
      await enterImportReviewForProtectedExecution(actor, batchId);
      executionStage = "preparation";
      const prepared = await prepareProtectedImportExecution(actor, batchId, { approvalFingerprint: fingerprint });
      executionStage = "atomic-apply";
      const result = preflight.importKind === "attendance_roster"
        ? await applyPreparedAttendanceImport(
          actor,
          batchId,
          prepared.executionSetId,
          prepared.mutationFingerprint,
          fingerprint,
          { transaction: protectedImportMembershipTransaction },
        )
        : await applyPreparedProtectedImport(
          actor,
          batchId,
          prepared.executionSetId,
          prepared.mutationFingerprint,
          { transaction: protectedImportMembershipTransaction },
        );
      return json({
        importExecution: "ok",
        protectionMode: "protected",
        executed: result.executed,
        importKind: result.importKind,
        counts: result.counts,
      });
    }

    executionStage = "legacy-apply";
    const result = await executeAuthoritativeImport(actor, batchId, fingerprint);
    return json({ importExecution: "ok", protectionMode: "synthetic_preview", ...result });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error);
    if (error instanceof ImportExecutionError
      || error instanceof ImportExecutionLifecycleError
      || error instanceof ProtectedImportApplyError
      || error instanceof AttendanceImportApplyError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    const diagnostic = safeProtectedImportExecutionDiagnostic(executionStage, error);
    console.error("[local801-protected-import-safe-failure]", JSON.stringify(diagnostic));
    return json({
      error: "EXECUTION_FAILED",
      message: "The protected import was not committed. No roster changes were applied.",
      recovery: [
        "Refresh this import and confirm that it still shows Ready to apply.",
        "If it remains ready, retry once. If it fails again, stop and send only the support reference to the System Owner.",
      ],
      supportReference: diagnostic.supportReference,
    }, 503);
  }
}
