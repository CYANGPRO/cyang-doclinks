/** @typedef {(specifier: string) => string} PackageResolver */

/** @type {PackageResolver} */
const resolveFromRepo = (specifier) => import.meta.resolve(specifier);

const REQUIRED_PROOF_PACKAGES = [
  { packageName: "eslint", purpose: "lint" },
  { packageName: "typescript", purpose: "typecheck" },
  { packageName: "next", purpose: "build/typegen" },
  { packageName: "@playwright/test", purpose: "regression tests" },
  { packageName: "start-server-and-test", purpose: "production-build test harness" },
];

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
