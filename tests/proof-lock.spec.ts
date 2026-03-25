import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { withProofLock } from "../scripts/lib/proof-lock.mjs";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.describe("proof lock", () => {
  test("serializes overlapping proof invocations", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cyang-proof-lock-"));
    const lockDir = join(tempRoot, "proof-suite.lock");
    const order: string[] = [];
    const firstEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const secondEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };

    try {
      const first = withProofLock(
        { label: "first-proof", env: firstEnv, lockDir, pollMs: 10, timeoutMs: 1000 },
        async () => {
          order.push("first:start");
          await delay(60);
          order.push("first:end");
        }
      );

      await delay(15);

      const second = withProofLock(
        { label: "second-proof", env: secondEnv, lockDir, pollMs: 10, timeoutMs: 1000 },
        async () => {
          order.push("second:start");
          order.push("second:end");
        }
      );

      await Promise.all([first, second]);

      expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
      expect(existsSync(lockDir)).toBeFalsy();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("reuses inherited lock context for nested proof steps", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cyang-proof-lock-"));
    const lockDir = join(tempRoot, "proof-suite.lock");
    let nestedSawParentLock = false;
    const outerEnvSeed: NodeJS.ProcessEnv = { NODE_ENV: "test" };

    try {
      await withProofLock(
        { label: "outer-proof", env: outerEnvSeed, lockDir, pollMs: 10, timeoutMs: 1000 },
        async (outerEnv: NodeJS.ProcessEnv) => {
          expect(outerEnv.CYANG_PROOF_LOCK_TOKEN).toBeTruthy();

          await withProofLock(
            { label: "inner-proof", env: outerEnv, lockDir, pollMs: 10, timeoutMs: 1000 },
            async (innerEnv: NodeJS.ProcessEnv) => {
              nestedSawParentLock = existsSync(lockDir);
              expect(innerEnv.CYANG_PROOF_LOCK_TOKEN).toBe(outerEnv.CYANG_PROOF_LOCK_TOKEN);
            }
          );
        }
      );

      expect(nestedSawParentLock).toBeTruthy();
      expect(existsSync(lockDir)).toBeFalsy();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
