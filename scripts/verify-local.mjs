#!/usr/bin/env node

import { runCheckPlan } from "./lib/check-runner.mjs";
import { loadLocalVerifyEnv } from "./lib/local-verify-env.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

await withProofLock({ label: "verify:local" }, async () => {
  const env = loadLocalVerifyEnv();

  await runCheckPlan({
    title: "Local verification",
    env,
    steps: [
      {
        label: "Lint",
        command: "npm",
        args: ["run", "lint"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        label: "Typecheck",
        command: "npm",
        args: ["run", "typecheck"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        label: "Production build",
        command: "npm",
        args: ["run", "build"],
        timeoutMs: 30 * 60 * 1000,
      },
      {
        label: "Deterministic runtime proofs",
        command: "node",
        args: ["scripts/verify-runtime.mjs", "--require-existing-build"],
        timeoutMs: 45 * 60 * 1000,
      },
    ],
  });
});
