#!/usr/bin/env node

import { runCheckPlan } from "./lib/check-runner.mjs";
import { loadLocalVerifyEnv } from "./lib/local-verify-env.mjs";

const env = loadLocalVerifyEnv();

runCheckPlan({
  title: "Local verification",
  env,
  steps: [
    {
      label: "Lint",
      command: "npm",
      args: ["run", "lint"],
    },
    {
      label: "Typecheck",
      command: "npm",
      args: ["run", "typecheck"],
    },
    {
      label: "Production build",
      command: "npm",
      args: ["run", "build"],
    },
    {
      label: "Deterministic runtime proofs",
      command: "node",
      args: ["scripts/verify-runtime.mjs", "--require-existing-build"],
    },
  ],
});
