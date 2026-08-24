import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import {
  ImportWorkerError,
  ensureImportProcessingJob,
  parseAndStageImport,
  safeImportWorkerErrorCode,
  scanImportSource,
} from "../src/lib/import-worker.ts";
import {
  durablePreviewImportsEnabled,
  isStrictSyntheticPreviewCsv,
} from "../src/lib/import-scanner.ts";
import { startQueuedImportWorkflow } from "../src/lib/import-workflow-starter.ts";
import { acceptDurablePreviewImport } from "../src/lib/import-async-acceptance.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";
const input = { organizationId, batchId };
const enabledEnv = {
  VERCEL_ENV: "preview",
  LOCAL801_PREVIEW_AUTH_ENABLED: "1",
  LOCAL801_DURABLE_IMPORTS_ENABLED: "1",
};

async function durableXlsxBytes() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", `<workbook xmlns:r="relationships"><sheets>
    <sheet name="Roster" sheetId="1" r:id="rId1"/>
    <sheet name="Additions" sheetId="2" r:id="rId2"/>
    <sheet name="Organizer notes" sheetId="3" r:id="rId3"/>
  </sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships>
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
    <Relationship Id="rId3" Target="worksheets/sheet3.xml"/>
  </Relationships>`);
  const sheet = (id, email, local = "0801") => `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Employee ID</t></is></c><c r="B1" t="inlineStr"><is><t>Work Email</t></is></c><c r="C1" t="inlineStr"><is><t>Local #</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>${id}</t></is></c><c r="B2" t="inlineStr"><is><t>${email}</t></is></c><c r="C2" t="inlineStr"><is><t>${local}</t></is></c></row>
  </sheetData></worksheet>`;
  zip.file("xl/worksheets/sheet1.xml", sheet("SYNTH-E-1", "one@example.test"));
  zip.file("xl/worksheets/sheet2.xml", sheet("SYNTH-E-2", "two@example.test", "0802"));
  zip.file("xl/worksheets/sheet3.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Note</t></is></c></row></sheetData></worksheet>");
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

test("ensure-job has one CAS winner, same-run replay, and a different-run loser", async () => {
  let claimed = false;
  const query = async (sql) => {
    if (sql.includes("WITH claimed AS")) {
      if (claimed) return [];
      claimed = true;
      return [{ id: "job", state: "running", workflow_run_id: "run-A", attempt_count: 1 }];
    }
    if (sql.includes("SELECT state, workflow_run_id, processing_version")) {
      return [{ state: "running", workflow_run_id: "run-A", processing_version: "local801-import-v1" }];
    }
    return [];
  };
  assert.equal(await ensureImportProcessingJob(input, "run-A", query), "claim");
  assert.equal(await ensureImportProcessingJob(input, "run-A", query), "already_owned");
  assert.equal(await ensureImportProcessingJob(input, "run-B", query), "not_owner");
});

test("terminal scanner failure rejects even a strictly synthetic Preview CSV", async () => {
  let sourceCalls = 0;
  let scanCalls = 0;
  const query = async (sql) => {
    if (sql.includes("SELECT state, workflow_run_id, processing_version")) {
      return [{ state: "running", workflow_run_id: "run-A", processing_version: "local801-import-v1" }];
    }
    if (sql.includes("UPDATE local801.import_batches")) return [{ processing_stage: "scanning" }];
    return [];
  };
  const loadSource = async () => {
    sourceCalls += 1;
    return { id: "source", plaintext: Buffer.from("Employee ID,Work Email\nSYNTH-1,one@example.test"),
      mediaType: "text/csv", originalFilename: "synthetic.csv", sha256: "a".repeat(64) };
  };
  const scanner = { scan: async () => { scanCalls += 1; return { outcome: "terminal_scanner_failure" }; } };
  await assert.rejects(
    scanImportSource(input, "run-A", { query, loadSource, scanner }),
    (error) => error instanceof ImportWorkerError && error.code === "SCANNER_UNAVAILABLE" && !error.retryable,
  );
  assert.equal(sourceCalls, 1);
  assert.equal(scanCalls, 1);
  assert.equal(durablePreviewImportsEnabled({ ...enabledEnv, VERCEL_ENV: "production" }), false);
});

test("strict synthetic Preview CSV policy accepts only example.test and SYNTH identities", () => {
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from(
    "Employee ID,Member ID,Work Email,First Name\nSYNTH-E-1,SYNTH-M-1,one@example.test,Synthetic",
  ), "text/csv", "safe.csv"), true);
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from(
    "Employee ID,Work Email\nSYNTH-E-1,person@example.com",
  ), "text/csv", "unsafe.csv"), false);
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from(
    "Employee ID,Member ID,Work Email\nREAL-EMPLOYEE,SYNTH-M-1,person@example.test",
  ), "text/csv", "unsafe.csv"), false);
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from(
    "Employee ID,Member ID,Work Email\nSYNTH-E-1,REAL-MEMBER,person@example.test",
  ), "text/csv", "unsafe.csv"), false);
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from(
    "Employee ID,Employee ID,Work Email\nREAL-EMPLOYEE,SYNTH-E-1,person@example.test",
  ), "text/csv", "unsafe.csv"), false);
  assert.equal(isStrictSyntheticPreviewCsv(Buffer.from("Employee ID,Work Email\n,missing@example.test"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "unsafe.xlsx"), false);
});

test("worker preserves clean, malicious, temporary, and terminal scanner behavior", async () => {
  const source = { id: "source", plaintext: Buffer.from("Employee ID,Work Email\nSYNTH-1,one@example.test"),
    mediaType: "text/csv", originalFilename: "synthetic.csv", sha256: "a".repeat(64) };
  const query = async (sql) => {
    if (sql.includes("SELECT state, workflow_run_id, processing_version")) {
      return [{ state: "running", workflow_run_id: "run-A", processing_version: "local801-import-v1" }];
    }
    if (sql.includes("UPDATE local801.import_batches")) return [{ processing_stage: "scanning" }];
    if (sql.includes("UPDATE local801.import_files")) return [{ id: "source" }];
    return [];
  };
  const dependencies = (outcome) => ({
    query,
    loadSource: async () => source,
    scanner: { scan: async () => ({ outcome }) },
  });
  assert.deepEqual(await scanImportSource(input, "run-A", dependencies("clean")), { result: "clean" });
  await assert.rejects(scanImportSource(input, "run-A", dependencies("malicious")),
    (error) => error instanceof ImportWorkerError && error.code === "MALWARE_REJECTED" && !error.retryable);
  await assert.rejects(scanImportSource(input, "run-A", dependencies("temporary_failure")),
    (error) => error instanceof ImportWorkerError && error.code === "SCANNER_TEMPORARY_FAILURE" && error.retryable);
  await assert.rejects(scanImportSource(input, "run-A", dependencies("terminal_scanner_failure")),
    (error) => error instanceof ImportWorkerError && error.code === "SCANNER_UNAVAILABLE" && !error.retryable);
});

test("durable worker safely parses and stages multiple XLSX sheets after scanning", async () => {
  const statements = [];
  const bytes = await durableXlsxBytes();
  const query = async (sql) => {
    if (sql.includes("SELECT state, workflow_run_id, processing_version")) {
      return [{ state: "running", workflow_run_id: "run-A", processing_version: "local801-import-v1" }];
    }
    if (sql.includes("RETURNING batch.processing_stage")) return [{ processing_stage: "parsing" }];
    if (sql.includes("SELECT count(*)::int AS row_count FROM local801.import_rows")) return [{ row_count: 1 }];
    return [];
  };
  const result = await parseAndStageImport(input, "run-A", {
    env: enabledEnv,
    query,
    transaction: async (pending) => statements.push(...pending),
    loadSource: async () => ({
      id: "00000000-0000-4000-8000-000000000004",
      plaintext: bytes,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      originalFilename: "synthetic.xlsx",
      sha256: "a".repeat(64),
    }),
  });
  assert.deepEqual(result, { totalRows: 2, includedRows: 1, excludedRows: 1 });
  const sheetWrites = statements.filter((statement) => statement.sql.includes("INSERT INTO local801.import_sheets"));
  assert.equal(sheetWrites.length, 3);
  assert.deepEqual(sheetWrites.map((statement) => statement.parameters[4]), ["included", "included", "notes_review"]);
  const rowWrites = statements.filter((statement) => statement.sql.includes("INSERT INTO local801.import_rows"));
  assert.equal(rowWrites.length, 1);
  assert.match(rowWrites[0].parameters[2], /SYNTH-E-1/);
  assert.doesNotMatch(rowWrites[0].parameters[2], /SYNTH-E-2/);
});

test("starter uses the durable Preview gate", async () => {
  let startedInput;
  const query = async () => [{
    organization_id: organizationId, processing_stage: "queued", job_state: "queued",
    workflow_run_id: null, processing_version: "local801-import-v1", source_count: 1, supported_source_count: 1,
  }];
  const result = await startQueuedImportWorkflow(organizationId, batchId, {
    query, env: enabledEnv,
    startWorkflow: async (value) => { startedInput = value; return { runId: "run-starter" }; },
  });
  assert.deepEqual(startedInput, input);
  assert.deepEqual(Object.keys(startedInput), ["organizationId", "batchId"]);
  assert.deepEqual(result, { batchId, workflowRunId: "run-starter" });
});

test("starter fails closed for missing, ambiguous, unsupported, or non-queued sources", async () => {
  const state = { organization_id: organizationId, processing_stage: "queued", job_state: "queued",
    workflow_run_id: null, processing_version: "local801-import-v1", source_count: 1, supported_source_count: 1 };
  const startWorkflow = async () => ({ runId: "must-not-start" });
  for (const patch of [
    { source_count: 0, supported_source_count: 0 },
    { source_count: 2, supported_source_count: 2 },
    { source_count: 1, supported_source_count: 0 },
    { job_state: "running", workflow_run_id: "other-run" },
  ]) {
    await assert.rejects(startQueuedImportWorkflow(organizationId, batchId, {
      query: async () => [{ ...state, ...patch }], env: enabledEnv, startWorkflow,
    }));
  }
});

test("strictly synthetic durable Preview CSV acceptance succeeds", async () => {
  const statements = [];
  const file = new File([
    "Local #,Employee ID,Work Email,First Name,Last Name\n801,SYNTH-E-1,one@example.test,Synthetic,Member",
  ], "synthetic.csv", { type: "text/csv" });
  const result = await acceptDurablePreviewImport({
    actor: { organizationId, userId: "00000000-0000-4000-8000-000000000003", role: "local_admin" },
    file,
    importKind: "current_roster",
    dependencies: {
      env: enabledEnv,
      id: () => batchId,
      query: async (sql, parameters) => {
        if (!sql.includes("INSERT INTO local801.import_batches")) return [];
        assert.equal(parameters[1], organizationId);
        return [{ id: batchId }];
      },
      transaction: async (pending) => statements.push(...pending),
      storeFile: async () => ({ id: "00000000-0000-4000-8000-000000000004", storageKey: "opaque",
        sha256: "a".repeat(64), encryptionKeyVersion: "v1", byteSize: file.size }),
      startWorkflow: async () => { throw new Error("synthetic start outage"); },
    },
  });
  assert.equal(result.workflowStarted, false);
  assert.equal(result.processingStage, "queued");
  assert.equal(result.statusLocation, `/imports/${batchId}`);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /INSERT INTO local801\.import_processing_jobs/);
  assert.doesNotMatch(JSON.stringify(result), /storage|encrypt|email|name/i);
});

test("durable Preview CSV acceptance rejects non-synthetic identities", async () => {
  let storageCalls = 0;
  let workflowCalls = 0;
  const file = new File([
    "Local #,Employee ID,Work Email\n801,SYNTH-E-1,one@example.com",
  ], "real-identity.csv", { type: "text/csv" });
  await assert.rejects(acceptDurablePreviewImport({
    actor: {
      organizationId,
      userId: "00000000-0000-4000-8000-000000000003",
      role: "local_admin",
    },
    file,
    importKind: "current_roster",
    dependencies: {
      env: enabledEnv,
      storeFile: async () => { storageCalls += 1; throw new Error("must not store"); },
      startWorkflow: async () => { workflowCalls += 1; throw new Error("must not start"); },
    },
  }));
  assert.equal(storageCalls, 0);
  assert.equal(workflowCalls, 0);
});

test("Production cannot use the durable Preview acceptance path", async () => {
  let storageCalls = 0;
  const file = new File([
    "Local #,Employee ID,Work Email\n801,SYNTH-E-1,one@example.test",
  ], "synthetic.csv", { type: "text/csv" });
  await assert.rejects(acceptDurablePreviewImport({
    actor: { organizationId, userId: "00000000-0000-4000-8000-000000000003", role: "local_admin" },
    file,
    importKind: "current_roster",
    dependencies: {
      env: { ...enabledEnv, VERCEL_ENV: "production" },
      storeFile: async () => { storageCalls += 1; throw new Error("must not store"); },
    },
  }));
  assert.equal(storageCalls, 0);
});

test("durable Preview accepts an opaque XLSX for scanning without opening it first", async () => {
  const transactions = [];
  const file = new File(["not-opened-before-scan"], "synthetic.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const result = await acceptDurablePreviewImport({
    actor: { organizationId, userId: "00000000-0000-4000-8000-000000000003", role: "local_admin" },
    file,
    importKind: "current_roster",
    dependencies: {
      env: enabledEnv,
      id: () => batchId,
      query: async (sql) => sql.includes("INSERT INTO local801.import_batches") ? [{ id: batchId }] : [],
      transaction: async (pending) => transactions.push(...pending),
      storeFile: async (inputFile) => {
        assert.equal(inputFile.mediaType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        return { id: "00000000-0000-4000-8000-000000000004", storageKey: "opaque",
          sha256: "a".repeat(64), encryptionKeyVersion: "v1", byteSize: file.size };
      },
      startWorkflow: async () => ({ batchId, workflowRunId: "run-xlsx" }),
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.workflowStarted, true);
  assert.equal(transactions.length, 2);
  assert.match(JSON.stringify(transactions), /durable_xlsx/);
});

test("safe failure mapping never persists raw exceptions", () => {
  assert.equal(safeImportWorkerErrorCode(new ImportWorkerError("MALWARE_REJECTED")), "MALWARE_REJECTED");
  assert.equal(safeImportWorkerErrorCode(new Error("password=secret postgres failure")), "INTERNAL_PROCESSING_FAILURE");
});

test("workflow uses trusted metadata, meaningful steps, and exits duplicate owner before source work", async () => {
  const source = await readFile(new URL("../src/workflows/process-import.ts", import.meta.url), "utf8");
  assert.match(source, /"use workflow"/);
  assert.match(source, /getWorkflowMetadata\(\)/);
  assert.match(source, /workflowRunId/);
  assert.match(source, /ownership === "not_owner"\) return/);
  assert.ok(source.indexOf("ownership === \"not_owner\"") < source.indexOf("await scanSourceStep(input"));
  for (const step of ["ensureJobStep", "scanSourceStep", "parseAndStageStep", "validateStagedStep",
    "matchIdentitiesStep", "prepareReviewStep", "completeProcessingStep"]) {
    assert.match(source, new RegExp(`function ${step}\\([\\s\\S]*?"use step"`));
  }
  assert.doesNotMatch(source, /start\([^)]*workflowRunId/);
  assert.doesNotMatch(source.match(/function throwForStep[\s\S]*?\n}/)?.[0] ?? "", /throw error;/);
});

test("workflow failure persistence survives a failed cancellation probe", async () => {
  const source = await readFile(new URL("../src/workflows/process-import.ts", import.meta.url), "utf8");
  const catchBlock = source.slice(source.lastIndexOf("} catch (error) {"));
  assert.match(catchBlock, /try\s*\{[\s\S]*cancellationStep[\s\S]*\}\s*catch\s*\{[\s\S]*\}/);
  assert.match(catchBlock, /catch\s*\{[\s\S]*safeImportProcessingCodeFromWorkflowError\(error\)[\s\S]*recordFailureStep/);
});

test("worker SQL is chunked, monotonic, replay-safe, tenant-scoped, and contains no Phase 2B-2 writes", async () => {
  const source = await readFile(new URL("../src/lib/import-worker.ts", import.meta.url), "utf8");
  assert.match(source, /IMPORT_STAGE_CHUNK_SIZE = 500/);
  assert.match(source, /GREATEST\(COALESCE\(batch\.processed_row_count, 0\), \$3\)/);
  assert.match(source, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(source, /deterministicUuid/);
  assert.match(source, /file\.organization_id = \$1 AND file\.import_batch_id = \$2/);
  assert.match(source, /count\(\*\) FROM local801\.import_files/);
  for (const table of ["people", "person_identifiers", "person_contact_methods", "membership_events",
    "employment_events", "membership_snapshots", "membership_snapshot_rows", "import_approvals"]) {
    assert.doesNotMatch(source, new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+local801\\.${table}\\b`, "i"));
  }
});

