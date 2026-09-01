import { expect, test } from "@playwright/test";
import {
  applyPhaseResults,
  createBaseProofReport,
  markRemainingPhasesSkipped,
  renderProofSummary,
} from "../scripts/lib/proof-artifacts.mjs";

test.describe("proof artifact reporting", () => {
  test("renders a human-readable passing summary with durable artifact paths", () => {
    const report = createBaseProofReport({
      repoName: "cyang-doclinks",
      proofCommand: "npm run prove:build",
      dockerProofRun: false,
      nodeVersion: "22.19.0",
      npmVersion: "10.9.2",
      gitCommitHash: "abc123",
      notProven: ["live Postgres connectivity"],
    });

    report.installVerification.status = "passed";
    report.installVerification.durationMs = 25;
    report.preflight.status = "passed";
    report.preflight.durationMs = 50;
    report.finalStatus = "passed";
    applyPhaseResults(report, [
      { label: "Lint", status: 0, durationMs: 100 },
      { label: "Typecheck", status: 0, durationMs: 200 },
      { label: "Production build", status: 0, durationMs: 300 },
      { label: "Regression tests", status: 0, durationMs: 400 },
      { label: "Bundle budget audit", status: 0, durationMs: 50 },
      { label: "Production readiness", status: 0, durationMs: 60 },
    ]);

    const summary = renderProofSummary(report);

    expect(summary).toContain("Status: PASSED");
    expect(summary).toContain("proof-report.json");
    expect(summary).toContain("prove-build.log");
    expect(summary).toContain("Regression tests: PASSED");
    expect(summary).toContain("live Postgres connectivity");
  });

  test("marks later phases skipped after an earlier failure", () => {
    const report = createBaseProofReport({
      repoName: "cyang-doclinks",
      proofCommand: "npm run prove:build",
      dockerProofRun: true,
      nodeVersion: "22.19.0",
      npmVersion: "10.9.2",
      notProven: [],
    });

    applyPhaseResults(report, [
      { label: "Lint", status: 0, durationMs: 100 },
      { label: "Typecheck", status: 1, durationMs: 200 },
    ]);
    markRemainingPhasesSkipped(report, "Typecheck", "not run after earlier proof failure");

    const buildPhase = report.phases.find((phase) => phase.id === "build");
    const testsPhase = report.phases.find((phase) => phase.id === "tests");

    expect(buildPhase?.status).toBe("skipped");
    expect(buildPhase?.reason).toContain("earlier proof failure");
    expect(testsPhase?.status).toBe("skipped");
  });
});
