import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getNewHireQueue, normalizeNewHireSearch, __testing } from "../src/lib/new-hires.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const uuid = (index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
const context = (role = "membership_data_manager") => ({ organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role });

function row(index, overrides = {}) {
  return {
    person_id: uuid(index),
    employee_reference: String(100000 + index),
    preferred_name: index === 1 ? "Synthetic Casey" : null,
    first_name: index === 1 ? "Casey" : `Person${index}`,
    last_name: index === 1 ? "Woods" : "Hire",
    membership_status: index === 1 ? "member" : "nonmember",
    department: "Customer Support",
    classification: "Clerical",
    work_location: "East Office",
    work_email: `person${index}@example.test`,
    work_phone: `651-555-${String(index).padStart(4, "0")}`,
    hire_date: `2026-08-${String(Math.min(index, 28)).padStart(2, "0")}`,
    days_since_hire: String(index),
    open_assignment_count: index === 1 ? "1" : "0",
    primary_organizers: index === 1 ? "Synthetic CAT Lead" : null,
    backup_organizers: index === 1 ? "Synthetic CAT Administrator" : null,
    latest_engagement_at: index === 1 ? "2026-08-10T15:00:00.000Z" : null,
    latest_outcome: index === 1 ? "contacted" : null,
    open_followup_count: index === 1 ? "1" : "0",
    overdue_followup_count: index === 1 ? "1" : "0",
    next_followup_at: index === 1 ? "2026-08-11T15:00:00.000Z" : null,
    total_count: "26",
    never_engaged_count: "12",
    unassigned_count: "8",
    followup_open_count: "5",
    member_count: "14",
    ...overrides,
  };
}

test("new-hire search normalization bounds filters and ignores invalid cursor data", () => {
  const normalized = normalizeNewHireSearch({
    term: "  Synthetic   Casey  ",
    assignment: "unassigned",
    contact: "follow-up-open",
    membershipStatus: "member",
    days: "14",
    pageSize: "999",
    cursor: "not-a-cursor",
  });
  assert.deepEqual(normalized, {
    term: "Synthetic Casey",
    assignment: "unassigned",
    contact: "follow-up-open",
    membershipStatus: "member",
    daysWithin: 14,
    pageSize: 25,
    cursor: null,
  });
});

test("new-hire queue is organization scoped, Local 0801 filtered, read-only, and keyset paginated", async () => {
  const rows = Array.from({ length: 26 }, (_, index) => row(index + 1));
  let sqlText = "";
  let parameters = [];
  const result = await getNewHireQueue(context(), {
    term: "Casey%_",
    assignment: "assigned",
    contact: "all",
    membershipStatus: "member",
    days: "60",
    pageSize: "25",
  }, async (sql, values) => {
    sqlText = sql;
    parameters = values;
    return rows;
  });

  assert.equal(result.people.length, 25);
  assert.equal(result.total, 26);
  assert.deepEqual(result.summary, { neverEngaged: 12, unassigned: 8, openFollowups: 5, members: 14 });
  assert.equal(result.people[0].displayName, "Casey Woods");
  assert.equal(result.people[0].employeeReference, "L801-100001");
  assert.equal(result.people[0].workPhone, "651-555-0001");
  assert.equal(result.people[0].contactState, "overdue_followup");
  assert.equal(result.people[0].assigned, true);
  assert.equal(typeof result.people[0].handle, "string");
  assert.equal(result.people[0].handle.length, 64);
  assert.equal(typeof result.nextCursor, "string");
  assert.deepEqual(__testing.decodeCursor(result.nextCursor), {
    hireDate: rows[24].hire_date,
    lastName: rows[24].last_name,
    firstName: rows[24].first_name,
    id: rows[24].person_id,
  });

  assert.equal(parameters[0], organizationId);
  assert.equal(parameters[1], "%Casey\\%\\_%");
  assert.equal(parameters[2], "member");
  assert.equal(parameters[3], "assigned");
  assert.equal(parameters[4], "all");
  assert.equal(parameters[5], 60);
  assert.equal(parameters[10], 26);
  assert.match(sqlText, /employment\.organization_id = \$1::uuid/);
  assert.match(sqlText, /employment\.event_type = 'hire'/);
  assert.match(sqlText, /person\.organization_id = \$1::uuid/);
  assert.match(sqlText, /person\.archived_at IS NULL/);
  assert.match(sqlText, /person\.local_number = '0801'/);
  assert.match(sqlText, /method\.visibility = 'authorized_directory'/);
  assert.match(sqlText, /\(last_name, first_name, person_id\) > \(\$8::text, \$9::text, \$10::uuid\)/);
  assert.match(sqlText, /LIMIT \$11::integer/);
  assert.doesNotMatch(sqlText, /OFFSET/i);
  assert.doesNotMatch(sqlText, /INSERT INTO|UPDATE local801|DELETE FROM/i);
});

test("new-hire queue strips internal ids and reports safe contact states", async () => {
  const result = await getNewHireQueue(context(), {}, async () => [
    row(1, { latest_engagement_at: null, open_followup_count: 0, overdue_followup_count: 0 }),
    row(2, { latest_engagement_at: "2026-08-10T15:00:00.000Z", open_followup_count: 1, overdue_followup_count: 0 }),
    row(3, { latest_engagement_at: "2026-08-10T15:00:00.000Z", open_followup_count: 0, overdue_followup_count: 0 }),
  ]);
  assert.deepEqual(result.people.map((person) => person.contactState), ["never_engaged", "followup_open", "engaged"]);
  assert.equal("person_id" in result.people[0], false);
  assert.equal("first_name" in result.people[0], false);
  assert.equal("last_name" in result.people[0], false);
});

test("new-hire queue allows assignment roles and denies only CAT Member and Report Viewer", async () => {
  for (const role of ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"]) {
    let calls = 0;
    await getNewHireQueue(context(role), {}, async () => { calls += 1; return []; });
    assert.equal(calls, 1, `${role} should be allowed to load New Hires`);
  }

  for (const role of ["cat_member", "report_viewer"]) {
    let calls = 0;
    await assert.rejects(
      getNewHireQueue(context(role), {}, async () => { calls += 1; return []; }),
      /forbidden/i,
    );
    assert.equal(calls, 0);
  }
});

test("new-hire page uses the database-backed queue and person-name outreach handoff", async () => {
  const page = await readFile(new URL("../src/app/new-hires/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getNewHireQueue\(context/);
  assert.match(page, /resolveWorkspaceContext\(user\)/);
  assert.match(page, /permission="assignNewHires"/);
  assert.match(page, /\/outreach\/\$\{person\.handle\}/);
  assert.match(page, /No current organizer assignment/);
  assert.match(page, /<Link href=\{`\/outreach\/\$\{person\.handle\}`\}>\{person\.displayName\}<\/Link>/);
  assert.doesNotMatch(page, />Outreach record/);
  assert.doesNotMatch(page, /Backend wiring pending/);
  assert.doesNotMatch(page, /INSERT INTO|UPDATE local801|DELETE FROM/i);
});
