import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { __testing as documentTesting, getDocumentsPage, resolveDocumentDownloadId } from "../src/lib/documents.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});

function documentRow(index = 0, overrides = {}) {
  const handle = index.toString(16).padStart(64, "0");
  return {
    category: "Member communications",
    title: `Synthetic document ${index}`,
    original_filename: `synthetic-${index}.pdf`,
    media_type: "application/pdf",
    visibility: "local_admin_only",
    status: "active",
    uploader_name: "Synthetic Admin",
    created_at: `2026-08-${String(Math.max(1, 14 - index)).padStart(2, "0")}T12:00:00.000Z`,
    download_handle: handle,
    cursor_token: handle,
    ...overrides,
  };
}

test("document visibility scopes are derived from the existing permission model", () => {
  assert.deepEqual(documentTesting.allowedVisibilities("system_owner"), [
    "local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope",
  ]);
  assert.deepEqual(documentTesting.allowedVisibilities("local_admin"), [
    "local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope",
  ]);
  assert.deepEqual(documentTesting.allowedVisibilities("membership_data_manager"), ["membership_management"]);
  assert.deepEqual(documentTesting.allowedVisibilities("cat_admin"), ["cat_admin_only", "cat_lead_scope", "cat_member_scope"]);
  assert.deepEqual(documentTesting.allowedVisibilities("cat_lead"), ["cat_lead_scope", "cat_member_scope"]);
  assert.deepEqual(documentTesting.allowedVisibilities("cat_member"), ["cat_member_scope"]);
  assert.deepEqual(documentTesting.allowedVisibilities("report_viewer"), []);
});

test("roles without viewDocuments fail before database work", async () => {
  for (const role of ["report_viewer"]) {
    let calls = 0;
    await assert.rejects(getDocumentsPage(context(role), {}, async () => {
      calls += 1;
      return [];
    }), /Forbidden/);
    assert.equal(calls, 0);
  }
});

test("document metadata query is tenant scoped, visibility scoped, and returns only a one-way download handle", async () => {
  let sqlText = "";
  let parameters = [];
  const handle = "a".repeat(64);
  const result = await getDocumentsPage(context("membership_data_manager"), {}, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return [documentRow(1, { visibility: "membership_management", download_handle: handle, cursor_token: handle })];
  });

  assert.deepEqual(parameters, [organizationId, ["membership_management"], null, null, 51]);
  assert.match(sqlText, /document\.organization_id = \$1::uuid/);
  assert.match(sqlText, /document\.visibility = ANY\(\$2::text\[\]\)/);
  assert.match(sqlText, /document\.archived_at IS NULL/);
  assert.match(sqlText, /creator\.organization_id = document\.organization_id/);
  assert.match(sqlText, /digest\(document\.organization_id::text \|\| ':' \|\| document\.id::text, 'sha256'\)/);
  assert.doesNotMatch(sqlText, /storage_key|encryption_key_version|storage_cleanup_pending_at/);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].downloadHandle, handle);
  assert.equal("id" in result.documents[0], false);
  assert.equal("cursor_token" in result.documents[0], false);
});

test("document download handle resolver rejects malformed handles before SQL", async () => {
  let calls = 0;
  for (const value of [null, "", "not-a-handle", "x".repeat(65)]) {
    const result = await resolveDocumentDownloadId(context(), value, async () => {
      calls += 1;
      return [];
    });
    assert.equal(result, null);
  }
  assert.equal(calls, 0);
});

test("document download handle resolver fails unauthorized roles before SQL", async () => {
  let calls = 0;
  await assert.rejects(resolveDocumentDownloadId(context("report_viewer"), "a".repeat(64), async () => {
    calls += 1;
    return [];
  }), /Forbidden/);
  assert.equal(calls, 0);
});

test("document download handle resolution is tenant and visibility scoped and does not accept a browser-supplied UUID", async () => {
  let sqlText = "";
  let parameters = [];
  const internalId = "33333333-3333-4333-8333-333333333333";
  const handle = "B".repeat(64);
  const resolved = await resolveDocumentDownloadId(context("cat_admin"), handle, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return [{ id: internalId }];
  });

  assert.equal(resolved, internalId);
  assert.deepEqual(parameters, [organizationId, ["cat_admin_only", "cat_lead_scope", "cat_member_scope"], handle.toLowerCase()]);
  assert.match(sqlText, /document\.organization_id = \$1::uuid/);
  assert.match(sqlText, /document\.visibility = ANY\(\$2::text\[\]\)/);
  assert.match(sqlText, /document\.archived_at IS NULL/);
  assert.match(sqlText, /digest\(document\.organization_id::text \|\| ':' \|\| document\.id::text, 'sha256'\)/);
  assert.match(sqlText, /= \$3::text/);
});

