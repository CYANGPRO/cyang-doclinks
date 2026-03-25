import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";

function runNodeModule(source: string) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

test.describe("proof install preflight", () => {
  test("formats missing proof packages with their proof purpose", () => {
    const result = runNodeModule(`
      import { getMissingProofPackages, formatMissingProofPackages } from "./scripts/lib/proof-install.mjs";

      const missing = getMissingProofPackages((specifier) => {
        const packageName = specifier.replace(/\\/package\\.json$/u, "");
        if (packageName === "eslint" || packageName === "@playwright/test") {
          throw new Error("missing");
        }
        return specifier;
      });

      console.log(formatMissingProofPackages(missing));
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("eslint (lint)");
    expect(result.stdout).toContain("@playwright/test (regression tests)");
  });

  test("fails with an actionable devDependency install message", () => {
    const result = runNodeModule(`
      import { assertProofToolingInstalled } from "./scripts/lib/proof-install.mjs";

      try {
        assertProofToolingInstalled((specifier) => {
          const packageName = specifier.replace(/\\/package\\.json$/u, "");
          if (packageName === "eslint" || packageName === "typescript") {
            throw new Error("missing");
          }
          return specifier;
        });
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
      }
    `);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("devDependencies were omitted");
    expect(result.stderr).toContain("npm ci --include=dev");
  });
});
