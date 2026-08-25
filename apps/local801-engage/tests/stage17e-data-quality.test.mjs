import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DATA_QUALITY_ISSUES, getDataQualityQueue, getDataQualitySummary, normalizeDataQualitySearch } from "../src/lib/data-quality.ts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const context = (role = "local_admin") => ({
  organizationId,
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: `${role}@example.test`,
  role,
});

test("Stage 17E issue filters are allowlisted and page sizes are bounded", () => {
  assert.deepEqual(normalizeDataQualitySearch({ issue: "missing_work_email", pageSize: "50" }), { issue: "missing_work_email", pageSize: 50 });
  assert.deepEqual(normalizeDataQualitySearch({ issue: "made-up-score", pageSize: "5000" }), { issue: "all", pageSize: 25 });
  assert.deepEqual(DATA_QUALITY_ISSUES.map((item) => item.code), [
    "missing_identifier",
    "missing_work_email",
    "missing_department",
    "missing_classification",
    "missing_work_location",
    "unknown_membership",
    "not_in_latest_roster",
  ]);
});

test("aggregate data-quality summary is organization scoped, explicit, and contains no direct PII values", async () => {
  const calls = [];
  const summary = await getDataQualitySummary(context("report_viewer"), async (sql, parameters) => {
    calls.push({ sql, parameters });
    return [{
      flagged_people: "7",
      missing_identifier: "1",
      missing_work_email: "2",
      missing_department: "3",
      missing_classification: "4",
      missing_work_location: "5",
      unknown_membership: "6",
      not_in_latest_roster: "7",
      latest_roster_available: true,
    }];
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, [organizationId]);
  assert.match(calls[0].sql, /person\.organization_id = \$1::uuid/);
  assert.match(calls[0].sql, /employee_reference/);
  assert.match(calls[0].sql, /person_contact_methods/);
  assert.match(calls[0].sql, /membership_snapshot_rows/);
  assert.doesNotMatch(calls[0].sql, /identifier_value|contact_value|first_name|last_name|preferred_name/i);
  assert.deepEqual(summary, {
    flaggedPeople: 7,
    missingIdentifier: 1,
    missingWorkEmail: 2,
    missingDepartment: 3,
    missingClassification: 4,
    missingWorkLocation: 5,
    unknownMembership: 6,
    notInLatestRoster: 7,
    latestRosterAvailable: true,
  });
});

test("person-level data-quality queue denies non-import roles before SQL or protected PII work", async () => {
  let calls = 0;
  await assert.rejects(getDataQualityQueue(context("cat_lead"), {}, async () => { calls += 1; return []; }), /Forbidden/);
  assert.equal(calls, 0);
});

test("action queue uses protected companions and never reads direct person/contact/identifier PII", () => {
  const source = readFileSync(new URL("../src/lib/data-quality.ts", import.meta.url), "utf8");
  assert.match(source, /JOIN local801\.person_pii protected/);
  assert.match(source, /decryptPiiField/);
  assert.match(source, /outreachHandle\(context\.organizationId, row\.person_id\)/);
  assert.match(source, /ORDER BY facts\.person_id/);
  assert.match(source, /sealPiiCursor/);
  assert.doesNotMatch(source, /SELECT[^;]*(?:person\.first_name|person\.last_name|contact\.contact_value|identifier\.identifier_value)/is);
  assert.doesNotMatch(source, /levenshtein|similarity\(|fuzzy|propensity|likelihood score/i);
});

test("latest-roster discrepancy stays review-only and never becomes an automatic lifecycle decision", () => {
  const source = readFileSync(new URL("../src/lib/data-quality.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/membership/data-quality/page.tsx", import.meta.url), "utf8");
  const corrections = readFileSync(new URL("../src/lib/data-quality-corrections.ts", import.meta.url), "utf8");
  assert.match(source, /This does not infer a drop, separation, or archive/);
  assert.match(page, /not treated as a drop, separation, archive, or membership change/);
  assert.match(page, /correct the roster through Data Imports/);
  assert.doesNotMatch(corrections, /employment_events[\s\S]*separation|membership_events[\s\S]*'drop'|archived_at\s*=\s*now\(\)/i);
});

test("data-quality action queue remains manageImports-only while Stage 17J adds controlled direct fixes", () => {
  const page = readFileSync(new URL("../src/app/membership/data-quality/page.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/app/api/data-quality/[handle]/route.ts", import.meta.url), "utf8");
  const correction = readFileSync(new URL("../src/lib/data-quality-corrections.ts", import.meta.url), "utf8");
  const membership = readFileSync(new URL("../src/app/membership/page.tsx", import.meta.url), "utf8");
  assert.match(page, /ProtectedPage permission="manageImports"/);
  assert.match(page, /can\(user\.role, "manageImports"\)/);
  assert.match(page, /DataQualityFixControls/);
  assert.match(page, /href="\/imports"/);
  assert.match(api, /requirePreviewUser\("manageImports"\)/);
  assert.match(api, /hasExactSameOrigin\(request\)/);
  assert.match(correction, /can\(context\.role, "manageImports"\)/);
  assert.match(correction, /prepareAtomicAuditStatement/);
  assert.match(membership, /href="\/membership\/data-quality"/);
});

test("legacy Reports data-quality navigation redirects to aggregate protected-safe semantics", () => {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const report = readFileSync(new URL("../src/app/reports/data-quality/page.tsx", import.meta.url), "utf8");
  assert.match(config, /key: "view", value: "data-quality"/);
  assert.match(config, /destination: "\/reports\/data-quality"/);
  assert.match(report, /aggregate, protected-safe indicators/i);
  assert.match(report, /does not expose names, emails, identifiers, or person-level rows/);
  assert.match(report, /getDataQualitySummary/);
  assert.match(report, /recordReportAccess\(context, "data-quality"\)/);
  assert.match(report, /enforceAuthenticatedRateLimit/);
});

test("Stage 17E historical implementation remains migration-free and rejects fuzzy duplicate scoring", () => {
  const roadmap = readFileSync(new URL("../docs/STAGE17_ADVANCED_WORKFLOWS.md", import.meta.url), "utf8");
  assert.match(roadmap, /### 17E — Operational data quality — (?:implementation wave|complete)/);
  assert.match(roadmap, /Schema changes: \*\*none\*\*/);
  assert.match(roadmap, /does not introduce fuzzy\/name matching, duplicate likelihood scores/i);
  assert.match(roadmap, /queue is read-only/i);
});
