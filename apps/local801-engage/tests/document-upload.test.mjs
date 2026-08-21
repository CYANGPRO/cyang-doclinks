import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DocumentUploadError,
  documentUploadVisibilities,
  uploadDocument,
} from "../src/lib/document-upload.ts";

const actor = (role = "local_admin") => ({
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  role,
});

function file(overrides = {}) {
  const content = Buffer.from("synthetic document bytes", "utf8");
  return {
    name: "synthetic.pdf",
    type: "application/pdf",
    size: content.byteLength,
    async arrayBuffer() { return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength); },
    ...overrides,
  };
}

function dependencies(outcome = "clean") {
  const calls = [];
  return {
    calls,
    value: {
      maxBytes: 20 * 1024 * 1024,
      scanner: { async scan(input) { calls.push(["scan", input]); return { outcome }; } },
      async store(input) { calls.push(["store", input]); return { id: "33333333-3333-4333-8333-333333333333", byteSize: input.content.byteLength }; },
      async remove(input) { calls.push(["remove", input]); return { deleted: true }; },
      async audit(input) { calls.push(["audit", input]); return { id: "audit" }; },
    },
  };
}

const baseInput = (role = "local_admin", overrides = {}) => ({
  actor: actor(role),
  file: file(),
  title: "Synthetic handbook",
  category: "Training",
  visibility: "local_admin_only",
  ...overrides,
});

test("upload sharing scopes are derived from the existing role permission model", () => {
  assert.deepEqual(documentUploadVisibilities("system_owner"), ["local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope"]);
  assert.deepEqual(documentUploadVisibilities("local_admin"), ["local_admin_only", "membership_management", "cat_admin_only", "cat_lead_scope", "cat_member_scope"]);
  assert.deepEqual(documentUploadVisibilities("membership_data_manager"), ["membership_management"]);
  assert.deepEqual(documentUploadVisibilities("cat_admin"), ["cat_admin_only", "cat_lead_scope", "cat_member_scope"]);
  assert.deepEqual(documentUploadVisibilities("cat_lead"), []);
  assert.deepEqual(documentUploadVisibilities("cat_member"), []);
  assert.deepEqual(documentUploadVisibilities("report_viewer"), []);
});

test("unauthorized uploader and tampered visibility fail before scanner or storage", async () => {
  for (const input of [
    baseInput("cat_lead", { visibility: "cat_lead_scope" }),
    baseInput("membership_data_manager", { visibility: "local_admin_only" }),
    baseInput("cat_admin", { visibility: "membership_management" }),
    baseInput("cat_member", { visibility: "cat_member_scope" }),
  ]) {
    const deps = dependencies();
    await assert.rejects(uploadDocument(input, deps.value), (error) => error instanceof DocumentUploadError && error.code === "VISIBILITY_FORBIDDEN");
    assert.equal(deps.calls.length, 0);
  }
});

test("unsupported extension/type and oversized files fail before scanning", async () => {
  const unsupported = dependencies();
  await assert.rejects(uploadDocument(baseInput("local_admin", { file: file({ name: "synthetic.exe", type: "application/pdf" }) }), unsupported.value),
    (error) => error instanceof DocumentUploadError && error.code === "UNSUPPORTED_FILE");
  assert.equal(unsupported.calls.length, 0);

  const oversized = dependencies();
  await assert.rejects(uploadDocument(baseInput("local_admin", { file: file({ size: oversized.value.maxBytes + 1 }) }), oversized.value),
    (error) => error instanceof DocumentUploadError && error.code === "FILE_TOO_LARGE");
  assert.equal(oversized.calls.length, 0);
});

test("malicious verdict fails closed before encrypted storage", async () => {
  const deps = dependencies("malicious");
  await assert.rejects(uploadDocument(baseInput(), deps.value),
    (error) => error instanceof DocumentUploadError && error.code === "MALWARE_REJECTED" && error.retryable === false);
  assert.deepEqual(deps.calls.map(([name]) => name), ["scan"]);
});

test("temporary and terminal scanner failures fail closed before encrypted storage", async () => {
  for (const [outcome, code] of [["temporary_failure", "SCANNER_TEMPORARY_FAILURE"], ["terminal_scanner_failure", "SCANNER_UNAVAILABLE"]]) {
    const deps = dependencies(outcome);
    await assert.rejects(uploadDocument(baseInput(), deps.value),
      (error) => error instanceof DocumentUploadError && error.code === code && error.retryable === true);
    assert.deepEqual(deps.calls.map(([name]) => name), ["scan"]);
  }
});

