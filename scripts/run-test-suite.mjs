#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { getPlaywrightInstallInvocation } from "./lib/playwright-runtime.mjs";
import { listSuiteFiles } from "./lib/test-suites.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

function resolveSpawn(command, args) {
  if (process.platform === "win32" && command === "npm") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

function quoteArg(arg) {
  if (!/[ \t"]/u.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

function getProductionBuildState() {
  const requiredFiles = [
    ".next/BUILD_ID",
    ".next/build-manifest.json",
    ".next/server/app-paths-manifest.json",
    ".next/server/pages-manifest.json",
  ];
  const missingFiles = requiredFiles.filter((file) => !existsSync(file));
  return {
    usable: missingFiles.length === 0,
    missingFiles,
  };
}

function failSpawn(error, command, args) {
  if (process.platform === "win32" && error && typeof error === "object" && "code" in error && error.code === "EPERM") {
    console.error(
      `Unable to spawn "${command} ${args.join(" ")}" on Windows in the current sandboxed environment. ` +
        "Rerun the command outside the sandbox or grant broader process-spawn permissions."
    );
    process.exit(1);
  }
  throw error;
}

function run(command, args) {
  const resolved = resolveSpawn(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.error) failSpawn(result.error, command, args);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await withProofLock({ label: "run-test-suite" }, async () => {
  const forwardedArgs = [];
  let requireExistingBuild = false;
  let profile = "local-safe";

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length).trim() || "local-safe";
      continue;
    }
    if (arg === "--runInBand") {
      forwardedArgs.push("--workers=1");
      continue;
    }
    if (arg === "--require-existing-build") {
      requireExistingBuild = true;
      continue;
    }
    forwardedArgs.push(arg);
  }

  const explicitSpecArgs = forwardedArgs.filter((arg) => /\.spec\.(ts|tsx|js|jsx|mts|mjs)$/u.test(arg));
  const suiteFiles = explicitSpecArgs.length > 0 ? [] : listSuiteFiles(profile);
  const effectiveArgs = explicitSpecArgs.length > 0 ? forwardedArgs : [...forwardedArgs, ...suiteFiles];

  const playwrightCommand =
    effectiveArgs.length > 0
      ? `npm run test:playwright -- ${effectiveArgs.map(quoteArg).join(" ")}`
      : "npm run test:playwright";

  if (!existsSync(".env.local") && existsSync(".env.example") && process.env.SKIP_ENV_LOCAL_BOOTSTRAP !== "1") {
    copyFileSync(".env.example", ".env.local");
    console.log("Prepared .env.local from .env.example for the test run.");
  }

  const playwrightInstall = getPlaywrightInstallInvocation();
  console.log(`Ensuring ${playwrightInstall.scope} is installed before the Playwright-backed suite.`);
  run(playwrightInstall.command, playwrightInstall.args);

  const buildState = getProductionBuildState();
  if (!buildState.usable) {
    if (requireExistingBuild) {
      console.error(
        "No reusable production build detected and --require-existing-build was set. " +
          `Missing build artifacts: ${buildState.missingFiles.join(", ")}. ` +
          "Run `npm run build` first so the test run reuses the exact artifact under proof."
      );
      process.exit(1);
    }
    console.log(
      "No reusable production build detected. " +
        `Missing build artifacts: ${buildState.missingFiles.join(", ")}. ` +
        "Running `npm run build` before the Playwright-backed suite."
    );
    run("npm", ["run", "build"]);
  } else {
    console.log("Using existing production build for the Playwright-backed test run.");
  }

  if (explicitSpecArgs.length === 0) {
    console.log(`Running Playwright suite profile: ${profile}`);
  }

  run("npm", [
    "exec",
    "--no",
    "--",
    "start-server-and-test",
    "npm run start",
    "http://127.0.0.1:3000",
    playwrightCommand,
  ]);
});
