import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { attendanceImportMetadataSchema, uploadImportKindSchema } from "../src/lib/imports.ts";
import { __testing as attendanceApplyTesting } from "../src/lib/attendance-import-apply.ts";

test("attendance roster intake requires a bounded description and real meeting date", () => {
  assert.equal(uploadImportKindSchema.safeParse("attendance_roster").success, true);
  assert.equal(attendanceImportMetadataSchema.safeParse({ description: "September membership meeting", meetingDate: "2026-09-01" }).success, true);
  assert.equal(attendanceImportMetadataSchema.safeParse({ description: "", meetingDate: "2026-09-01" }).success, false);
  assert.equal(attendanceImportMetadataSchema.safeParse({ description: "Meeting", meetingDate: "2026-02-30" }).success, false);
});

test("attendance execution accepts only one clean source and distinct active existing employees", () => {
  const base = {
    import_kind: "attendance_roster",
    batch_state: "under_review",
    processing_stage: "ready_for_review",
    execution_state: "prepared",
    mutation_fingerprint: "a".repeat(64),
    approval_fingerprint: "b".repeat(64),
    mutation_count: 3,
    description: "Meeting",
    meeting_date: "2026-09-01",
    response_key: `custom:${"c".repeat(32)}`,
    action_id: null,
    source_file_count: 1,
    clean_source_count: 1,
    prepared_mutation_count: 3,
    distinct_person_count: 3,
    invalid_target_count: 0,
  };
  assert.doesNotThrow(() => attendanceApplyTesting.assertReady(base, "a".repeat(64), "b".repeat(64)));
  assert.throws(() => attendanceApplyTesting.assertReady({ ...base, invalid_target_count: 1 }, "a".repeat(64), "b".repeat(64)), /only when every row matches/i);
  assert.throws(() => attendanceApplyTesting.assertReady({ ...base, distinct_person_count: 2 }, "a".repeat(64), "b".repeat(64)), /only when every row matches/i);
});

test("attendance import UI asks for description and meeting date and execution creates Attended history", async () => {
  const [form, route, apply, migration] = await Promise.all([
    readFile(new URL("../src/components/ImportPreviewForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/imports/[batchId]/execute/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/attendance-import-apply.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/migrations/0045__attendance_roster_action_imports.sql", import.meta.url), "utf8"),
  ]);
  assert.match(form, /Attendance roster/);
  assert.match(form, /attendanceDescription/);
  assert.match(form, /attendanceMeetingDate/);
  assert.match(route, /applyPreparedAttendanceImport/);
  assert.match(apply, /'label', 'Attended'/);
  assert.match(apply, /mutation\.mutation_kind = 'existing'/);
  assert.match(migration, /import_attendance_plans/);
  assert.match(migration, /action_id uuid references local801\.employee_actions/);
});