test("each authorized role passes only its allowed visibility values to SQL", async () => {
  const expected = {
    system_owner: ["local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope"],
    local_admin: ["local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope"],
    membership_data_manager: ["membership_management"],
    cat_admin: ["cat_admin_only", "cat_lead_scope", "cat_member_scope"],
    cat_lead: ["cat_lead_scope", "cat_member_scope"],
    cat_member: ["cat_member_scope"],
  };

  for (const [role, visibilities] of Object.entries(expected)) {
    await getDocumentsPage(context(role), {}, async (_sql, parameters) => {
      assert.deepEqual(parameters[1], visibilities);
      return [];
    });
  }
});

test("document pagination is hard bounded and emits an opaque cursor without a document UUID", async () => {
  const rows = Array.from({ length: 101 }, (_, index) => documentRow(index));
  let limitParameter = null;
  const result = await getDocumentsPage(context(), { pageSize: 999 }, async (_sql, parameters) => {
    limitParameter = parameters.at(-1);
    return rows;
  });

  assert.equal(limitParameter, 101);
  assert.equal(result.pageSize, 100);
  assert.equal(result.documents.length, 100);
  assert.equal(typeof result.nextCursor, "string");

  const decoded = JSON.parse(Buffer.from(result.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["createdAt", "token"]);
  assert.match(decoded.token, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(decoded), /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test("valid document cursor is parameterized and invalid cursor input is ignored safely", async () => {
  const cursor = Buffer.from(JSON.stringify({
    createdAt: "2026-08-14T12:00:00.000Z",
    token: "a".repeat(64),
  })).toString("base64url");

  await getDocumentsPage(context(), { cursor }, async (sql, parameters) => {
    assert.equal(parameters[2], "2026-08-14T12:00:00.000Z");
    assert.equal(parameters[3], "a".repeat(64));
    assert.match(sql, /\(created_at, cursor_token\) < \(\$3::timestamptz, \$4::text\)/);
    return [];
  });

  await getDocumentsPage(context(), { cursor: "not-a-cursor" }, async (_sql, parameters) => {
    assert.equal(parameters[2], null);
    assert.equal(parameters[3], null);
    return [];
  });
});

test("document handle parser rejects overlong or malformed values", () => {
  assert.equal(documentTesting.normalizeDocumentHandle("A".repeat(64)), "a".repeat(64));
  assert.equal(documentTesting.normalizeDocumentHandle("not-a-token"), null);
  assert.equal(documentTesting.normalizeDocumentHandle("x".repeat(65)), null);
});

test("download route is preview-only, authenticated, handle-resolved, decrypted through the existing service, and non-cacheable", () => {
  const source = readFileSync(new URL("../src/app/api/documents/[handle]/download/route.ts", import.meta.url), "utf8");
  assert.match(source, /VERCEL_ENV === "production"/);
  assert.match(source, /LOCAL801_PREVIEW_AUTH_ENABLED !== "1"/);
  assert.match(source, /requirePreviewUser\("viewDocuments"\)/);
  assert.match(source, /resolveWorkspaceContext\(auth\.user\)/);
  assert.match(source, /resolveDocumentDownloadId\(context, handle\)/);
  assert.match(source, /downloadDocument\(/);
  assert.match(source, /writeAuditEvent\(/);
  assert.match(source, /eventType: "record\.access"/);
  assert.match(source, /outcome: "success"/);
  assert.match(source, /Cache-Control.*private, no-store/);
  assert.match(source, /Content-Disposition/);
  assert.match(source, /X-Content-Type-Options.*nosniff/);
  assert.match(source, /Cross-Origin-Resource-Policy.*same-origin/);
  assert.doesNotMatch(source, /storage_key|presign|signedUrl|putObject/);
});

test("documents page uses the opaque handle for download and never renders a document UUID", () => {
  const source = readFileSync(new URL("../src/app/documents/page.tsx", import.meta.url), "utf8");
  assert.match(source, /document\.downloadHandle/);
  assert.match(source, /\/api\/documents\/\$\{document\.downloadHandle\}\/download/);
  assert.doesNotMatch(source, /document\.id/);
  assert.doesNotMatch(source, /storageKey|encryptionKeyVersion|sha256/);
});


test("CAT members can resolve only CAT-member-scoped document handles", async () => {
  const handle = "c".repeat(64);
  let parameters = null;
  const resolved = await resolveDocumentDownloadId(context("cat_member"), handle, async (_sql, values) => {
    parameters = values;
    return [{ id: "44444444-4444-4444-8444-444444444444" }];
  });
  assert.equal(resolved, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(parameters, [organizationId, ["cat_member_scope"], handle]);
});
