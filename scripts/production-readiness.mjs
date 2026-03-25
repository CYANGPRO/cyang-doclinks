#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCheckPlan } from "./lib/check-runner.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

const SUMMARY_DIR = join(process.cwd(), ".tmp");
const RELEASE_GATE_SUMMARY_PATH = join(SUMMARY_DIR, "release-gate-summary.json");
const args = new Set(process.argv.slice(2));

const skipLint = args.has("--skip-lint");
const skipTypecheck = args.has("--skip-typecheck");
const skipBuild = args.has("--skip-build");
const skipBundleBudgets = args.has("--skip-bundle-budgets");

await withProofLock({ label: "production-readiness" }, async () => {
  if (!existsSync(SUMMARY_DIR)) {
    mkdirSync(SUMMARY_DIR, { recursive: true });
  }

  const commands = [
    { label: "Env template audit", command: "npm", args: ["run", "audit:env-example"] },
    { label: "Migration manifest verify", command: "node", args: ["scripts/migrate.mjs", "verify"] },
    { label: "Admin route audit", command: "npm", args: ["run", "audit:admin-routes"] },
    { label: "Admin polling audit", command: "npm", args: ["run", "audit:admin-polling"] },
    { label: "Public rendering audit", command: "npm", args: ["run", "audit:public-rendering"] },
    { label: "Route-handler audit", command: "npm", args: ["run", "audit:route-handlers"] },
    { label: "Polling audit", command: "npm", args: ["run", "audit:polling"] },
    ...(skipLint ? [] : [{ label: "Lint", command: "npm", args: ["run", "lint"] }]),
    ...(skipTypecheck ? [] : [{ label: "Typecheck", command: "npm", args: ["run", "typecheck"] }]),
    ...(skipBuild ? [] : [{ label: "Production build", command: "npm", args: ["run", "build"] }]),
    ...(skipBundleBudgets ? [] : [{ label: "Bundle budget audit", command: "npm", args: ["run", "audit:bundle-budgets"] }]),
    { label: "Production dependency audit", command: "npm", args: ["audit", "--omit=dev", "--audit-level=high"] },
    {
      label: "Release gate",
      command: "node",
      args: [
        "scripts/release-gate.mjs",
        "--allow-missing-env",
        "--summary-json",
        RELEASE_GATE_SUMMARY_PATH,
      ],
    },
  ];

  runCheckPlan({
    title: "Production readiness",
    steps: commands,
  });

  let releaseGateSummary = null;
  try {
    releaseGateSummary = JSON.parse(readFileSync(RELEASE_GATE_SUMMARY_PATH, "utf8"));
  } catch {
    releaseGateSummary = null;
  }

  console.log("\nProduction readiness verdict:");
  console.log("- Repo/build proof: passed");
  if (skipLint || skipTypecheck || skipBuild || skipBundleBudgets) {
    const reused = [
      skipLint ? "lint" : null,
      skipTypecheck ? "typecheck" : null,
      skipBuild ? "build" : null,
      skipBundleBudgets ? "bundle-budgets" : null,
    ].filter(Boolean);
    console.log(`- Reused prior proof steps: ${reused.join(", ")}`);
  }
  if (!releaseGateSummary) {
    console.log("- Live runtime gate: not reported");
  } else if (releaseGateSummary.runtimeEnvAudit === "skipped") {
    console.log("- Live runtime gate: skipped (deployment env not detected)");
    console.log("- What was not proven: live runtime configuration and live migration status");
  } else {
    console.log(`- Live runtime gate: ${releaseGateSummary.ok ? "passed" : "failed"}`);
    console.log(`- Migration status: ${releaseGateSummary.migrationStatus}`);
  }

  console.log("\nProduction readiness validation passed.");
});
