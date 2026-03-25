#!/usr/bin/env node

import { runCheckPlan } from "./lib/check-runner.mjs";
import { loadLocalVerifyEnv, localVerifyRuntimeProofFiles } from "./lib/local-verify-env.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

await withProofLock({ label: "verify:runtime" }, async () => {
  const requireExistingBuild = process.argv.includes("--require-existing-build");
  const env = loadLocalVerifyEnv();
  const files = localVerifyRuntimeProofFiles();

  console.log("Local runtime verification adapters:");
  console.log("- database: deterministic route-level state adapter");
  console.log("- object storage: in-memory object store adapter");
  console.log("- malware scanner: deterministic clean/infected/unknown/unavailable adapter");
  console.log("- billing webhook: signed local fixture adapter");
  console.log("- health: injectable dependency summary adapter");
  console.log("- audit + restore: deterministic in-memory/script adapters");

  runCheckPlan({
    title: "Local runtime verification",
    env,
    steps: [
      {
        label: "Deterministic runtime proofs",
        command: "npm",
        args: [
          "test",
          "--",
          "--runInBand",
          ...(requireExistingBuild ? ["--require-existing-build"] : []),
          ...files,
        ],
        spawnFailureMessage:
          "could not spawn the deterministic runtime proof suite in the current Windows sandbox. " +
          "Rerun verify:runtime outside the sandbox or grant broader process-spawn permissions.",
      },
    ],
  });
});
