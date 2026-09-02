import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

const imports = await import("../src/lib/imports.ts");

async function syntheticWorkbook(sheets, options = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", `<workbook xmlns:r="relationships"><sheets>${sheets.map((sheet, index) =>
    `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships>${sheets.map((_sheet, index) =>
    `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`);
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData>${sheet.rows.map((cells, rowIndex) =>
      `<row r="${rowIndex + 1}">${cells.map((cell, columnIndex) =>
        `<c r="${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${cell}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`);
  });
  return zip.generateAsync({ type: "uint8array", ...options });
}

function firstSignature(bytes, signature) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
}

test("filters Local 0801 rows", () => {
  assert.equal(imports.shouldIncludeLocal801("801"), true);
  assert.equal(imports.shouldIncludeLocal801("0801"), true);
  assert.equal(imports.shouldIncludeLocal801("Local 0801"), true);
  assert.equal(imports.shouldIncludeLocal801("0802"), false);
  assert.equal(imports.shouldIncludeLocal801("1801"), false);
});

test("maps common roster headers", () => {
  const mapped = imports.mapHeaders(["Local #", "Work Email", "Agency"]);
  assert.deepEqual(
    mapped.map((row) => row.mappedTo),
    ["local", "work_email", "department"],
  );
});

test("maps the supported Local 801 workbook header profiles", () => {
  const mapped = imports.mapHeaders([
    "Local Name",
    "Preferred/First Name",
    "Preferred First Name",
    "Department Name",
    "Section Name",
    "Classification Name",
    "Location Name",
    "Office Name",
    "MAPE Hire Date",
    "Home Email",
    "Cell Phone",
    "Home Phone",
    "Job Status",
  ]);
  assert.deepEqual(mapped.map((row) => row.mappedTo), [
    "local",
    "preferred_name",
    "preferred_name",
    "department",
    "section",
    "classification",
    "work_location",
    "work_location",
    "hire_date",
    "home_email",
    "cell_phone",
    "home_phone",
    "job_status",
  ]);
});

test("normalizes every employment and contact field used by the directory", () => {
  const normalized = imports.normalizeImportRow(
    ["Home Email", "Cell Phone", "Home Phone", "Work Phone", "MAPE Hire Date", "Job Status"],
    ["member@example.test", "651-555-0101", "651-555-0102", "651-555-0103", "8/4/2026", "Active"],
  );
  assert.deepEqual(normalized, {
    home_email: "member@example.test",
    cell_phone: "651-555-0101",
    home_phone: "651-555-0102",
    work_phone: "651-555-0103",
    hire_date: "2026-08-04",
    job_status: "Active",
    personal_email: "member@example.test",
  });
});

test("maps and canonicalizes membership status from every supported Local 801 workbook profile", () => {
  assert.deepEqual(
    imports.mapHeaders(["Type", "Person Type", "Member Type"]).map((row) => row.mappedTo),
    ["membership_status", "membership_status", "membership_status"],
  );
  for (const header of ["Type", "Person Type", "Member Type"]) {
    assert.equal(imports.normalizeImportRow([header], ["Member"]).membership_status, "member");
    assert.equal(imports.normalizeImportRow([header], ["Non-Member"]).membership_status, "nonmember");
  }
  assert.equal(imports.normalizeMembershipStatus("non member"), "nonmember");
  assert.equal(imports.normalizeMembershipStatus("NON_MEMBER"), "nonmember");
  assert.equal(imports.normalizeMembershipStatus("unsupported"), null);
});

test("normalizes Excel hire-date serials and uses preferred/first as a safe first-name fallback", () => {
  assert.equal(imports.normalizeImportDate("45508"), "2024-08-04");
  assert.equal(imports.normalizeImportDate("8/4/2026"), "2026-08-04");
  assert.equal(imports.normalizeImportDate("not-a-date"), null);
  assert.deepEqual(
    imports.normalizeImportRow(
      ["Preferred/First Name", "Last Name", "MAPE Hire Date", "Work Email"],
      ["Synthetic Avery", "Example", "45508", "avery@example.test"],
    ),
    {
      preferred_name: "Synthetic Avery",
      last_name: "Example",
      hire_date: "2024-08-04",
      work_email: "avery@example.test",
      first_name: "Synthetic Avery",
    },
  );
});

