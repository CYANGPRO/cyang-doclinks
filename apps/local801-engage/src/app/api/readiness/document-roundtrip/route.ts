import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { hasExactSameOrigin } from "@/lib/request-security";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";
import { resolveWorkspaceContext } from "@/lib/workspace-context";
import {
  deleteEncryptedDocument,
  downloadDocument,
  StorageCleanupPendingError,
  storeEncryptedDocument,
  type StorageActor,
} from "@/lib/document-storage";

export async function POST(request: Request) {
  if (!operationalRuntimeEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  if (!hasExactSameOrigin(request)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const auth = await requirePreviewUser("manageUsers");
  if (!auth.ok) return auth.response;

  let storedDocumentId: string | undefined;
  let actor: StorageActor | undefined;
  let roundTripSucceeded = false;
  let cleanup: "ok" | "pending" = "ok";
  try {
    const context = await resolveWorkspaceContext(auth.user);

    actor = { organizationId: context.organizationId, role: context.role };
    const plaintext = Buffer.from("Local 801 synthetic encrypted storage round trip", "utf8");
    const stored = await storeEncryptedDocument({
      actor,
      organizationId: context.organizationId,
      category: "readiness",
      title: "Synthetic encrypted storage round trip",
      originalFilename: "synthetic-readiness.txt",
      visibility: "local_admin_only",
      status: "draft",
      createdBy: context.userId,
      content: plaintext,
      mediaType: "text/plain",
    });
    storedDocumentId = stored.id;
    const downloaded = await downloadDocument({
      actor,
      organizationId: context.organizationId,
      documentId: stored.id,
    });
    if (
      downloaded.plaintext.byteLength !== plaintext.byteLength ||
      !timingSafeEqual(downloaded.plaintext, plaintext)
    ) {
      throw new Error("Synthetic round trip mismatch.");
    }
    roundTripSucceeded = true;
  } catch (error) {
    roundTripSucceeded = false;
    if (error instanceof StorageCleanupPendingError) cleanup = "pending";
  }

  if (storedDocumentId && actor) {
    try {
      const result = await deleteEncryptedDocument({
        actor,
        organizationId: actor.organizationId,
        documentId: storedDocumentId,
      });
      cleanup = result.deleted ? "ok" : "pending";
    } catch {
      cleanup = "pending";
    }
  }

  const succeeded = roundTripSucceeded && cleanup === "ok";
  return NextResponse.json(
    succeeded
      ? { documentRoundTrip: "ok" }
      : { documentRoundTrip: "error", cleanup },
    {
      status: succeeded ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
