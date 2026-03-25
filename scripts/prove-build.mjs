#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { runCheckPlan } from "./lib/check-runner.mjs";
import { evaluateProofRuntime } from "./lib/proof-baseline.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

const REQUIRED_NODE = "22.16.0";
const REQUIRED_NPM = "10.9.2";
const PACKAGE_NODE_ENGINE = ">=22.16.0 <25";
const PACKAGE_NPM_ENGINE = ">=10.9.2 <12";

function fail(message) {
  console.error(`Build proof preflight failed: ${message}`);
  process.exit(1);
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

await withProofLock({ label: "prove:build" }, async () => {
  ensureBaselineVersions();
  cleanProofArtifacts();
  ensureProofEnv();

  const commands = [
    { label: "Lint", command: "npm", args: ["run", "lint"] },
    { label: "Typecheck", command: "npm", args: ["run", "typecheck"] },
    { label: "Production build", command: "npm", args: ["run", "build"] },
    {
      label: "Regression tests",
      command: "npm",
      args: ["test", "--", "--runInBand", "--require-existing-build"],
    },
    { label: "Bundle budget audit", command: "npm", args: ["run", "audit:bundle-budgets"] },
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
    },
  ];

  runCheckPlan({
    title: "Build proof",
    steps: commands.map((step) => ({
      ...step,
      spawnFailureMessage:
        `could not spawn "${step.command} ${step.args.join(" ")}" in the current Windows sandbox. ` +
        "Rerun prove:build outside the sandbox or grant broader process-spawn permissions.",
    })),
  });

  console.log("\nBuild proof sequence passed.");
});
