import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { archiveEmployeeRecord } from "../src/lib/employee-record-management.ts";
import { rankPossibleEmployeeMatches, resolveImportDataIssue } from "../src/lib/import-data-issues.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const batchId = "33333333-3333-4333-8333-333333333333";
const rowId = "44444444-4444-4444-8444-444444444444";
const personId = "55555555-5555-4555-8555-555555555555";
const personHandle = "a".repeat(64);
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId,
  email: `${role}@example.test`,
  role,
});

test("possible employee matches rank exact full names first and expose explainable evidence", () => {
  const ranked = rankPossibleEmployeeMatches({
    firstName: "Emma",
    lastName: "Fletcher",
    department: "Transportation",
    classification: "Program Specialist",
  }, [{
    personId,
    firstName: "Emma",
    lastName: "Fletcher",
    department: "Transportation",
    classification: "Program Specialist",
  }, {
    personId: "66666666-6666-4666-8666-666666666666",
    firstName: "Emmy",
    lastName: "Fletcher",
    department: "Another department",
  }, {
    personId: "77777777-7777-4777-8777-777777777777",
    firstName: "Completely",
    lastName: "Different",
  }]);
  assert.equal(ranked[0].personId, personId);
  assert.equal(ranked[0].score, 100);
  assert.deepEqual(ranked[0].reasons, ["Exact full-name match", "Same department", "Same classification"]);
  assert.equal(ranked.some((item) => item.personId.endsWith("777777777777")), false);
});

test("exact active work-email matches cannot be overridden by a manual data-issue decision", async () => {
  let calls = 0;
  await assert.rejects(resolveImportDataIssue(context(), {
    batchId,
    rowId,
    action: "link_existing",
    personHandle,
  }, {
    query: async () => {
      calls += 1;
      return [{ category: "needs_attention", work_email_identity_matches: true, automatic_person_count: 1, automatic_person_id: personId, direct_pii_presence_mask: 11 }];
    },
    runTransaction: async () => assert.fail("work-email lock must fail before mutation"),
  }), (error) => error?.code === "WORK_EMAIL_MATCH_LOCKED" && error?.status === 409);
  assert.equal(calls, 1);
});

test("manual attachment is organization-scoped, audited, and invalidates stale batch approvals", async () => {
  const statements = [];
  let call = 0;
  await resolveImportDataIssue(context(), { batchId, rowId, action: "link_existing", personHandle }, {
    query: async () => {
      call += 1;
      if (call === 1) return [{ category: "proposed_new", work_email_identity_matches: false, automatic_person_count: 0, automatic_person_id: null, direct_pii_presence_mask: 11 }];
      if (call === 2) return [{ id: personId }];
      return [];
    },
    runTransaction: async (items) => statements.push(...items),
  });
  assert.equal(statements.length, 4);
  assert.match(statements[0].sql, /INSERT INTO local801\.import_row_resolutions/);
  assert.equal(statements[0].parameters[4], "confirm_existing");
  assert.match(statements[1].sql, /DELETE FROM local801\.import_batch_review_decisions/);
  assert.match(statements[2].sql, /state = 'invalidated'/);
  assert.match(statements[3].sql, /INSERT INTO local801\.audit_events/);
});

test("employee deletion is Local Administrator or System Owner only and is a recoverable archive", async () => {
  let deniedCalls = 0;
  await assert.rejects(archiveEmployeeRecord(context("cat_admin"), personHandle, {
    query: async () => { deniedCalls += 1; return []; },
  }), /Local Administrators and System Owners/);
  assert.equal(deniedCalls, 0);

  const statements = [];
  let call = 0;
  const result = await archiveEmployeeRecord(context(), personHandle, {
    query: async () => {
      call += 1;
      if (call === 1) return [{ id: personId }];
      return [];
    },
    runTransaction: async (items) => statements.push(...items),
  });
  assert.deepEqual(result, { archived: true });
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /archived_at = now\(\)/);
  assert.match(statements[0].sql, /role\.code IN \('system_owner','local_admin'\)/);
  assert.doesNotMatch(statements[0].sql, /DELETE FROM local801\.people/i);
  assert.equal(statements[1].parameters[2], "record.archive");
});

test("protected classification prioritizes exact work email over manual decisions and ignores excluded rows", () => {
  const source = readFileSync(new URL("../src/lib/pii-protected-import-classification.ts", import.meta.url), "utf8");
  assert.match(source, /work_email_matches AS/);
  assert.match(source, /WHEN work_email\.person_count = 1 THEN work_email\.person_id/);
  assert.match(source, /WHEN row\.resolution_type = 'confirm_existing' THEN row\.resolution_person_id/);
  assert.match(source, /row\.state <> 'excluded'/);
  assert.match(source, /import_row_resolutions resolution/);
});

test("data-issue and Directory controls use guarded APIs and explicit confirmations", () => {
  const issueRoute = readFileSync(new URL("../src/app/api/data-issues/imports/[batchId]/rows/[rowId]/route.ts", import.meta.url), "utf8");
  const directoryRoute = readFileSync(new URL("../src/app/api/directory/[handle]/route.ts", import.meta.url), "utf8");
  const issueControls = readFileSync(new URL("../src/components/ImportDataIssueControls.tsx", import.meta.url), "utf8");
  const deleteControls = readFileSync(new URL("../src/components/EmployeeDeleteControl.tsx", import.meta.url), "utf8");
  assert.match(issueRoute, /authorizeWorkspaceMutation\(request, "manageImports"\)/);
  assert.match(directoryRoute, /authorizeWorkspaceMutation\(request, "deleteEmployees"\)/);
  assert.match(issueControls, /CAT never attaches a possible match automatically/);
  assert.match(issueControls, /Remove from import/);
  assert.match(deleteControls, /confirmation !== "REMOVE"/);
  assert.match(deleteControls, /recoverable archive/i);
});
