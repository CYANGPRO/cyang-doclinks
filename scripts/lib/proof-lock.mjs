import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const PROOF_LOCK_TOKEN_ENV = "CYANG_PROOF_LOCK_TOKEN";
export const PROOF_LOCK_LABEL_ENV = "CYANG_PROOF_LOCK_LABEL";

const DEFAULT_LOCK_DIR = join(process.cwd(), ".tmp", "locks", "proof-suite.lock");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerSummary(owner) {
  if (!owner || typeof owner !== "object") return "another proof command";
  const label = typeof owner.label === "string" && owner.label.trim() ? owner.label.trim() : "another proof command";
  const pid = Number.isInteger(owner.pid) ? ` (pid ${owner.pid})` : "";
  return `${label}${pid}`;
}

function readOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function isPidActive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

function removeLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

async function acquireLock({ label, lockDir, timeoutMs, pollMs }) {
  mkdirSync(dirname(lockDir), { recursive: true });

  const startedAt = Date.now();
  let waitingLogged = false;

  while (true) {
    try {
      mkdirSync(lockDir);
      const owner = {
        label,
        pid: process.pid,
        token: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner, null, 2));
      return owner;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }

      const owner = readOwner(lockDir);
      if (owner?.pid && !isPidActive(owner.pid)) {
        removeLock(lockDir);
        continue;
      }

      if (!waitingLogged) {
        console.log(`Waiting for shared proof lock held by ${ownerSummary(owner)}...`);
        waitingLogged = true;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for shared proof lock held by ${ownerSummary(owner)}.`);
      }

      await sleep(pollMs);
    }
  }
}

export async function withProofLock(
  {
    label,
    env = process.env,
    lockDir = DEFAULT_LOCK_DIR,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  },
  run
) {
  if (env[PROOF_LOCK_TOKEN_ENV]) {
    return run(env);
  }

  const owner = await acquireLock({ label, lockDir, timeoutMs, pollMs });
  const lockedEnv = {
    ...env,
    [PROOF_LOCK_TOKEN_ENV]: owner.token,
    [PROOF_LOCK_LABEL_ENV]: label,
  };

  const previousToken = process.env[PROOF_LOCK_TOKEN_ENV];
  const previousLabel = process.env[PROOF_LOCK_LABEL_ENV];
  process.env[PROOF_LOCK_TOKEN_ENV] = owner.token;
  process.env[PROOF_LOCK_LABEL_ENV] = label;

  try {
    return await run(lockedEnv);
  } finally {
    if (previousToken === undefined) {
      delete process.env[PROOF_LOCK_TOKEN_ENV];
    } else {
      process.env[PROOF_LOCK_TOKEN_ENV] = previousToken;
    }

    if (previousLabel === undefined) {
      delete process.env[PROOF_LOCK_LABEL_ENV];
    } else {
      process.env[PROOF_LOCK_LABEL_ENV] = previousLabel;
    }

    removeLock(lockDir);
  }
}
