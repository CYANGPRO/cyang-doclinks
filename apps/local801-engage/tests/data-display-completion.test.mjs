import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeImportRow, validateImportRows } from "../src/lib/imports.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("roster columns use Section Name as work location and retain work contact fields", () => {
  const headers = ["Employee ID", "Member ID", "First Name", "Last Name", "Work Email", "Work Phone", "Department", "Section Name", "Location Name"];
  const normalized = normalizeImportRow(headers, ["", "", "Avery", "Morgan", "avery@example.test", "651-555-0101", "Licensing", "Metro East", "Saint Paul"]);
  assert.equal(normalized.employee_identifier, null);
  assert.equal(normalized.member_identifier, null);
  assert.equal(normalized.work_email, "avery@example.test");
  assert.equal(normalized.work_phone, "651-555-0101");
  assert.equal(normalized.department, "Licensing");
  assert.equal(normalized.section, "Metro East");
  assert.equal(normalized.work_location, "Metro East");
});

test("blank source employee and member IDs do not reject a record with an authoritative email", () => {
  const result = validateImportRows({
    rows: [
      ["Employee ID", "Member ID", "First Name", "Last Name", "Work Email", "Section Name"],
      ["", "", "Avery", "Morgan", "avery@example.test", "Metro East"],
    ],
    sourceFilename: "synthetic-roster.csv",
    importingUser: "owner@example.test",
    importedAt: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(result.acceptedRows, 1);
  assert.equal(result.rejectedRows, 0);
  assert.equal(result.previewRows[0].identifier, "avery@example.test");
});

test("generated employee references are permanent and independent of source identifiers", () => {
  const migration = source("db/migrations/0032__employee_reference_and_work_phone.sql");
  assert.match(migration, /create sequence if not exists local801\.employee_reference_seq/i);
  assert.match(migration, /add column if not exists employee_reference bigint/i);
  assert.match(migration, /update local801\.people[\s\S]*set constraints all immediate[\s\S]*alter table local801\.people/i);
  assert.match(migration, /alter column employee_reference set not null/i);
  assert.match(migration, /people_employee_reference_uq/i);
  assert.match(migration, /direct_pii_field_set_version = 4[\s\S]*between 0 and 255/i);
  assert.match(migration, /work_phone/i);
});

test("Directory and New Hires expose the same compact employee summaries", () => {
  const directory = source("src/app/directory/page.tsx");
  const newHires = source("src/app/new-hires/page.tsx");
  const core = ["Person", "Hire Date", "Work", "Contact"];
  for (const label of core) {
    assert.equal(directory.includes(`\"${label}\"`), true, `Directory: ${label}`);
    assert.equal(newHires.includes(`\"${label}\"`), true, `New Hires: ${label}`);
  }
  assert.match(directory, /person\.firstName\} \{person\.lastName/);
  assert.match(directory, /mailto:\$\{person\.workEmail\}/);
  assert.match(newHires, /mailto:\$\{person\.workEmail\}/);
  assert.match(directory, /person\.classification/);
  assert.match(newHires, /person\.classification/);
  assert.match(newHires, /daysWithin/);
  for (const view of [directory, newHires]) {
    assert.doesNotMatch(view, /Employee ID|person\.employeeReference/);
    assert.doesNotMatch(view, /Job Status|person\.jobStatus/);
  }
});

test("Membership names the roster location breakdown as the office view", () => {
  const membership = source("src/app/membership/page.tsx");
  const groupPreference = source("src/lib/membership-group-preference.ts");
  assert.match(groupPreference, /key: "location", label: "Office", header: "Office \/ work location"/);
  assert.match(membership, /membership-breakdown-scroll/);
});

test("LCAT has organization-wide oversight while CAT remains assignment constrained", () => {
  const directory = source("src/lib/directory.ts");
  const outreach = source("src/lib/outreach.ts");
  const followups = source("src/lib/follow-ups.ts");
  const metrics = source("src/lib/metrics.ts");
  for (const service of [directory, outreach, followups]) {
    assert.match(service, /organizationWideRoles[\s\S]*"cat_lead"/);
  }
  assert.match(metrics, /context\.role !== "cat_member"/);
  assert.match(directory, /organizationWideRoles\.has\(role\) \? requestedScope : "assigned"/);
});

test("operational pages load live services instead of embedded synthetic records", () => {
  const operationalPages = [
    ["src/app/page.tsx", "getDashboardMetrics"],
    ["src/app/directory/page.tsx", "getDirectoryPage"],
    ["src/app/new-hires/page.tsx", "getNewHireQueue"],
    ["src/app/outreach/page.tsx", "getProtectedOutreachQueue"],
    ["src/app/follow-ups/page.tsx", "getFollowupQueue"],
    ["src/app/membership/page.tsx", "getMembershipSummary"],
    ["src/app/reports/page.tsx", "getMembershipReport"],
    ["src/app/documents/page.tsx", "getDocumentsPage"],
    ["src/app/campaigns/page.tsx", "getCampaignsPage"],
    ["src/app/cat-actions/page.tsx", "getCatActionsPage"],
    ["src/app/notifications/page.tsx", "getWorkNotifications"],
    ["src/app/team/page.tsx", "getTeamAccessPage"],
  ];
  for (const [path, service] of operationalPages) {
    const page = source(path);
    assert.equal(page.includes(service), true, `${path} must use ${service}`);
    assert.doesNotMatch(page, /@example\.test|const\s+(?:people|records|members)\s*=\s*\[/i, path);
  }
});

test("protected New Hires hydrates only the visible page", () => {
  const protectedRead = source("src/lib/pii-protected-new-hire-read.ts");
  assert.match(protectedRead, /requestedHandles/);
  assert.match(protectedRead, /jsonb_to_recordset\(\$2::text::jsonb\)/);
  assert.match(protectedRead, /JOIN requested ON requested\.handle = encode\(public\.digest/);
  assert.match(protectedRead, /pii-protected-new-hire-read:contact-details/);
});
