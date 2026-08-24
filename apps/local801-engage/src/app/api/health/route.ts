import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { assertLocal801Isolation } from "@/lib/config";
import { checkDatabaseReadiness } from "@/lib/db";
import { checkStorageReadiness } from "@/lib/r2";
import { validateEncryptionConfig } from "@/lib/encryption";
import { operationalRuntimeEnabled } from "@/lib/operational-runtime";

export async function GET() {
  if (!operationalRuntimeEnabled()) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const auth = await requirePreviewUser("manageUsers", { skipRateLimit: true });
  if (!auth.ok) return auth.response;

  const isolation = assertLocal801Isolation();
  const application =
    isolation.separateDatabase &&
    isolation.separateStorage &&
    isolation.signupDisabled &&
    isolation.mfaRequired &&
    isolation.pushDisabled
      ? "ok"
      : "error";
  const [database, storage] = await Promise.all([checkDatabaseReadiness(), checkStorageReadiness()]);
  const encryption = validateEncryptionConfig();

  return NextResponse.json({
    application,
    database: database.database,
    storage: storage.storage,
    encryption: encryption.encryption,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
