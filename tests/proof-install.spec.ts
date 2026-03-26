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
      import { getMissingProofTools, formatMissingProofPackages } from "./scripts/lib/proof-install.mjs";

      const missing = getMissingProofTools((tool) => {
        const packageName = tool.packageName;
        if (packageName === "eslint" || packageName === "@playwright/test") {
          return false;
        }
        return true;
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
        assertProofToolingInstalled((tool) => {
          const packageName = tool.packageName;
          if (packageName === "eslint" || packageName === "typescript") {
            return false;
          }
          return true;
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

  test("fails with an actionable repo-local CLI resolution message", () => {
    const result = runNodeModule(`
      import { assertProofCliEntrypointsWork } from "./scripts/lib/proof-install.mjs";

      try {
        assertProofCliEntrypointsWork((check) => {
          if (check.label === "eslint") {
            return { status: 1 };
          }
          return { status: 0 };
        });
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
      }
    `);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("repo-local CLI resolution failed for eslint");
    expect(result.stderr).toContain("Rerun `npm ci`");
    expect(result.stderr).toContain("no concurrent install is rewriting node_modules");
  });
});
