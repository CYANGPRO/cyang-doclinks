#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnRepoTool } from "./lib/repo-tooling.mjs";

function run(toolName, args) {
  const result = spawnRepoTool(toolName, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${toolName} ${args.join(" ")} failed with exit code ${result.status || 1}.`);
  }
}

const nextTypeValidator = join(".next", "types", "validator.ts");
const nextDevTypeValidator = join(".next", "dev", "types", "validator.ts");

if (!existsSync(nextTypeValidator) && !existsSync(nextDevTypeValidator)) {
  console.log("Next type manifests missing. Running repo-local `next typegen` before `tsc`...");
  run("next", ["typegen"]);
}

run("tsc", ["--noEmit", "-p", "tsconfig.json"]);
