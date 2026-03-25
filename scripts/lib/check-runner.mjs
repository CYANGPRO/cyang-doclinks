import { spawn } from "node:child_process";

function resolveSpawn(command, args) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function terminateProcessTree(child) {
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    if (child.killed) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore follow-up termination failures.
    }
  }, 5_000).unref();
}

async function runStep(step, env) {
  const startedAt = Date.now();
  const resolved = resolveSpawn(step.command, step.args);

  return await new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      stdio: "inherit",
      shell: false,
      env,
    });

    let timedOut = false;
    const progressIntervalMs = step.progressIntervalMs ?? 30_000;
    const progressTimer =
      progressIntervalMs > 0
        ? setInterval(() => {
            console.log(`... [${step.label}] still running after ${fmtDuration(Date.now() - startedAt)}`);
          }, progressIntervalMs)
        : null;
    const timeoutMs = step.timeoutMs ?? 0;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            console.error(`!! [${step.label}] exceeded ${fmtDuration(timeoutMs)} and will be terminated.`);
            terminateProcessTree(child);
          }, timeoutMs)
        : null;

    const cleanup = () => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("exit", (code, signal) => {
      cleanup();
      resolve({
        durationMs: Date.now() - startedAt,
        status: timedOut ? 124 : code ?? 1,
        signal,
        timedOut,
        timeoutMs,
      });
    });
  });
}

export async function runCheckPlan({ title, steps, env = process.env }) {
  const results = [];

  for (const step of steps) {
    const startedAt = Date.now();
    console.log(`\n==> [${step.label}] ${step.command} ${step.args.join(" ")}`);
    let result;
    try {
      result = await runStep(step, env);
    } catch (error) {
      if (process.platform === "win32" && error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        const message =
          step.spawnFailureMessage ||
          `could not spawn "${step.command} ${step.args.join(" ")}" in the current Windows sandbox.`;
        throw new Error(message);
      }
      throw error;
    }
    const durationMs = result.durationMs ?? Date.now() - startedAt;

    const status = result.status ?? 1;
    results.push({
      label: step.label,
      command: `${step.command} ${step.args.join(" ")}`.trim(),
      durationMs,
      status,
      timedOut: Boolean(result.timedOut),
      timeoutMs: typeof result.timeoutMs === "number" ? result.timeoutMs : null,
    });

    if (status !== 0) {
      printCheckSummary(title, results, {
        failedStep: step.label,
        failureStatus: status,
        failureDetail: result.timedOut && result.timeoutMs ? `timed out after ${fmtDuration(result.timeoutMs)}` : null,
      });
      process.exit(status);
    }
  }

  printCheckSummary(title, results);
  return results;
}

export function printCheckSummary(title, results, options = {}) {
  const totalMs = results.reduce((sum, step) => sum + step.durationMs, 0);
  const failedStep = options.failedStep || null;
  const statusLabel = failedStep ? "FAILED" : "PASSED";

  console.log(`\n${title} summary: ${statusLabel}`);
  for (const result of results) {
    const state = result.status === 0 ? "PASS" : "FAIL";
    const suffix = result.timedOut && result.timeoutMs ? `, timeout ${fmtDuration(result.timeoutMs)}` : "";
    console.log(`- ${state} ${result.label} (${fmtDuration(result.durationMs)}${suffix})`);
  }
  console.log(`- Total duration: ${fmtDuration(totalMs)}`);

  if (failedStep) {
    console.log(`- First failing step: ${failedStep}`);
  }
  if (options.failureDetail) {
    console.log(`- Failure detail: ${options.failureDetail}`);
  }
}
