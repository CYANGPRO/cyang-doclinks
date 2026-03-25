import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "tests";

export const LIVE_ISH_TEST_FILES = [
  "tests/attack-sim.spec.ts",
  "tests/billing-webhook.spec.ts",
  "tests/security-freeze.spec.ts",
  "tests/security-state.spec.ts",
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry.endsWith(".spec.ts")) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

export function listAllSpecFiles(root = TEST_ROOT) {
  return walk(root).sort();
}

export function listLocalSafeSpecFiles(root = TEST_ROOT) {
  const liveSet = new Set(LIVE_ISH_TEST_FILES.map((file) => file.replace(/\\/g, "/")));
  return listAllSpecFiles(root).filter((file) => !liveSet.has(file));
}

export function listSuiteFiles(profile) {
  if (profile === "live-ish") return [...LIVE_ISH_TEST_FILES];
  if (profile === "local-safe") return listLocalSafeSpecFiles();
  if (profile === "all") return listAllSpecFiles();
  throw new Error(`Unknown test suite profile: ${profile}`);
}
