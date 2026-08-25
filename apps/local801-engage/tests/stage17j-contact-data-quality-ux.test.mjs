import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyDataQualityCorrections, DataQualityCorrectionError, normalizeDataQualityCorrectionInput } from "../src/lib/data-quality-corrections.ts";
import { getPiiKeyConfiguration } from "../src/lib/pii-protection.ts";

const handle = "a".repeat(64);
const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const personId = "33333333-3333-4333-8333-333333333333";
const key = (byte) => Buffer.alloc(32, byte).toString("base64");
const environment = {
  LOCAL801_DATABASE_PII_PROTECTION_ENABLED: "1",
  LOCAL801_PII_DUAL_WRITE_ENABLED: "0",
  LOCAL801_PII_BACKFILL_ENABLED: "0",
  LOCAL801_PII_ENCRYPTION_MASTER_KEYS: JSON.stringify({ v1: key(1) }),
  LOCAL801_PII_ACTIVE_ENCRYPTION_KEY_VERSION: "v1",
  LOCAL801_PII_BLIND_INDEX_KEYS: JSON.stringify({ v1: key(2) }),
  LOCAL801_PII_ACTIVE_BLIND_INDEX_KEY_VERSION: "v1",
};
const keyConfig = getPiiKeyConfiguration(environment);
const context = (role = "membership_data_manager") => ({
  organizationId, organizationSlug: "local801-preview", userId, email: `${role}@example.test`, role,
});

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("direct Data Quality correction input is bounded and allowlisted", () => {
  assert.deepEqual(normalizeDataQualityCorrectionInput({
    personHandle: handle,
    identifierType: "employee_identifier",
    identifierValue: "  12345  ",
    workEmail: " Person@Example.Test ",
    department: "  Administrative   Services ",
    membershipStatus: "member",
  }), {
    personHandle: handle,
    identifierType: "employee_identifier",
    identifierValue: "12345",
    workEmail: "person@example.test",
    department: "Administrative Services",
    classification: null,
    workLocation: null,
    membershipStatus: "member",
    fields: ["identifier", "workEmail", "department", "membershipStatus"],
  });
  assert.throws(() => normalizeDataQualityCorrectionInput({ personHandle: handle, membershipStatus: "maybe" }), /Member or Nonmember/);
  assert.throws(() => normalizeDataQualityCorrectionInput({ personHandle: handle, identifierType: "employee_identifier" }), /identifier type and enter the identifier value/i);
  assert.throws(() => normalizeDataQualityCorrectionInput({ personHandle: handle }), /at least one correction/i);
});

test("direct Data Quality corrections preserve protected PII and audit boundaries", () => {
  const correction = source("src/lib/data-quality-corrections.ts");
  assert.match(correction, /can\(context\.role, "manageImports"\)/);
  assert.match(correction, /assertPiiProtectedReadState/);
  assert.match(correction, /data-quality-correction:protected-write-gate/);
  assert.match(correction, /buildSyntheticPiiBackfillPlan/);
  assert.match(correction, /person_identifier_pii/);
  assert.match(correction, /person_contact_method_pii/);
  assert.match(correction, /pii_exact_indexes/);
  assert.match(correction, /pii-protected-execution:legacy-placeholder/);
  assert.match(correction, /IDENTIFIER_CONFLICT/);
  assert.match(correction, /WORK_EMAIL_CONFLICT/);
  assert.match(correction, /prepareAtomicAuditStatement/);
  assert.match(correction, /workflow: "direct_data_quality_correction"/);
  assert.match(correction, /fields: correction\.fields/);
  assert.doesNotMatch(correction, /payload:\s*\{[^}]*identifierValue/i);
  assert.doesNotMatch(correction, /payload:\s*\{[^}]*workEmail/i);
});

test("direct Data Quality corrections revalidate every requested issue under the person lock", async () => {
  let transactionStatements = null;
  await assert.rejects(
    applyDataQualityCorrections(context(), {
      personHandle: handle,
      department: "Operations",
      workLocation: "Saint Paul",
    }, {
      env: environment,
      keyConfig,
      query: async (sql) => {
        if (sql.includes("pii-protected-read:acceptance-state")) return [{
          write_mode: "protected", backfill_state: "complete", backfill_completed_at: new Date(),
          protected_read_enabled_at: new Date(), protected_write_enabled_at: new Date(), verified_at: new Date(),
        }];
        if (sql.includes("data-quality-correction:resolve-person")) return [{
          id: personId, membership_status: "unknown", department: null, classification: null,
          work_location: null, missing_identifier: true, missing_work_email: true,
        }];
        if (sql.includes("SELECT event_hash FROM local801.audit_events")) return [];
        throw new Error(`Unexpected query: ${sql}`);
      },
      runTransaction: async (statements) => {
        transactionStatements = statements;
        throw { code: "P1702" };
      },
    }),
    (error) => error instanceof DataQualityCorrectionError && error.code === "ISSUE_RESOLVED" && error.status === 409,
  );

  assert.ok(transactionStatements);
  assert.match(transactionStatements[1].sql, /data-quality-correction:lock-and-revalidate/);
  assert.match(transactionStatements[1].sql, /lock_data_quality_correction_target/);
  assert.deepEqual(transactionStatements[1].parameters, [organizationId, personId, false, false, true, false, true, false]);
  assert.match(transactionStatements.at(-1).sql, /INSERT INTO local801\.audit_events/);
});

