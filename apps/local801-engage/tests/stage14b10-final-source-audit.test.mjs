import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function sourceFiles(directoryUrl) {
  const directory = fileURLToPath(directoryUrl);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) files.push(...await sourceFiles(url));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(url);
  }
  return files;
}

async function text(relative) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("no runtime source outside the read-state helper remains Preview-only for protected PII dispatch", async () => {
  const files = await sourceFiles(new URL("../src/", import.meta.url));
  const offenders = [];
  for (const file of files) {
    const pathname = fileURLToPath(file);
    if (pathname.replaceAll("\\", "/").endsWith("/src/lib/pii-protected-read.ts")) continue;
    const source = await readFile(file, "utf8");
    if (source.includes("isPreviewProtectedPiiReadEnabled")) offenders.push(pathname.split("/src/").at(-1));
  }
  assert.deepEqual(offenders, []);
});

test("production JWT/session stores only opaque Local 801 auth state and strips profile PII", async () => {
  const source = await text("../src/lib/auth-options.ts");
  const start = source.indexOf("token.local801Auth = {");
  const end = source.indexOf("};", start);
  assert.ok(start >= 0 && end > start);
  const binding = source.slice(start, end + 2);
  assert.match(binding, /organizationSlug: binding\.organizationSlug/);
  assert.match(binding, /userId: binding\.userId/);
  assert.match(binding, /sessionVersion: binding\.sessionVersion/);
  assert.doesNotMatch(binding, /\bemail\b|providerSubject|provider_subject|linkedEmail|linked_email/i);
  assert.match(source, /delete token\.email/);
  assert.match(source, /delete token\.name/);
  assert.match(source, /delete token\.picture/);
  assert.match(source, /session\.user = undefined/);
});

test("protected authoritative apply never reads direct PII from operational_json and its audit payload is metadata-only", async () => {
  const source = await text("../src/lib/pii-protected-import-apply.ts");
  for (const field of ["first_name", "last_name", "preferred_name", "work_email", "employee_identifier", "member_identifier", "home_email", "work_phone", "cell_phone", "home_phone"]) {
    assert.doesNotMatch(source, new RegExp(`operational_json\\s*->>\\s*['\"]${field}['\"]`, "i"), field);
  }
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const auditStart = normalizedSource.lastIndexOf("payload: {");
  const auditEnd = normalizedSource.indexOf("},\n    }, query);", auditStart);
  assert.ok(auditStart >= 0 && auditEnd > auditStart);
  const auditPayload = normalizedSource.slice(auditStart, auditEnd);
  assert.match(auditPayload, /protectedExecution/);
  assert.match(auditPayload, /mutationFingerprint/);
  assert.match(auditPayload, /totalRows/);
  assert.doesNotMatch(auditPayload, /firstName|lastName|email|providerSubject|identifierValue|contactValue/i);
});

test("protected import staging and execute API keep direct PII and internal execution metadata server-side", async () => {
  const [staging, route, control] = await Promise.all([
    text("../src/lib/pii-protected-import-execution.ts"),
    text("../src/app/api/imports/[batchId]/execute/route.ts"),
    text("../src/components/ImportExecutionControl.tsx"),
  ]);
  assert.match(staging, /operationalOnly/);
  assert.match(staging, /delete value\[field\]/);
  assert.match(control, /JSON\.stringify\(\{ fingerprint \}\)/);
  assert.doesNotMatch(control, /executionSetId|mutationFingerprint/);
  const protectedResponse = route.slice(route.indexOf("protectionMode: \"protected\""), route.indexOf("const result = await executeAuthoritativeImport"));
  assert.doesNotMatch(protectedResponse, /executionSetId|mutationFingerprint|\.\.\.result/);
});

test("Stage 14B protected maintenance tools do not log direct PII fields or raw key material", async () => {
  const files = [
    "../scripts/backfill-pii-preview-v2.mjs",
    "../scripts/cutover-pii-protected-preview.mjs",
    "../scripts/rotate-protected-pii.mjs",
  ];
  for (const file of files) {
    const source = await text(file);
    const logLines = source.split("\n").filter((line) => /console\.(?:log|info|warn|error)\s*\(/.test(line));
    const logged = logLines.join("\n");
    assert.doesNotMatch(logged, /first_name|last_name|preferred_name|work_email|provider_subject|linked_email|contact_value|identifier_value|clientSecret|MASTER_KEYS|BLIND_INDEX_KEYS/i, file);
  }
});

test("protected key rotation package command remains dry-run by default", async () => {
  const packageJson = JSON.parse(await text("../package.json"));
  const command = packageJson.scripts?.["pii:rotate:protected"];
  assert.equal(typeof command, "string");
  assert.match(command, /scripts\/rotate-protected-pii\.mjs/);
  assert.doesNotMatch(command, /--apply|--retire-old-indexes/);
});
