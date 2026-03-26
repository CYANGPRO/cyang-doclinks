#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { CheckPlanError, runCheckPlan } from "./lib/check-runner.mjs";
import { assertProofCliEntrypointsWork, assertProofToolingInstalled } from "./lib/proof-install.mjs";
import { evaluateProofRuntime } from "./lib/proof-baseline.mjs";
import {
  applyPhaseResults,
  createBaseProofReport,
  ensureProofArtifactDir,
  getGitCommitHash,
  markRemainingPhasesSkipped,
  PROOF_ARTIFACT_PATHS,
  startProofLogCapture,
  writeProofArtifacts,
} from "./lib/proof-artifacts.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

const REQUIRED_NODE = "22.16.0";
const REQUIRED_NPM = "10.9.2";
const PACKAGE_NODE_ENGINE = ">=22.16.0 <25";
const PACKAGE_NPM_ENGINE = ">=10.9.2 <12";
const NOT_PROVEN = [
  "live Postgres connectivity",
  "Cloudflare R2 connectivity",
  "Stripe delivery from the live service",
  "email provider delivery",
  "malware scanning endpoints",
  "deployed-secret wiring",
];

function fail(message) {
  throw new Error(`Build proof preflight failed: ${message}`);
}

function ensureBaselineVersions() {
  const nodeVersion = process.version.replace(/^v/, "");

  const npmVersionResult = spawnSync(process.platform === "win32" ? "cmd.exe" : "npm", process.platform === "win32" ? ["/d", "/s", "/c", "npm", "--version"] : ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: process.env,
    encoding: "utf8",
  });
  if (npmVersionResult.error || npmVersionResult.status !== 0) {
    if (process.platform === "win32" && npmVersionResult.error?.code === "EPERM") {
      fail("npm --version could not be spawned in the current Windows sandbox. Rerun prove:build outside the sandbox or grant broader process-spawn permissions.");
    }
    fail("npm --version could not be resolved. Install npm 10.9.2 and rerun the proof command.");
  }

  const npmVersion = String(npmVersionResult.stdout || "").trim();
  const evaluation = evaluateProofRuntime({
    actualNodeVersion: nodeVersion,
    actualNpmVersion: npmVersion,
    requiredNodeVersion: REQUIRED_NODE,
    requiredNpmVersion: REQUIRED_NPM,
    nodeEngineRange: PACKAGE_NODE_ENGINE,
    npmEngineRange: PACKAGE_NPM_ENGINE,
  });

  if (!evaluation.engineCompatible) {
    fail(
      `expected Node.js ${PACKAGE_NODE_ENGINE} and npm ${PACKAGE_NPM_ENGINE}, ` +
      `but found Node.js ${nodeVersion} and npm ${npmVersion}. ` +
      "Use an engine-compatible runtime before running prove:build."
    );
  }

  if (!evaluation.exactPinned) {
    console.warn(
      `Build proof preflight warning: running on Node.js ${nodeVersion} / npm ${npmVersion} instead of the pinned baseline ` +
      `${REQUIRED_NODE} / ${REQUIRED_NPM}. The proof run will continue because the runtime is engine-compatible.`
    );
  }

  return { nodeVersion, npmVersion };
}

function ensureProofEnv() {
  if (existsSync(".env.local")) return;
  if (!existsSync(".env.example")) {
    fail("missing .env.example. The proof flow relies on the committed template to prepare .env.local.");
  }
  copyFileSync(".env.example", ".env.local");
  console.log("Prepared .env.local from .env.example for this proof run.");
}

function cleanProofArtifacts() {
  if (!existsSync(".next")) return;
  rmSync(".next", { recursive: true, force: true });
  console.log("Removed existing .next so prove:build runs from a clean production build.");
}

ensureProofArtifactDir();
const stopLogCapture = startProofLogCapture(PROOF_ARTIFACT_PATHS.logPath);
const proofReport = createBaseProofReport({
  repoName: "cyang-doclinks",
  proofCommand: "npm run prove:build",
  dockerProofRun: process.env.PROOF_DOCKER_BUILD === "1",
  nodeVersion: process.version.replace(/^v/, ""),
  gitCommitHash: getGitCommitHash(),
  notProven: NOT_PROVEN,
});

let exitCode = 1;

