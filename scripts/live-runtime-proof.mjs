#!/usr/bin/env node

import { runLiveRuntimeProof } from "./lib/live-runtime-proof.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  const summaryPath = argValue("--summary-json");
  await withProofLock({ label: "runtime:proof:live" }, async () => {
    await runLiveRuntimeProof({ summaryPath });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
