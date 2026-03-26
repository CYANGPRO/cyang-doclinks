import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fmtDuration } from "./check-runner.mjs";

/**
 * @typedef {"pending" | "passed" | "failed" | "skipped"} ProofStatus
 */

/**
 * @typedef {{
 *   id: string;
 *   label: string;
 *   status: ProofStatus;
 *   durationMs: number | null;
 *   command: string;
 *   reusedBuildArtifact?: boolean;
 *   reason?: string;
 * }} ProofPhase
 */

/**
 * @typedef {{
 *   status: ProofStatus;
 *   durationMs: number | null;
 *   message: string | null;
 * }} ProofCheck
 */

/**
 * @typedef {{
 *   repoName: string;
 *   timestamp: string;
 *   proofCommand: string;
 *   dockerProofRun: boolean;
 *   gitCommitHash: string | null;
 *   nodeVersion: string;
 *   npmVersion: string | null;
 *   platform: string;
 *   arch: string;
 *   installVerification: ProofCheck;
 *   preflight: ProofCheck;
 *   phases: ProofPhase[];
 *   finalStatus: "running" | "passed" | "failed";
 *   failureMessage: string | null;
 *   failurePhase: string | null;
 *   notProven: string[];
 *   artifactPaths: {
 *     report: string;
 *     summary: string;
 *     log: string;
 *   };
 * }} ProofReport
 */

export const PROOF_ARTIFACT_DIR = join(process.cwd(), ".artifacts", "proof");
export const PROOF_ARTIFACT_PATHS = {
  dir: PROOF_ARTIFACT_DIR,
  reportPath: join(PROOF_ARTIFACT_DIR, "proof-report.json"),
  summaryPath: join(PROOF_ARTIFACT_DIR, "proof-summary.md"),
  logPath: join(PROOF_ARTIFACT_DIR, "prove-build.log"),
};

function normalizeStatus(status) {
  if (!status) return "unknown";
  if (status === "passed" || status === "failed" || status === "skipped") return status;
  return String(status);
}

function formatPhaseLine(phase) {
  const duration = typeof phase.durationMs === "number" ? fmtDuration(phase.durationMs) : "n/a";
  const reason = phase.reason ? ` - ${phase.reason}` : "";
  return `- ${phase.label}: ${phase.status.toUpperCase()} (${duration})${reason}`;
}

export function ensureProofArtifactDir() {
  mkdirSync(PROOF_ARTIFACT_PATHS.dir, { recursive: true });
  return PROOF_ARTIFACT_PATHS;
}

export function getGitCommitHash() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });

  if (result.status !== 0) {
    return null;
  }

  const hash = String(result.stdout || "").trim();
  return hash || null;
}

export function startProofLogCapture(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "w" });
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  function teeWrite(originalWrite) {
    return function patchedWrite(chunk, encoding, callback) {
      const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
      const resolvedCallback = typeof encoding === "function" ? encoding : callback;
      stream.write(chunk, resolvedEncoding);
      return originalWrite(chunk, resolvedEncoding, resolvedCallback);
    };
  }

  process.stdout.write = teeWrite(originalStdoutWrite);
  process.stderr.write = teeWrite(originalStderrWrite);

  return () =>
    new Promise((resolve, reject) => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      stream.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
}

/**
 * @param {{
 *   repoName: string;
 *   proofCommand: string;
 *   dockerProofRun: boolean;
 *   nodeVersion: string;
 *   npmVersion?: string | null;
 *   gitCommitHash?: string | null;
 *   platform?: string;
 *   arch?: string;
 *   notProven?: string[];
 * }} options
 * @returns {ProofReport}
 */