test("Data Quality denies unauthorized correction work before SQL", async () => {
  let calls = 0;
  await assert.rejects(
    applyDataQualityCorrections(context("cat_admin"), { personHandle: handle, department: "Operations" }, {
      query: async () => { calls += 1; return []; },
      runTransaction: async () => { calls += 1; },
    }),
    (error) => error instanceof DataQualityCorrectionError && error.code === "FORBIDDEN" && error.status === 403,
  );
  assert.equal(calls, 0);
});

test("Data Quality mutation API is bounded, same-origin, launch-gated, rate-limited, and manageImports-only", () => {
  const api = source("src/app/api/data-quality/[handle]/route.ts");
  assert.match(api, /MAX_JSON_BYTES = 4_096/);
  assert.match(api, /mediaType !== "application\/json"/);
  assert.match(api, /hasExactSameOrigin\(request\)/);
  assert.match(api, /requirePreviewUser\("manageImports"\)/);
  assert.match(api, /operationalRuntimeEnabled\(\)/);
  assert.match(api, /enforceWorkspaceRateLimit\(context, "mutation"\)/);
  assert.match(api, /Cache-Control/);
  assert.match(api, /applyDataQualityCorrections/);
  assert.match(api, /\{ \.\.\.body, personHandle: handle \}/);
  assert.doesNotMatch(api, /\{ personHandle: handle, \.\.\.body \}/);
});

test("Data Quality is an actionable workspace without making roster absence an automatic correction", () => {
  const page = source("src/app/membership/data-quality/page.tsx");
  const controls = source("src/components/DataQualityFixControls.tsx");
  assert.match(page, /title="Data quality"/);
  assert.match(page, /Fix individual records here/);
  assert.match(page, /Protected PII/);
  assert.match(page, /DataQualityFixControls/);
  assert.match(page, /data-quality-summary-card/);
  assert.match(page, /People per page/);
  assert.match(page, /data-quality-desktop-results/);
  assert.match(page, /data-quality-mobile-results/);
  assert.match(page, /does not assume the person separated, dropped membership, or should be archived/);
  assert.match(controls, /missing_identifier/);
  assert.match(controls, /missing_work_email/);
  assert.match(controls, /missing_department/);
  assert.match(controls, /missing_classification/);
  assert.match(controls, /missing_work_location/);
  assert.match(controls, /unknown_membership/);
  assert.match(controls, /aria-controls=\{panelId\}/);
  assert.match(controls, /Fix \$\{displayName\} now/);
  assert.match(controls, /Enter at least one missing value before saving/);
  assert.match(controls, /scrollIntoView/);
  assert.doesNotMatch(controls, /not_in_latest_roster/);
});

test("Contact Updates compares current and proposed protected values and confirms approval", () => {
  const page = source("src/app/membership/contact-corrections/page.tsx");
  const service = source("src/lib/contact-corrections.ts");
  const controls = source("src/components/ContactCorrectionReviewControls.tsx");
  assert.match(page, /title="Contact updates"/);
  assert.match(page, /Current value/);
  assert.match(page, /Proposed value/);
  assert.match(page, /Not on file/);
  assert.match(page, /contact-updates-desktop/);
  assert.match(page, /contact-updates-mobile/);
  assert.match(page, /revision=\{item\.revision\}/);
  assert.match(service, /LEFT JOIN LATERAL/);
  assert.match(service, /current_contact_value_encrypted_payload/);
  assert.match(service, /contact-correction-revision:v1:/);
  assert.match(service, /current_contact\.current_contact_version/);
  assert.match(service, /expectedRevision/);
  assert.match(service, /entity: "person-contact"/);
  assert.match(service, /rows\.slice\(0, REVIEW_LIMIT\)/);
  assert.doesNotMatch(service, /QUEUE_BOUND/);
  assert.match(page, /More updates are waiting/);
  assert.match(controls, /window\.confirm/);
  assert.match(controls, /JSON\.stringify\(\{ decision, revision \}\)/);
  assert.match(controls, /: "Approve"/);
  assert.match(controls, /: "Reject"/);
});

test("Stage 17 stylesheet owns responsive Contact Updates and Data Quality layouts", () => {
  const css = source("src/app/stage17.css");
  assert.match(css, /\.contact-updates-mobile\s*,[\s\S]*?\.data-quality-mobile-results\s*\{[\s\S]*?display:\s*none/);
  const mobile = css.match(/@media \(max-width: 640px\)[\s\S]*$/)?.[0] ?? "";
  assert.match(mobile, /\.contact-updates-desktop[\s\S]*display:\s*none/);
  assert.match(mobile, /\.contact-updates-mobile[\s\S]*display:\s*block/);
  assert.match(mobile, /\.data-quality-desktop-results[\s\S]*display:\s*none/);
  assert.match(mobile, /\.data-quality-mobile-results[\s\S]*display:\s*block/);
  assert.match(mobile, /\.data-quality-summary[\s\S]*grid-template-columns:\s*repeat\(2,/);
});
