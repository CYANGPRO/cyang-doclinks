import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnRepoTool } from "./repo-tooling.mjs";

/** @typedef {{ packageName: string, purpose: string, binName?: string }} ProofTool */
/** @typedef {{ label: string, toolName: string, args: string[] }} ProofCliCheck */
/** @typedef {(packageName: string) => boolean} PackageResolver */
/** @typedef {(tool: ProofTool) => boolean} ToolResolver */
/** @typedef {(check: ProofCliCheck) => { status?: number | null, error?: unknown }} ProofCliRunner */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REQUIRED_PROOF_TOOLS = [
  { packageName: "eslint", purpose: "lint", binName: "eslint" },
  { packageName: "typescript", purpose: "typecheck", binName: "tsc" },
  { packageName: "next", purpose: "build/typegen", binName: "next" },
  { packageName: "@playwright/test", purpose: "regression tests" },
  { packageName: "playwright", purpose: "browser installer / CLI", binName: "playwright" },
];

const REQUIRED_PROOF_CLI_CHECKS = [
  { label: "eslint", toolName: "eslint", args: ["--version"] },
  { label: "next", toolName: "next", args: ["--version"] },
  { label: "tsc", toolName: "tsc", args: ["--version"] },
  { label: "playwright", toolName: "playwright", args: ["--version"] },
];

function getPackageJsonPath(packageName) {
  return join(REPO_ROOT, "node_modules", ...packageName.split("/"), "package.json");
}

function packageExists(packageName) {
  return existsSync(getPackageJsonPath(packageName));
}

function getPackageJson(packageName) {
  return JSON.parse(readFileSync(getPackageJsonPath(packageName), "utf8"));
}

function toolExists(tool) {
  if (!packageExists(tool.packageName)) return false;
  if (!tool.binName) return true;

  const pkg = getPackageJson(tool.packageName);
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  const relativeBinPath = bins[tool.binName];
  if (!relativeBinPath) return false;
  return existsSync(join(dirname(getPackageJsonPath(tool.packageName)), relativeBinPath));
}

/** @type {ProofCliRunner} */
function runProofCliCheck(check) {
  return spawnRepoTool(check.toolName, check.args, {
    stdio: "pipe",
    env: process.env,
    encoding: "utf8",
  });
}

/**
 * @param {PackageResolver} [resolvePackage]
 */
export function getMissingProofPackages(resolvePackage = packageExists) {
  return REQUIRED_PROOF_TOOLS.filter(({ packageName }) => !resolvePackage(packageName));
}

/**
 * @param {ToolResolver} [resolveTool]
 */
export function getMissingProofTools(resolveTool = toolExists) {
  return REQUIRED_PROOF_TOOLS.filter((tool) => !resolveTool(tool));
}

export function formatMissingProofPackages(missingPackages) {
  return missingPackages.map(({ packageName, purpose }) => `${packageName} (${purpose})`).join(", ");
}

/**
 * @param {ToolResolver} [resolveTool]
 */
export function assertProofToolingInstalled(resolveTool = toolExists) {
  const missingTools = getMissingProofTools(resolveTool);
  if (missingTools.length === 0) return;

  const missingSummary = formatMissingProofPackages(missingTools);
  throw new Error(
    "Proof install is incomplete: repo-local tooling is missing: " +
      `${missingSummary}. ` +
      "This usually means devDependencies were omitted during install " +
      "(for example via NODE_ENV=production or NPM_CONFIG_OMIT=dev). " +
      "Rerun `npm ci` in this repo; if your environment forces omit settings, use `npm ci --include=dev`."
  );
}

/**
 * @param {ProofCliRunner} [runCliCheck]
 */
export function assertProofCliEntrypointsWork(runCliCheck = runProofCliCheck) {
  for (const check of REQUIRED_PROOF_CLI_CHECKS) {
    const result = runCliCheck(check);
    if (!result || result.status === 0) continue;

    const stderr = typeof result.error === "object" && result.error && "message" in result.error
      ? String(result.error.message)
      : "";
    throw new Error(
      `Proof install is incomplete: repo-local CLI resolution failed for ${check.label}. ` +
        `The proof wrapper could not launch repo-local tool "${check.toolName} ${check.args.join(" ")}". ` +
        "Rerun `npm ci` and make sure no concurrent install is rewriting node_modules while the proof runs. " +
        `Underlying error: ${stderr || `exit code ${result.status ?? 1}`}.`
    );
  }
}
