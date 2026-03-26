#!/usr/bin/env node

import { spawnRepoTool } from "./lib/repo-tooling.mjs";

const [toolName, ...args] = process.argv.slice(2);

if (!toolName) {
  console.error("Usage: node scripts/run-repo-tool.mjs <tool> [...args]");
  process.exit(1);
}

try {
  const result = spawnRepoTool(toolName, args, {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