test("new uploads accept only current roster and new hires while historical kinds remain readable", () => {
  assert.equal(imports.uploadImportKindSchema.parse("current_roster"), "current_roster");
  assert.equal(imports.uploadImportKindSchema.parse("new_hires"), "new_hires");
  assert.equal(imports.uploadImportKindSchema.safeParse("recent_hires").success, false);
  assert.equal(imports.importKindSchema.parse("recent_hires"), "recent_hires");
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

test("bounded xlsx parsing preserves multiple included sheets and classifies notes", async () => {
  const bytes = await syntheticWorkbook([
    { name: "Roster", rows: [["Employee ID", "Work Email"], ["SYNTH-1", "one@example.test"]] },
    { name: "Additions", rows: [["Employee ID", "Work Email"], ["SYNTH-2", "two@example.test"]] },
    { name: "Organizer notes", rows: [["Narrative"], ["Synthetic note"]] },
  ]);
  const sheets = await imports.parseXlsxImportSheets(bytes);
  assert.deepEqual(sheets.map(({ name, state }) => ({ name, state })), [
    { name: "Roster", state: "included" },
    { name: "Additions", state: "included" },
    { name: "Organizer notes", state: "notes_review" },
  ]);
});

test("bounded xlsx parsing enforces worksheet, cell, row, entry, and compression-ratio limits", async () => {
  const bytes = await syntheticWorkbook([
    { name: "Roster", rows: [["Employee ID", "Work Email"], ["SYNTH-1", "one@example.test"], ["SYNTH-2", "two@example.test"]] },
    { name: "Additions", rows: [["Employee ID"], ["SYNTH-3"]] },
  ], { compression: "DEFLATE" });
  const cases = [
    [{ worksheetCount: 1 }, "worksheet_count_exceeded"],
    [{ cellCount: 2 }, "cell_count_exceeded"],
    [{ includedDataRows: 1 }, "row_count_exceeded"],
    [{ zipEntryCount: 3 }, "entry_count_exceeded"],
    [{ compressionRatio: 2 }, "compression_ratio_exceeded"],
  ];
  for (const [limits, code] of cases) {
    await assert.rejects(imports.parseXlsxImportSheets(bytes, limits),
      (error) => error instanceof imports.XlsxImportError && error.code === code);
  }
});

test("bounded xlsx parsing rejects unsafe paths, encrypted entries, and false size metadata", async () => {
  const unsafe = new JSZip();
  unsafe.file("../escape.xml", "unsafe");
  const unsafeBytes = await unsafe.generateAsync({ type: "uint8array" });
  await assert.rejects(imports.parseXlsxImportSheets(unsafeBytes),
    (error) => error instanceof imports.XlsxImportError && error.code === "unsafe_entry_path");

  const valid = await syntheticWorkbook([
    { name: "Roster", rows: [["Employee ID"], ["SYNTH-1"]] },
  ]);
  const encrypted = valid.slice();
  const encryptedView = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  const central = firstSignature(encrypted, 0x02014b50);
  assert.ok(central >= 0);
  encryptedView.setUint16(central + 8, encryptedView.getUint16(central + 8, true) | 1, true);
  await assert.rejects(imports.parseXlsxImportSheets(encrypted),
    (error) => error instanceof imports.XlsxImportError && error.code === "encrypted_entry");

  const falseMetadata = valid.slice();
  const falseView = new DataView(falseMetadata.buffer, falseMetadata.byteOffset, falseMetadata.byteLength);
  const falseCentral = firstSignature(falseMetadata, 0x02014b50);
  const localOffset = falseView.getUint32(falseCentral + 42, true);
  const declared = falseView.getUint32(falseCentral + 24, true);
  assert.ok(declared > 1);
  falseView.setUint32(falseCentral + 24, declared - 1, true);
  falseView.setUint32(localOffset + 22, declared - 1, true);
  await assert.rejects(imports.parseXlsxImportSheets(falseMetadata),
    (error) => error instanceof imports.XlsxImportError && error.code === "malformed_archive");
});
