import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { approveDocument, DocumentApprovalError } from "../src/lib/document-approval.ts";
import {
  canAccessStoredDocument,
  canChooseDocumentVisibility,
  uploaderRolesBelow,
} from "../src/lib/document-access.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const handle = "a".repeat(64);

const context = (role = "cat_member") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});

test("document hierarchy is explicit, strict between peers, and always includes the uploader", () => {
  assert.deepEqual(uploaderRolesBelow("cat_lead"), ["cat_member", "report_viewer"]);
  const document = {
    visibility: "uploader_hierarchy",
    createdBy: userId,
    uploadedByRole: "cat_member",
  };
  assert.equal(canAccessStoredDocument({ userId, role: "cat_member" }, document), true);
  assert.equal(canAccessStoredDocument({ userId: "44444444-4444-4444-8444-444444444444", role: "cat_member" }, document), false);
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"]) {
    assert.equal(canAccessStoredDocument({ role }, document), true, role);
  }
  assert.equal(canAccessStoredDocument({ role: "report_viewer" }, document), false);
});

test("workspace-wide sharing is restricted through LCAT while all roles may use hierarchy sharing", () => {
  for (const role of ["system_owner", "local_admin", "cat_admin", "cat_lead"]) {
    assert.equal(canChooseDocumentVisibility(role, "everyone"), true, role);
  }
  for (const role of ["membership_data_manager", "cat_member", "report_viewer"]) {
    assert.equal(canChooseDocumentVisibility(role, "everyone"), false, role);
    assert.equal(canChooseDocumentVisibility(role, "uploader_hierarchy"), true, role);
  }
});

test("every role can atomically approve a visible pending document with a durable audit", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "cat_member", "report_viewer"]) {
    const calls = [];
    const result = await approveDocument(context(role), handle, {
      async transaction(callback) {
        return callback(async (sql, parameters) => {
          calls.push({ sql, parameters });
          if (sql.includes("documents:approval-lock")) return [{
            id: documentId,
            visibility: "everyone",
            status: "under_review",
            created_by: userId,
            uploaded_by_role: "cat_member",
          }];
          if (sql.includes("documents:approve")) return [{ id: documentId }];
          if (sql.includes("synthetic:audit")) return [{ audit_written: true }];
          return [];
        });
      },
      async prepareAudit(event) {
        assert.equal(event.subjectId, documentId);
        assert.deepEqual(event.payload, { operation: "approve", previousStatus: "under_review", status: "approved" });
        return { sql: "/* synthetic:audit */ SELECT true", parameters: [] };
      },
    });
    assert.deepEqual(result, { approved: true, status: "approved" });
    assert.equal(calls.some(({ sql }) => sql.includes("approved_by = $3::uuid")), true);
    assert.equal(calls.at(-1).sql.includes("synthetic:audit"), true);
  }
});

test("approval rejects stale status before mutation or audit", async () => {
  let queries = 0;
  await assert.rejects(approveDocument(context(), handle, {
    async transaction(callback) {
      return callback(async () => {
        queries += 1;
        return [{
          id: documentId,
          visibility: "uploader_hierarchy",
          status: "approved",
          created_by: userId,
          uploaded_by_role: "cat_member",
        }];
      });
    },
  }), (error) => error instanceof DocumentApprovalError && error.code === "DOCUMENT_NOT_PENDING");
  assert.equal(queries, 1);
});

test("approval route is runtime-gated, same-origin, role-authorized, rate-limited, and no-store", () => {
  const route = readFileSync(new URL("../src/app/api/documents/[handle]/approve/route.ts", import.meta.url), "utf8");
  assert.match(route, /operationalRuntimeEnabled\(\)/);
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /requirePreviewUser\("approveDocuments"\)/);
  assert.match(route, /enforceWorkspaceRateLimit\(context, "mutation"\)/);
  assert.match(route, /approveDocument\(context, handle\)/);
  assert.match(route, /private, no-store/);
});
