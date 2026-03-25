#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { withProofLock } from "./lib/proof-lock.mjs";

function resolveSpawn(command, args) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

await withProofLock({ label: "fire-drill:staging" }, async () => {
  const commands = [
    ["node", ["scripts/release-gate.mjs", "--require-env"]],
    ["npm", ["run", "build"]],
    ["npm", ["run", "test:security:state:ci"]],
    ["npm", ["run", "test:security:freeze:ci"]],
    ["npm", ["run", "test:billing:webhook:ci"]],
    ["node", ["scripts/restore-verify.mjs", "--require-current-migrations"]],
    ["node", ["scripts/live-runtime-proof.mjs", "--summary-json", ".tmp/live-runtime-proof-summary.json"]],
  ];

  for (const [command, args] of commands) {
    console.log(`\n==> ${command} ${args.join(" ")}`);
    const resolved = resolveSpawn(command, args);
    const result = spawnSync(resolved.command, resolved.args, {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }

  console.log("\nStaging fire-drill validation passed.");
});