try {
  console.log(`Writing proof artifacts to ${proofReport.artifactPaths.report}, ${proofReport.artifactPaths.summary}, and ${proofReport.artifactPaths.log}`);

  await withProofLock({ label: "prove:build" }, async () => {
    const installCheckStartedAt = Date.now();
    try {
      assertProofToolingInstalled();
      assertProofCliEntrypointsWork();
      proofReport.installVerification.status = "passed";
      proofReport.installVerification.durationMs = Date.now() - installCheckStartedAt;
    } catch (error) {
      proofReport.installVerification.status = "failed";
      proofReport.installVerification.durationMs = Date.now() - installCheckStartedAt;
      proofReport.installVerification.message = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const preflightStartedAt = Date.now();
    try {
      const versions = ensureBaselineVersions();
      proofReport.nodeVersion = versions.nodeVersion;
      proofReport.npmVersion = versions.npmVersion;
      cleanProofArtifacts();
      ensureProofEnv();
      proofReport.preflight.status = "passed";
      proofReport.preflight.durationMs = Date.now() - preflightStartedAt;
    } catch (error) {
      proofReport.preflight.status = "failed";
      proofReport.preflight.durationMs = Date.now() - preflightStartedAt;
      proofReport.preflight.message = error instanceof Error ? error.message : String(error);
      throw error;
    }

    const commands = [
      { label: "Lint", command: "npm", args: ["run", "lint"], timeoutMs: 10 * 60 * 1000 },
      { label: "Typecheck", command: "npm", args: ["run", "typecheck"], timeoutMs: 15 * 60 * 1000 },
      { label: "Production build", command: "npm", args: ["run", "build"], timeoutMs: 30 * 60 * 1000 },
      {
        label: "Regression tests",
        command: "npm",
        args: ["test", "--", "--runInBand", "--require-existing-build"],
        timeoutMs: 45 * 60 * 1000,
      },
      { label: "Bundle budget audit", command: "npm", args: ["run", "audit:bundle-budgets"], timeoutMs: 10 * 60 * 1000 },
      {
        label: "Production readiness",
        command: "node",
        args: [
          "scripts/production-readiness.mjs",
          "--skip-lint",
          "--skip-typecheck",
          "--skip-build",
          "--skip-bundle-budgets",
        ],
        timeoutMs: 20 * 60 * 1000,
      },
    ];

    const results = await runCheckPlan({
      title: "Build proof",
      exitOnFailure: false,
      steps: commands.map((step) => ({
        ...step,
        spawnFailureMessage:
          `could not spawn "${step.command} ${step.args.join(" ")}" in the current Windows sandbox. ` +
          "Rerun prove:build outside the sandbox or grant broader process-spawn permissions.",
      })),
    });

    applyPhaseResults(proofReport, results);
  });

  proofReport.finalStatus = "passed";
  exitCode = 0;
  console.log("\nBuild proof sequence passed.");
  console.log("Locally proven: lint, typecheck, production build, deterministic regression tests, bundle budgets, and repo release/readiness audits.");
  console.log(`Not proven here: ${NOT_PROVEN.join(", ")}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CheckPlanError) {
    applyPhaseResults(proofReport, error.results);
    markRemainingPhasesSkipped(proofReport, error.failedStep, "not run after earlier proof failure");
    proofReport.failurePhase = error.failedStep;
    proofReport.failureMessage = error.failureDetail ? `${message}. ${error.failureDetail}` : message;
    exitCode = error.exitCode ?? 1;
  } else {
    proofReport.failureMessage = message;
    exitCode = 1;
  }

  if (proofReport.installVerification.status === "pending") {
    proofReport.installVerification.status = "failed";
    proofReport.installVerification.message = message;
  } else if (proofReport.preflight.status === "pending") {
    proofReport.preflight.status = "failed";
    proofReport.preflight.message = message;
  }

  proofReport.finalStatus = "failed";
  console.error(`Build proof failed: ${message}`);
} finally {
  try {
    writeProofArtifacts(proofReport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write proof artifacts: ${message}`);
    proofReport.finalStatus = "failed";
    proofReport.failureMessage = proofReport.failureMessage
      ? `${proofReport.failureMessage}; artifact write failure: ${message}`
      : `artifact write failure: ${message}`;
    exitCode = 1;
  }

  console.log(`Proof JSON report: ${proofReport.artifactPaths.report}`);
  console.log(`Proof summary: ${proofReport.artifactPaths.summary}`);
  console.log(`Proof log: ${proofReport.artifactPaths.log}`);

  await stopLogCapture();
  process.exit(exitCode);
}
