import assert from "node:assert/strict";
import test from "node:test";
import { can } from "../src/lib/access.ts";
import {
  DirectoryAccessError,
  getDirectoryPage,
  MAX_DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_SEARCH_LENGTH,
  normalizeDirectorySearch,
} from "../src/lib/directory.ts";
import { getMembershipBreakdowns, getMembershipSummary } from "../src/lib/membership.ts";
import {
  resolveWorkspaceContext,
  WorkspaceContextError,
} from "../src/lib/workspace-context.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const previewMembershipManagerId = "e2b9a5cf-0b83-490d-b373-a37a8de20b9f";
const previewLocalAdminId = "62af3638-663f-4fc2-94fb-358583ecd259";

function workspaceContext(role = "local_admin") {
  return {
    organizationId,
    organizationSlug: "local801-preview",
    userId,
    email: `${role}@example.test`,
    role,
  };
}

function directoryRow(overrides = {}) {
  return {
    person_id: "33333333-3333-4333-8333-333333333333",
    employee_reference: "100001",
    preferred_name: "Synthetic Avery",
    first_name: "Avery",
    last_name: "Morgan",
    membership_status: "member",
    department: "Health Licensing",
    section: "Regulation",
    classification: "Clerical",
    work_location: "Downtown",
    hire_date: "2026-08-01",
    job_status: "Permanent",
    work_email: "avery.morgan@example.test",
    home_email: "avery.home@example.test",
    work_phone: "651-555-0100",
    cell_phone: "651-555-0101",
    home_phone: "651-555-0102",
    total_count: "1",
    ...overrides,
  };
}

test("workspace context resolves a synthetic Preview role without querying sanitized plaintext email", async () => {
  let capturedSql = "";
  let capturedParameters = [];
  const context = await resolveWorkspaceContext(
    {
      id: "preview-membership_data_manager",
      organizationId: "local801-preview",
      databaseOrganizationId: null,
      email: "membership_manager@example.test",
      role: "membership_data_manager",
      authentication: "preview",
    },
    async (sql, parameters) => {
      capturedSql = sql;
      capturedParameters = parameters;
      return [{
        organization_id: organizationId,
        organization_slug: "local801-preview",
        user_id: previewMembershipManagerId,
        role: "membership_data_manager",
      }];
    },
  );

  assert.deepEqual(context, {
    organizationId,
    organizationSlug: "local801-preview",
    userId: previewMembershipManagerId,
    email: "membership_manager@example.test",
    role: "membership_data_manager",
  });
  assert.deepEqual(capturedParameters, [
    "local801-preview",
    "membership_data_manager",
    previewMembershipManagerId,
  ]);
  assert.match(capturedSql, /organization\.archived_at IS NULL/);
  assert.match(capturedSql, /workspace_user\.deactivated_at IS NULL/);
  assert.match(capturedSql, /workspace_user_roles/);
  assert.match(capturedSql, /workspace_roles/);
  assert.match(capturedSql, /workspace_role\.organization_id = organization\.id/);
  assert.doesNotMatch(capturedSql, /workspace_user\.email/);
});

test("workspace context binds a Production session to its exact already-validated user id", async () => {
  let queryCalls = 0;
  const context = await resolveWorkspaceContext({
    id: userId,
    organizationId: "local801",
    databaseOrganizationId: organizationId,
    email: "owner@example.test",
    role: "system_owner",
    authentication: "production",
  }, async () => {
    queryCalls += 1;
    return [];
  });
  assert.equal(context.userId, userId);
  assert.equal(context.email, "owner@example.test");
  assert.equal(context.organizationId, organizationId);
  assert.equal(queryCalls, 0);
});

test("workspace context fails closed when organization, user, or role assignment is missing", async () => {
  for (const rows of [[], [
    {
      organization_id: organizationId,
      organization_slug: "local801-preview",
      user_id: previewLocalAdminId,
      email: "local_admin@example.test",
      role: "cat_admin",
    },
  ]]) {
    await assert.rejects(
      resolveWorkspaceContext(
        {
          id: "preview-local_admin",
          organizationId: "local801-preview",
          databaseOrganizationId: null,
          email: "local_admin@example.test",
          role: "local_admin",
          authentication: "preview",
        },
        async () => rows,
      ),
      WorkspaceContextError,
    );
  }
});

