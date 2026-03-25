import { spawnSync } from "node:child_process";

/** @typedef {(specifier: string) => string} PackageResolver */
/** @typedef {{ label: string, command: string, args: string[] }} ProofCliCheck */
/** @typedef {(check: ProofCliCheck) => { status?: number | null, error?: unknown }} ProofCliRunner */

/** @type {PackageResolver} */
const resolveFromRepo = (specifier) => import.meta.resolve(specifier);

const REQUIRED_PROOF_PACKAGES = [
  { packageName: "eslint", purpose: "lint" },
  { packageName: "typescript", purpose: "typecheck" },
  { packageName: "next", purpose: "build/typegen" },
  { packageName: "@playwright/test", purpose: "regression tests" },
  { packageName: "start-server-and-test", purpose: "production-build test harness" },
];

const REQUIRED_PROOF_CLI_CHECKS = [
  { label: "eslint", command: "npm", args: ["exec", "--no", "--", "eslint", "--version"] },
  { label: "next", command: "npm", args: ["exec", "--no", "--", "next", "--version"] },
  { label: "tsc", command: "npm", args: ["exec", "--no", "--", "tsc", "--version"] },
  { label: "playwright", command: "npm", args: ["exec", "--no", "--", "playwright", "--version"] },
];

function resolveSpawn(command, args) {
  if (process.platform === "win32" && command === "npm") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

/** @type {ProofCliRunner} */
function runProofCliCheck(check) {
  const resolved = resolveSpawn(check.command, check.args);
  return spawnSync(resolved.command, resolved.args, {
    stdio: "pipe",
    shell: false,
    env: process.env,
    encoding: "utf8",
  });
}

/**
 * @param {string} packageName
 * @param {PackageResolver} resolvePackageJson
 */
function resolvePackage(packageName, resolvePackageJson) {
  try {
    resolvePackageJson(`${packageName}/package.json`);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {PackageResolver} [resolvePackageJson]
 */
export function getMissingProofPackages(resolvePackageJson = resolveFromRepo) {
  return REQUIRED_PROOF_PACKAGES.filter(({ packageName }) => !resolvePackage(packageName, resolvePackageJson));
}

export function formatMissingProofPackages(missingPackages) {
  return missingPackages.map(({ packageName, purpose }) => `${packageName} (${purpose})`).join(", ");
}

/**
 * @param {PackageResolver} [resolvePackageJson]
 */
export function assertProofToolingInstalled(resolvePackageJson = resolveFromRepo) {
  const missingPackages = getMissingProofPackages(resolvePackageJson);
  if (missingPackages.length === 0) return;

  const missingSummary = formatMissingProofPackages(missingPackages);
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
        `The proof wrapper could not launch "${check.command} ${check.args.join(" ")}". ` +
        "Rerun `npm ci` and make sure no concurrent install is rewriting node_modules while the proof runs. " +
        `Underlying error: ${stderr || `exit code ${result.status ?? 1}`}.`
    );
  }
}
