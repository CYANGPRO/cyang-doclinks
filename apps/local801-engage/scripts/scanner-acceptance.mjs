import { getImportMalwareScanner } from "../src/lib/import-scanner.ts";

const confirmation = "SEND_STANDARD_ANTIMALWARE_TEST_PAYLOADS";
if (process.env.LOCAL801_SCANNER_ACCEPTANCE_CONFIRM !== confirmation
  || process.env.LOCAL801_MALWARE_SCANNER_ENABLED !== "1"
  || process.env.LOCAL801_MALWARE_SCANNER_URL !== "https://scan.cyang.io"
  || process.env.LOCAL801_MALWARE_SCANNER_CLIENT_ID !== "local801-production") {
  console.error(JSON.stringify({ scannerAcceptance: "error", code: "SCANNER_ACCEPTANCE_PRECONDITION_FAILED" }, null, 2));
  process.exit(2);
}

const scanner = getImportMalwareScanner();
const clean = Buffer.from("Local 801 synthetic malware scanner acceptance\n", "utf8");
const expected = process.env.LOCAL801_SCANNER_ACCEPTANCE_EXPECT ?? "clean-infected";
if (!new Set(["clean-infected", "unavailable"]).has(expected)) {
  console.error(JSON.stringify({ scannerAcceptance: "error", code: "SCANNER_ACCEPTANCE_PRECONDITION_FAILED" }, null, 2));
  process.exit(2);
}

if (expected === "unavailable") {
  const unavailableResult = await scanner.scan({
    content: clean,
    mediaType: "text/plain",
    originalFilename: "local801-synthetic-unavailable-check.txt",
  });
  if (unavailableResult.outcome !== "temporary_failure") {
    console.error(JSON.stringify({ scannerAcceptance: "error", unavailablePath: unavailableResult.outcome }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify({ scannerAcceptance: "ok", unavailablePath: "ok" }, null, 2));
  process.exit(0);
}

const antimalwareTest = Buffer.from([
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
].join(""), "ascii");

const cleanResult = await scanner.scan({
  content: clean,
  mediaType: "text/plain",
  originalFilename: "local801-synthetic-clean.txt",
});
const infectedResult = await scanner.scan({
  content: antimalwareTest,
  mediaType: "application/octet-stream",
  originalFilename: "local801-standard-antimalware-test.com",
});

if (cleanResult.outcome !== "clean" || infectedResult.outcome !== "malicious") {
  console.error(JSON.stringify({
    scannerAcceptance: "error",
    cleanPath: cleanResult.outcome,
    infectedPath: infectedResult.outcome,
  }, null, 2));
  process.exit(2);
}

console.log(JSON.stringify({ scannerAcceptance: "ok", cleanPath: "ok", infectedPath: "ok" }, null, 2));