test("workspace context ignores arbitrary client-style database identifiers", async () => {
  const untrustedIdentity = {
    organizationId: "local801-preview",
    id: "preview-local_admin",
    email: "local_admin@example.test",
    role: "local_admin",
    authentication: "preview",
    databaseOrganizationId: "attacker-organization",
    databaseUserId: "attacker-user",
  };
  let capturedParameters = [];

  await resolveWorkspaceContext(untrustedIdentity, async (_sql, parameters) => {
    capturedParameters = parameters;
    return [{
      organization_id: organizationId,
      organization_slug: "local801-preview",
      user_id: previewLocalAdminId,
      role: "local_admin",
    }];
  });

  assert.equal(capturedParameters.includes("attacker-organization"), false);
  assert.equal(capturedParameters.includes("attacker-user"), false);
});

test("membership summary uses the latest approved organization snapshot and excludes unknown", async () => {
  let capturedSql = "";
  let capturedParameters = [];
  const summary = await getMembershipSummary(workspaceContext("membership_data_manager"), async (sql, parameters) => {
    capturedSql = sql;
    capturedParameters = parameters;
    return [{
      snapshot_date: "2026-08-01",
      represented: "7",
      members: "5",
      nonmembers: "2",
      additions_this_month: "3",
      drops_this_month: "2",
      net_change: "1",
    }];
  });

  assert.deepEqual(summary, {
    represented: 7,
    members: 5,
    nonmembers: 2,
    additionsThisMonth: 3,
    dropsThisMonth: 2,
    netChange: 1,
    snapshotDate: "2026-08-01",
    sourceLabel: "Approved snapshot · 2026-08-01",
    source: "database",
  });
  assert.deepEqual(capturedParameters, [organizationId]);
  assert.match(capturedSql, /WHERE organization_id = \$1/);
  assert.match(capturedSql, /status = 'approved'/);
  assert.match(capturedSql, /snapshot_date DESC[\s\S]*approved_at DESC NULLS LAST[\s\S]*created_at DESC/);
  assert.match(capturedSql, /membership_status IN \('member', 'nonmember'\)/);
  assert.match(capturedSql, /event\.organization_id = \$1/);
  assert.match(capturedSql, /event_type = 'addition'/);
  assert.match(capturedSql, /event_type = 'drop'/);
});

test("membership summary returns a safe unavailable state without an approved snapshot", async () => {
  const summary = await getMembershipSummary(workspaceContext(), async () => []);
  assert.equal(summary.source, "unavailable");
  assert.equal(summary.represented, "—");
  assert.equal(summary.snapshotDate, null);
});

test("membership summary returns a safe unavailable state on database failure", async () => {
  const summary = await getMembershipSummary(workspaceContext(), async () => {
    throw new Error("synthetic database failure");
  });
  assert.equal(summary.source, "unavailable");
});

test("membership office breakdown returns the complete approved-snapshot office list", async () => {
  let capturedSql = "";
  const rows = await getMembershipBreakdowns(workspaceContext(), async (sql) => {
    capturedSql = sql;
    return [
      { dimension: "location", label: "Central Office", represented: "12", members: "9" },
      { dimension: "location", label: "North Office", represented: "8", members: "8" },
    ];
  });
  assert.deepEqual(rows.map((row) => row.label), ["Central Office", "North Office"]);
  assert.match(capturedSql, /person\.work_location/);
  assert.match(capturedSql, /btrim\(work_location\)/);
  assert.doesNotMatch(capturedSql, /LIMIT 150/);
});

test("membership services deny roles without manageImports before SQL", async () => {
  for (const service of [getMembershipSummary, getMembershipBreakdowns]) {
    let calls = 0;
    await assert.rejects(service(workspaceContext("cat_admin"), async () => {
      calls += 1;
      return [];
    }), /not authorized/);
    assert.equal(calls, 0);
  }
});

test("Directory permission includes membership managers and excludes report viewers", () => {
  assert.equal(can("membership_data_manager", "viewDirectory"), true);
  assert.equal(can("report_viewer", "viewDirectory"), false);
});

for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "cat_member"]) {
  test(`${role} can perform an organization-wide Directory search`, async () => {
    let capturedSql = "";
    let capturedParameters = [];
    const result = await getDirectoryPage(
      workspaceContext(role),
      { scope: "authorized" },
      async (sql, parameters) => {
        capturedSql = sql;
        capturedParameters = parameters;
        return [directoryRow()];
      },
    );

    assert.equal(result.effectiveScope, "authorized");
    assert.match(capturedSql, /person\.organization_id = \$1/);
    assert.match(capturedSql, /\$12::boolean OR EXISTS/);
    assert.match(capturedSql, /assignment\.primary_user_id = \$2::uuid/);
    assert.match(capturedSql, /\$4::text IS NULL/);
    assert.equal(capturedParameters[11], true);
  });
}

