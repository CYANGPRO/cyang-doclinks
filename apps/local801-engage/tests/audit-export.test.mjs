import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import JSZip from "jszip";
import { AuditExportLimitError, getAuditExportEvents, MAX_AUDIT_EXPORT_EVENTS } from "../src/lib/audit.ts";
import { getAuditDisplayExport } from "../src/lib/audit-display.ts";
import { buildAuditActivityWorkbook } from "../src/lib/audit-export-xlsx.ts";

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationSlug: "local801-preview",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "admin@example.test",
  role: "local_admin",
};

const events = [{
  id: "33333333-3333-4333-8333-333333333333",
  event_type: "role.change",
  actor_user_id: "44444444-4444-4444-8444-444444444444",
  subject_type: "user",
  subject_id: "55555555-5555-4555-8555-555555555555",
  created_at: "2026-08-24T13:30:00.000Z",
  eventLabel: "Changed user role",
  subjectLabel: "Workspace user",
  actorDisplayName: "=WEBSERVICE(\"https://example.test\")",
}, {
  id: "66666666-6666-4666-8666-666666666666",
  event_type: "config.change",
  actor_user_id: null,
  subject_type: "configuration",
  subject_id: null,
  created_at: "2026-08-24T12:00:00.000Z",
  eventLabel: "Changed configuration",
  subjectLabel: "Configuration",
  actorDisplayName: null,
}];

test("audit activity workbook is a formatted Excel file with only the safe visible columns", async () => {
  const workbook = await buildAuditActivityWorkbook(events);
  const zip = await JSZip.loadAsync(workbook);
  for (const path of [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]) assert.ok(zip.file(path), `${path} should be present`);

  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheet, />When</);
  assert.match(sheet, />What happened</);
  assert.match(sheet, />Actor</);
  assert.match(sheet, />Affected area</);
  assert.match(sheet, /Changed user role/);
  assert.match(sheet, /System/);
  assert.match(sheet, /=WEBSERVICE\(&quot;https:\/\/example\.test&quot;\)/);
  assert.match(sheet, /ySplit="1"/);
  assert.match(sheet, /autoFilter ref="A1:D3"/);
  assert.doesNotMatch(sheet, /<f(?:\s|>)/);
  assert.doesNotMatch(sheet, /33333333-3333-4333-8333-333333333333/);
  assert.doesNotMatch(sheet, /55555555-5555-4555-8555-555555555555/);
  assert.doesNotMatch(sheet, /role\.change/);

  const styles = await zip.file("xl/styles.xml").async("string");
  assert.match(styles, /formatCode="yyyy-mm-dd hh:mm"/);
  assert.match(styles, /FF134D8C/);
});

test("bounded audit export stays organization scoped and honors the selected activity filter", async () => {
  const calls = [];
  const exported = await getAuditDisplayExport(context, { eventType: "role.change" }, {
    env: {},
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return events.slice(0, 1);
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE organization_id = \$1/);
  assert.match(calls[0].sql, new RegExp(`LIMIT ${MAX_AUDIT_EXPORT_EVENTS + 1}`));
  assert.deepEqual(calls[0].parameters, [context.organizationId, "role.change"]);
  assert.equal(exported.eventType, "role.change");
  assert.equal(exported.events[0].eventLabel, "Changed user role");
  assert.equal(exported.events[0].actorDisplayName, null);
});

test("audit export refuses an oversized result instead of returning a partial workbook", async () => {
  const rows = Array.from({ length: MAX_AUDIT_EXPORT_EVENTS + 1 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    event_type: "report.run",
    actor_user_id: null,
    subject_type: "report",
    subject_id: null,
    created_at: "2026-08-24T13:30:00.000Z",
  }));
  await assert.rejects(
    () => getAuditExportEvents(context, {}, async () => rows),
    AuditExportLimitError,
  );
});

test("audit export route and page preserve authorization, throttling, and no-store delivery", () => {
  const route = readFileSync(new URL("../src/app/api/audit/export/route.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/audit/page.tsx", import.meta.url), "utf8");
  assert.match(route, /requirePreviewUser\("manageUsers"\)/);
  assert.match(route, /enforceWorkspaceRateLimit\(context, "export"\)/);
  assert.match(route, /eventType: "export\.generate"/);
  assert.match(route, /"Content-Type": XLSX_CONTENT_TYPE/);
  assert.match(route, /private, no-store/);
  assert.match(page, /Download Excel/);
  assert.match(page, /\/api\/audit\/export/);
});
