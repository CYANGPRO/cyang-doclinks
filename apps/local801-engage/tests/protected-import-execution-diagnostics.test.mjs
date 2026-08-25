import assert from "node:assert/strict";
import test from "node:test";

import {
  createProtectedImportExecutionSupportReference,
  safeProtectedImportExecutionDiagnostic,
} from "../src/lib/protected-import-execution-diagnostics.ts";
import { actionProblemFor } from "../src/lib/user-facing-errors.ts";

test("protected import diagnostics retain only allowlisted non-PII fields", () => {
  const error = Object.assign(new Error("duplicate member jane@example.test employee 12345"), {
    code: "23505",
    detail: "member email and encrypted payload",
    query: "insert into people values (...) ",
    parameters: ["jane@example.test", "12345"],
  });
  const diagnostic = safeProtectedImportExecutionDiagnostic(
    "atomic-apply",
    error,
    "IMPORT_EXECUTION_A1B2C3D4E5F6",
  );
  assert.deepEqual(diagnostic, {
    event: "local801-protected-import-safe-failure",
    stage: "atomic-apply",
    category: "database",
    code: "SQLSTATE_23505",
    supportReference: "IMPORT_EXECUTION_A1B2C3D4E5F6",
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /jane|example\.test|12345|member email|insert into|parameters/i);
});

test("protected import diagnostics classify timeouts without copying error messages", () => {
  const error = Object.assign(new Error("member-specific timeout detail"), { name: "TimeoutError" });
  const diagnostic = safeProtectedImportExecutionDiagnostic(
    "preparation",
    error,
    "IMPORT_EXECUTION_001122AABBCC",
  );
  assert.equal(diagnostic.category, "timeout");
  assert.equal(diagnostic.code, "OPERATION_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(diagnostic), /member-specific/i);
});

test("protected import diagnostics fail closed for hostile error objects", () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("sensitive getter payload");
    },
  });
  const diagnostic = safeProtectedImportExecutionDiagnostic(
    "atomic-apply",
    hostile,
    "IMPORT_EXECUTION_ABCDEF123456",
  );
  assert.equal(diagnostic.category, "unknown");
  assert.equal(diagnostic.code, "UNKNOWN_THROWABLE");
  assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive getter/i);
});

test("protected import support references are opaque and bounded", () => {
  assert.match(createProtectedImportExecutionSupportReference(), /^IMPORT_EXECUTION_[0-9A-F]{12}$/);
});

test("protected import recovery messaging explains rollback and preserves the support reference", () => {
  const problem = actionProblemFor(
    "The protected import was not committed. No roster changes were applied. Support reference: IMPORT_EXECUTION_A1B2C3D4E5F6",
  );
  assert.equal(problem.title, "CAT reversed the import before it changed the roster");
  assert.equal(problem.reference, "IMPORT_EXECUTION_A1B2C3D4E5F6");
  assert.match(problem.description, /no roster changes were saved/i);
  assert.ok(problem.steps.some((step) => /Do not upload the file again/i.test(step)));
});

test("protected roster count mismatches use a specific safe reconciliation message", () => {
  const problem = actionProblemFor(
    "The protected import was not committed because the applied roster did not exactly match the reviewed set. No roster changes were applied.",
  );
  assert.equal(problem.title, "The applied roster did not match the review");
  assert.equal(problem.reference, "ATOMIC_RECONCILIATION_FAILED");
  assert.match(problem.description, /reversed the whole update/i);
  assert.doesNotMatch(JSON.stringify(problem), /division|SQLSTATE/i);
});