test("clean verdict scans before encrypted storage, then writes a redacted-safe audit event", async () => {
  const deps = dependencies("clean");
  const result = await uploadDocument(baseInput(), deps.value);
  assert.equal(result.uploaded, true);
  assert.deepEqual(deps.calls.map(([name]) => name), ["scan", "store", "audit"]);
  const store = deps.calls.find(([name]) => name === "store")[1];
  assert.equal(store.status, "active");
  assert.equal(store.visibility, "local_admin_only");
  assert.equal(store.originalFilename, "synthetic.pdf");
  assert.equal(store.mediaType, "application/pdf");
  const audit = deps.calls.find(([name]) => name === "audit")[1];
  assert.equal(audit.eventType, "record.create");
  assert.equal(audit.payload.malwareScan, "clean");
  assert.equal("title" in audit.payload, false);
  assert.equal("filename" in audit.payload, false);
  assert.equal("id" in result, false);
  assert.equal("storageKey" in result, false);
});

test("audit failure compensates by deleting/archiving the encrypted document and returns failure", async () => {
  const deps = dependencies("clean");
  deps.value.audit = async (input) => { deps.calls.push(["audit", input]); throw new Error("audit unavailable"); };
  await assert.rejects(uploadDocument(baseInput(), deps.value),
    (error) => error instanceof DocumentUploadError && error.code === "UPLOAD_UNAVAILABLE");
  assert.deepEqual(deps.calls.map(([name]) => name), ["scan", "store", "audit", "remove"]);
});

test("upload route is Preview-only, same-origin, permission-gated, scanner-backed, encrypted, and non-cacheable", () => {
  const source = readFileSync(new URL("../src/app/api/documents/upload/route.ts", import.meta.url), "utf8");
  assert.match(source, /VERCEL_ENV === "production"/);
  assert.match(source, /LOCAL801_PREVIEW_AUTH_ENABLED !== "1"/);
  assert.match(source, /hasExactSameOrigin\(request\)/);
  assert.match(source, /requirePreviewUser\("manageDocuments"\)/);
  assert.match(source, /resolveWorkspaceContext\(auth\.user\)/);
  assert.match(source, /getImportMalwareScanner as getSharedMalwareScanner/);
  assert.match(source, /storeEncryptedDocument/);
  assert.match(source, /deleteEncryptedDocument/);
  assert.match(source, /writeAuditEvent/);
  assert.match(source, /Cache-Control.*private, no-store/);
  assert.doesNotMatch(source, /presign|signedUrl|storage_key/);
});

test("upload form sends only document metadata/file fields and no organization or role override", () => {
  const source = readFileSync(new URL("../src/components/DocumentUploadForm.tsx", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/documents\/upload"/);
  assert.match(source, /name="title"/);
  assert.match(source, /name="category"/);
  assert.match(source, /name="visibility"/);
  assert.match(source, /name="file"/);
  assert.match(source, /accept="\.pdf,\.docx,\.xlsx,\.csv,\.txt"/);
  assert.doesNotMatch(source, /name="organization/i);
  assert.doesNotMatch(source, /name="role/i);
});

test("documents page shows upload UI only from server-derived manageDocuments visibility options", () => {
  const source = readFileSync(new URL("../src/app/documents/page.tsx", import.meta.url), "utf8");
  assert.match(source, /can\(user\.role, "manageDocuments"\)/);
  assert.match(source, /documentUploadVisibilities\(user\.role\)/);
  assert.match(source, /<DocumentUploadForm visibilityOptions=\{uploadOptions\}/);
  assert.doesNotMatch(source, /organizationId=.*DocumentUploadForm/);
  assert.doesNotMatch(source, /role=.*DocumentUploadForm/);
});

test("CAT member scope is shareable by authorized uploaders but CAT members themselves cannot upload", async () => {
  const deps = dependencies("clean");
  const result = await uploadDocument(baseInput("cat_admin", { visibility: "cat_member_scope" }), deps.value);
  assert.equal(result.visibility, "cat_member_scope");
  assert.deepEqual(deps.calls.map(([name]) => name), ["scan", "store", "audit"]);
  assert.equal(deps.calls.find(([name]) => name === "store")[1].visibility, "cat_member_scope");
  assert.equal(documentUploadVisibilities("cat_member").length, 0);
});

test("encrypted document storage recognizes CAT member visibility with the dedicated permission", () => {
  const source = readFileSync(new URL("../src/lib/document-storage.ts", import.meta.url), "utf8");
  assert.match(source, /"cat_member_scope"/);
  assert.match(source, /cat_member_scope: "viewCatMemberDocuments"/);
});
