import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import JSZip from "jszip";
import { parseXlsxImportSheets, XLSX_IMPORT_LIMITS } from "../src/lib/imports.ts";

const dataRows = 25_000;
const sharedStrings = ["Employee ID", "Work Email", "Local #", "0801"];
const rowXml = new Array(dataRows + 1);
rowXml[0] = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>';
for (let index = 1; index <= dataRows; index += 1) {
  const suffix = index.toString().padStart(5, "0");
  const identifierIndex = sharedStrings.push(`SYNTH-E-${suffix}`) - 1;
  const emailIndex = sharedStrings.push(`member-${suffix}@example.test`) - 1;
  const rowNumber = index + 1;
  rowXml[index] = `<row r="${rowNumber}"><c r="A${rowNumber}" t="s"><v>${identifierIndex}</v></c>`
    + `<c r="B${rowNumber}" t="s"><v>${emailIndex}</v></c><c r="C${rowNumber}" t="s"><v>3</v></c></row>`;
}

const zip = new JSZip();
zip.file("[Content_Types].xml", "<Types/>");
zip.file("xl/workbook.xml", '<workbook xmlns:r="relationships"><sheets><sheet name="Roster" sheetId="1" r:id="rId1"/></sheets></workbook>');
zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
zip.file("xl/sharedStrings.xml", `<sst count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`
  + sharedStrings.map((value) => `<si><t>${value}</t></si>`).join("") + "</sst>");
zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${rowXml.join("")}</sheetData></worksheet>`);

const generateStarted = performance.now();
const bytes = await zip.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 6 },
});
const generationMilliseconds = performance.now() - generateStarted;
assert.ok(bytes.byteLength <= XLSX_IMPORT_LIMITS.compressedSourceBytes);

if (process.argv.includes("--emit")) {
  process.stdout.write(Buffer.from(bytes));
} else {
  const memoryBefore = process.memoryUsage();
  const parseStarted = performance.now();
  const sheets = await parseXlsxImportSheets(bytes);
  const parseMilliseconds = performance.now() - parseStarted;
  const memoryAfter = process.memoryUsage();

  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].state, "included");
  assert.equal(sheets[0].rows.length, dataRows + 1);
  assert.deepEqual(sheets[0].rows[0], ["Employee ID", "Work Email", "Local #"]);
  assert.deepEqual(sheets[0].rows.at(-1), ["SYNTH-E-25000", "member-25000@example.test", "0801"]);

  console.log(JSON.stringify({
    target: { syntheticOnly: true, dataRows, worksheets: sheets.length },
    sourceBytes: bytes.byteLength,
    generationMilliseconds: Math.round(generationMilliseconds * 10) / 10,
    parseMilliseconds: Math.round(parseMilliseconds * 10) / 10,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    limits: XLSX_IMPORT_LIMITS,
  }, null, 2));
}