test("Directory query returns active people and the approved contact columns with stable ordering", async () => {
  let capturedSql = "";
  const result = await getDirectoryPage(workspaceContext("local_admin"), {}, async (sql) => {
    capturedSql = sql;
    return [directoryRow()];
  });

  assert.equal(result.people[0].workEmail, "avery.morgan@example.test");
  assert.equal(result.people[0].workPhone, "651-555-0100");
  assert.equal(result.people[0].employeeReference, "L801-100001");
  assert.equal(result.people[0].membershipStatus, "member");
  assert.equal(result.people[0].jobStatus, "Permanent");
  assert.equal(result.people[0].homeEmail, "avery.home@example.test");
  assert.equal(result.people[0].cellPhone, "651-555-0101");
  assert.match(capturedSql, /person\.archived_at IS NULL/);
  assert.match(capturedSql, /contact\.contact_type = 'work_email'/);
  assert.match(capturedSql, /contact\.is_primary = true/);
  assert.match(capturedSql, /contact\.archived_at IS NULL/);
  assert.match(capturedSql, /contact\.visibility = 'authorized_directory'/);
  assert.match(capturedSql, /ORDER BY last_name ASC, first_name ASC, person_id ASC/);
  assert.match(capturedSql, /contact_type = 'phone'/);
  assert.doesNotMatch(capturedSql, /mailing_address|note_hash|identifier_value/);
});

test("Directory search is parameterized and SQL wildcards are escaped", async () => {
  const search = "Avery%_\\Morgan";
  let capturedSql = "";
  let capturedParameters = [];
  await getDirectoryPage(workspaceContext("local_admin"), { term: search }, async (sql, parameters) => {
    capturedSql = sql;
    capturedParameters = parameters;
    return [directoryRow()];
  });

  assert.equal(capturedSql.includes(search), false);
  assert.equal(capturedParameters[2], "%Avery\\%\\_\\\\Morgan%");
  assert.match(capturedSql, /ILIKE \$3/);
});

test("Directory classification filters match the complete classification", async () => {
  let capturedSql = "";
  let capturedParameters = [];
  await getDirectoryPage(
    workspaceContext("local_admin"),
    { classification: "  accounting   officer  " },
    async (sql, parameters) => {
      capturedSql = sql;
      capturedParameters = parameters;
      return [directoryRow()];
    },
  );

  assert.match(capturedSql, /lower\(btrim\(person\.classification\)\) = lower\(btrim\(\$9::text\)\)/);
  assert.doesNotMatch(capturedSql, /person\.classification ILIKE \$9/);
  assert.equal(capturedParameters[8], "accounting officer");
  assert.match(capturedSql, /person\.classification ILIKE \$3/);
});

test("Directory pagination and search inputs are normalized to hard bounds", () => {
  const normalized = normalizeDirectorySearch({
    term: `  ${"x".repeat(150)}  `,
    pageSize: "9999",
    scope: "not-a-scope",
  });
  assert.equal(normalized.term.length, MAX_DIRECTORY_SEARCH_LENGTH);
  assert.equal(normalized.pageSize, MAX_DIRECTORY_PAGE_SIZE);
  assert.equal(normalized.requestedScope, "assigned");

  const invalid = normalizeDirectorySearch({ pageSize: "NaN" });
  assert.equal(invalid.pageSize, 25);
});

test("Directory keyset pagination is bounded and deterministic", async () => {
  const result = await getDirectoryPage(
    workspaceContext("local_admin"),
    { pageSize: "25" },
    async (_sql, parameters) => {
      assert.equal(parameters[10], 26);
      return Array.from({ length: 26 }, (_, index) => directoryRow({
        person_id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
        first_name: `Avery${String(index).padStart(2, "0")}`,
        total_count: "45",
      }));
    },
  );
  assert.equal(result.people.length, 25);
  assert.equal(result.previousCursor, null);
  assert.equal(typeof result.nextCursor, "string");
});

test("Directory denies roles without viewDirectory before issuing a query", async () => {
  let queryCalls = 0;
  await assert.rejects(
    getDirectoryPage(workspaceContext("report_viewer"), {}, async () => {
      queryCalls += 1;
      return [];
    }),
    DirectoryAccessError,
  );
  assert.equal(queryCalls, 0);
});
