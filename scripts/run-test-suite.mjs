#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { getPlaywrightInstallInvocation } from "./lib/playwright-runtime.mjs";
import { spawnRepoTool } from "./lib/repo-tooling.mjs";
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
  const result =
    command === "repo-tool"
      ? spawnRepoTool(args[0], args.slice(1), {
          stdio: "inherit",
          env: process.env,
        })
      : (() => {
          const resolved = resolveSpawn(command, args);
          return spawnSync(resolved.command, resolved.args, {
            stdio: "inherit",
            shell: false,
            env: process.env,
          });
        })();
  if (result.error) failSpawn(result.error, command, args);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The production server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production server did not become ready at ${url} within ${timeoutMs}ms.`);
}

function stopServerTree(server) {
  if (!server?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    try {
      server.kill("SIGTERM");
    } catch {
      // The server already stopped.
    }
  }
}

async function runPlaywrightWithManagedServer(args) {
  const resolved = resolveSpawn("npm", ["run", "start"]);
  const server = spawn(resolved.command, resolved.args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let spawnError = null;
  server.once("error", (error) => {
    spawnError = error;
  });

  let result;
  try {
    await waitForServer("http://127.0.0.1:3000");
    if (spawnError) failSpawn(spawnError, resolved.command, resolved.args);
    result = spawnRepoTool("playwright", ["test", ...args], {
      stdio: "inherit",
      // Keep source-level helper tests in an explicit test environment while
      // the separately spawned Next server continues to run its production build.
      env: { ...process.env, NODE_ENV: "test" },
    });
  } finally {
    stopServerTree(server);
  }

  if (result?.error) failSpawn(result.error, "playwright", ["test", ...args]);
  if (result?.status !== 0) process.exit(result?.status ?? 1);
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

  await runPlaywrightWithManagedServer(effectiveArgs);
});
