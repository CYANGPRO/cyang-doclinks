#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function resolveSpawn(command, args) {
  if (process.platform === "win32" && command === "npm") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

function run(command, args) {
  const resolved = resolveSpawn(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status || 1}.`);
  }
}

const nextTypeValidator = join(".next", "types", "validator.ts");
const nextDevTypeValidator = join(".next", "dev", "types", "validator.ts");

if (!existsSync(nextTypeValidator) && !existsSync(nextDevTypeValidator)) {
  console.log("Next type manifests missing. Running repo-local `next typegen` before `tsc`...");
  run("npm", ["exec", "--no", "--", "next", "typegen"]);
}

run("npm", ["exec", "--no", "--", "tsc", "--noEmit", "-p", "tsconfig.json"]);