export function createBaseProofReport({
  repoName,
  proofCommand,
  dockerProofRun,
  nodeVersion,
  npmVersion = null,
  gitCommitHash = null,
  platform = process.platform,
  arch = process.arch,
  notProven = [],
}) {
  return {
    repoName,
    timestamp: new Date().toISOString(),
    proofCommand,
    dockerProofRun: Boolean(dockerProofRun),
    gitCommitHash,
    nodeVersion,
    npmVersion,
    platform,
    arch,
    installVerification: {
      status: "pending",
      durationMs: null,
      message: null,
    },
    preflight: {
      status: "pending",
      durationMs: null,
      message: null,
    },
    phases: [
      { id: "lint", label: "Lint", status: "pending", durationMs: null, command: "npm run lint" },
      { id: "typecheck", label: "Typecheck", status: "pending", durationMs: null, command: "npm run typecheck" },
      { id: "build", label: "Production build", status: "pending", durationMs: null, command: "npm run build" },
      {
        id: "tests",
        label: "Regression tests",
        status: "pending",
        durationMs: null,
        command: "npm test -- --runInBand --require-existing-build",
        reusedBuildArtifact: true,
      },
      {
        id: "audits",
        label: "Bundle budget audit",
        status: "pending",
        durationMs: null,
        command: "npm run audit:bundle-budgets",
      },
      {
        id: "prod-readiness",
        label: "Production readiness",
        status: "pending",
        durationMs: null,
        command: "node scripts/production-readiness.mjs --skip-lint --skip-typecheck --skip-build --skip-bundle-budgets",
      },
    ],
    finalStatus: "running",
    failureMessage: null,
    failurePhase: null,
    notProven,
    artifactPaths: {
      report: relative(process.cwd(), PROOF_ARTIFACT_PATHS.reportPath),
      summary: relative(process.cwd(), PROOF_ARTIFACT_PATHS.summaryPath),
      log: relative(process.cwd(), PROOF_ARTIFACT_PATHS.logPath),
    },
  };
}

/**
 * @param {ProofReport} report
 * @param {Array<{ label: string; status: number; durationMs?: number | null; timedOut?: boolean; timeoutMs?: number | null }>} results
 * @returns {ProofReport}
 */
export function applyPhaseResults(report, results = []) {
  const phaseByLabel = new Map(report.phases.map((phase) => [phase.label, phase]));

  for (const result of results) {
    const phase = phaseByLabel.get(result.label);
    if (!phase) continue;
    phase.status = result.status === 0 ? "passed" : "failed";
    phase.durationMs = result.durationMs ?? null;
    if (result.timedOut && result.timeoutMs) {
      phase.reason = `timed out after ${fmtDuration(result.timeoutMs)}`;
    }
  }

  return report;
}

/**
 * @param {ProofReport} report
 * @param {string} failedLabel
 * @param {string} reason
 */
export function markRemainingPhasesSkipped(report, failedLabel, reason) {
  let afterFailure = false;
  for (const phase of report.phases) {
    if (phase.label === failedLabel) {
      afterFailure = true;
      continue;
    }
    if (!afterFailure) continue;
    if (phase.status !== "pending") continue;
    phase.status = "skipped";
    phase.reason = reason;
  }
}

/**
 * @param {ProofReport} report
 */
export function renderProofSummary(report) {
  const installDuration = typeof report.installVerification.durationMs === "number"
    ? fmtDuration(report.installVerification.durationMs)
    : "n/a";
  const preflightDuration = typeof report.preflight.durationMs === "number"
    ? fmtDuration(report.preflight.durationMs)
    : "n/a";

  return [
    "# Build Proof Summary",
    "",
    `- Status: ${normalizeStatus(report.finalStatus).toUpperCase()}`,
    `- Timestamp: ${report.timestamp}`,
    `- Command: \`${report.proofCommand}\``,
    `- Docker proof run: ${report.dockerProofRun ? "yes" : "no"}`,
    `- Commit: ${report.gitCommitHash ?? "unavailable"}`,
    `- Runtime: Node ${report.nodeVersion}, npm ${report.npmVersion ?? "unavailable"}`,
    `- Platform: ${report.platform}/${report.arch}`,
    "",
    "## Preflight",
    "",
    `- Install verification: ${normalizeStatus(report.installVerification.status).toUpperCase()} (${installDuration})${report.installVerification.message ? ` - ${report.installVerification.message}` : ""}`,
    `- Proof preflight: ${normalizeStatus(report.preflight.status).toUpperCase()} (${preflightDuration})${report.preflight.message ? ` - ${report.preflight.message}` : ""}`,
    "",
    "## Phases",
    "",
    ...report.phases.map(formatPhaseLine),
    "",
    "## Artifacts",
    "",
    `- JSON report: \`${report.artifactPaths.report}\``,
    `- Human summary: \`${report.artifactPaths.summary}\``,
    `- Full log: \`${report.artifactPaths.log}\``,
    "",
    "## Not Proven Here",
    "",
    ...report.notProven.map((item) => `- ${item}`),
    ...(report.failureMessage
      ? [
          "",
          "## Failure",
          "",
          `- Failing phase: ${report.failurePhase ?? "unknown"}`,
          `- Message: ${report.failureMessage}`,
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * @param {ProofReport} report
 */
export function writeProofArtifacts(report) {
  ensureProofArtifactDir();
  writeFileSync(PROOF_ARTIFACT_PATHS.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(PROOF_ARTIFACT_PATHS.summaryPath, renderProofSummary(report), "utf8");
}
