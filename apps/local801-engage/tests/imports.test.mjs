import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

const imports = await import("../src/lib/imports.ts");

test("filters Local 0801 rows", () => {
  assert.equal(imports.shouldIncludeLocal801("801"), true);
  assert.equal(imports.shouldIncludeLocal801("0801"), true);
  assert.equal(imports.shouldIncludeLocal801("0802"), false);
});

test("maps common roster headers", () => {
  const mapped = imports.mapHeaders(["Local #", "Work Email", "Agency"]);
  assert.deepEqual(
    mapped.map((row) => row.mappedTo),
    ["local", "work_email", "department"],
  );
});

test("maps Local 801 membership and personal-contact workbook headers", () => {
  const headers = [
    "Local", "Type", "Preferred First Name", "Last Name", "Section Name", "Work Phone", "Work Email",
    "Cell Phone", "Home Phone", "Appointment Employment Status Name", "MAPE Hire Date", "Home Email",
  ];
  assert.deepEqual(imports.mapHeaders(headers).map((row) => row.mappedTo), [
    "local", "membership_status", "first_name", "last_name", "work_location", "work_phone", "work_email",
    "cell_phone", "home_phone", "job_status", "hire_date", "home_email",
  ]);
  const values = imports.normalizeImportRow(headers, [
    "801", "Non-Member", "Avery", "Morgan", "Fiscal Support", "(651) 555-0100", "avery@state.mn.us",
    "(651) 555-0101", "(651) 555-0102", "Permanent", "44743", "avery@example.test",
  ]);
  assert.equal(values.membership_status, "nonmember");
  assert.equal(values.work_location, "Fiscal Support");
  assert.equal(values.hire_date, "2022-07-01");
  assert.equal(values.job_status, "Permanent");
  assert.equal(values.home_email, "avery@example.test");
});

test("placeholder all-zero phone numbers are not imported", () => {
  const values = imports.normalizeImportRow(["Work Phone", "Cell Phone"], ["(000) 000-0000", "651-555-0100"]);
  assert.equal(values.work_phone, null);
  assert.equal(values.cell_phone, "651-555-0100");
});

test("neutralizes spreadsheet formulas", () => {
  assert.equal(imports.neutralizeSpreadsheetFormula("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(imports.neutralizeSpreadsheetFormula("ordinary"), "ordinary");
});

test("classifies obsolete and narrative legacy worksheets", () => {
  assert.equal(imports.classifyLegacyWorksheet("Obsolete template"), "ignore_by_default");
  assert.equal(imports.classifyLegacyWorksheet("Organizer narrative notes"), "review_notes");
});

test("validates missing, duplicate, and conflicting authoritative identifiers", () => {
  const summary = imports.validateImportRows({
    sourceFilename: "synthetic.csv",
    importingUser: "preview-local-admin",
    importedAt: "2026-08-06T00:00:00.000Z",
    rows: [
      ["Employee ID", "First Name", "Last Name", "Membership Status", "Agency"],
      ["100", "Avery", "Morgan", "member", "Health"],
      ["", "No", "Identifier", "member", "Health"],
      ["100", "Avery", "Morgan", "nonmember", "Health"],
    ],
  });

  assert.equal(summary.totalRows, 3);
  assert.equal(summary.missingIdentifiers, 1);
  assert.equal(summary.duplicateIdentifiers, 1);
  assert.equal(summary.conflictingRecords, 1);
  assert.equal(summary.transactional, true);
});

test("exports validation errors as formula-safe CSV", () => {
  const csv = imports.validationErrorsToCsv([
    {
      rowNumber: 2,
      identifier: "=not-a-formula",
      field: "identifier",
      code: "missing_identifier",
      message: "Rows require an authoritative identifier.",
    },
  ]);

  assert.match(csv, /'=not-a-formula/);
});

test("reads a synthetic xlsx workbook for preview validation", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Roster" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>Employee ID</t></is></c><c r="B1" t="inlineStr"><is><t>Work Email</t></is></c><c r="C1" t="inlineStr"><is><t>Local #</t></is></c></row>
  <row r="2"><c r="A2" t="inlineStr"><is><t>100</t></is></c><c r="B2" t="inlineStr"><is><t>synthetic@example.test</t></is></c><c r="C2" t="inlineStr"><is><t>0801</t></is></c></row>
</sheetData></worksheet>`);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const file = new File([bytes], "synthetic.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const rows = await imports.rowsFromImportFile(file);
  const summary = imports.validateImportRows({
    rows,
    sourceFilename: file.name,
    importingUser: "preview-local-admin",
  });

  assert.equal(summary.totalRows, 1);
  assert.equal(summary.acceptedRows, 1);
  assert.deepEqual(summary.identifierColumns, ["Employee ID", "Work Email"]);
});