test("upload route retains same-origin/auth/workspace protection and protected mode requires scanner-backed durable imports", async () => {
  const route = await readFile(new URL("../src/app/api/imports/validate/route.ts", import.meta.url), "utf8");
  const form = await readFile(new URL("../src/components/ImportPreviewForm.tsx", import.meta.url), "utf8");
  assert.match(route, /hasExactSameOrigin\(request\)/);
  assert.match(route, /requirePreviewUser\("manageImports"\)/);
  assert.match(route, /resolveWorkspaceContext\(auth\.user\)/);
  assert.match(route, /const processingMode = form\.get\("processingMode"\)/);
  assert.match(route, /processingMode === "durable" \|\| processingMode === "durable_preview"/);
  assert.match(route, /status: 202/);
  assert.match(route, /\[local801-import-safe-failure\][\s\S]*code: failure\.code,[\s\S]*status: failure\.status/);
  assert.match(route, /stage: error instanceof ControlledImportError \? error\.safeStage : null/);
  assert.doesNotMatch(route, /\[local801-import-safe-failure\][^\n]*(?:error\.message|error\.stack|request|file)/);
  assert.match(route, /LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1"/);
  assert.match(route, /PROTECTED_DURABLE_IMPORT_REQUIRED/);
  assert.ok(route.indexOf("PROTECTED_DURABLE_IMPORT_REQUIRED") < route.indexOf("persistImportReview"));
  assert.match(form, /defaultValue="durable"/);
  assert.match(form, /Secure background processing/);
  assert.match(form, /Legacy fallback · pre-cutover only/);
});

test("durable acceptance reports only fixed safe failure stages", async () => {
  const source = await readFile(new URL("../src/lib/import-async-acceptance.ts", import.meta.url), "utf8");
  assert.match(source, /"availability"/);
  assert.match(source, /"batch_actor_resolution"/);
  assert.match(source, /"encrypted_storage"/);
  assert.match(source, /"queue_and_audit"/);
  assert.doesNotMatch(source, /safeStage[\s\S]*(?:input\.file\.name|error\.message|error\.stack)/);
});

test("oversized workbook structures get actionable safe guidance", async () => {
  const worker = await readFile(new URL("../src/lib/import-worker.ts", import.meta.url), "utf8");
  assert.match(worker, /entry_size_exceeded[\s\S]*total_size_exceeded[\s\S]*compression_ratio_exceeded/);
  assert.match(worker, /ImportWorkerError\("WORKBOOK_STRUCTURE_TOO_LARGE"\)/);
});
