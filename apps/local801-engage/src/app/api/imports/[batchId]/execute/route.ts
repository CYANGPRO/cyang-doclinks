import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import {
  authoritativeExecutionEnabled,
  executeAuthoritativeImport,
  ImportExecutionError,
} from "@/lib/import-execution";
import { getImportExecutionPreflight } from "@/lib/import-execution-preflight";
import { applyPreparedProtectedImport, ProtectedImportApplyError } from "@/lib/pii-protected-import-apply";
import { prepareProtectedImportExecution } from "@/lib/pii-protected-import-execution";
import { protectedImportMembershipTransaction } from "@/lib/pii-protected-import-membership-transaction";
import { hasExactSameOrigin } from "@/lib/request-security";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

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

  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return json({ error: "REQUEST_TOO_LARGE", message: "Request body is too large." }, 413);
    const body = JSON.parse(text) as { fingerprint?: unknown };
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
    const [{ batchId }, context] = await Promise.all([params, resolveWorkspaceContext(auth.user)]);
    const actor = { organizationId: context.organizationId, userId: context.userId, role: context.role };

    if (protectedExecutionEnabled()) {
      const preflight = await getImportExecutionPreflight(actor, batchId);
      if (!preflight.ready || !preflight.fingerprint) {
        return json({ error: "PREFLIGHT_BLOCKED", message: "The current import execution preflight is not ready." }, 409);
      }
      if (preflight.fingerprint !== fingerprint) {
        return json({ error: "STALE_FINGERPRINT", message: "The import changed after confirmation. Refresh and confirm the current execution fingerprint." }, 409);
      }
      const prepared = await prepareProtectedImportExecution(actor, batchId);
      const result = await applyPreparedProtectedImport(
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

    const result = await executeAuthoritativeImport(actor, batchId, fingerprint);
    return json({ importExecution: "ok", protectionMode: "synthetic_preview", ...result });
  } catch (error) {
    if (error instanceof ImportExecutionError || error instanceof ProtectedImportApplyError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    return json({ error: "EXECUTION_FAILED", message: "The authoritative import was not committed. No partial roster result is accepted." }, 503);
  }
}
