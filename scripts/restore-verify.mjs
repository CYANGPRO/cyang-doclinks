#!/usr/bin/env node

import { createMigrationClient, getMigrationStatus } from "./lib/migrations.mjs";
import {
  assertRestoreVerificationReady,
  readRestoreVerificationSnapshot,
  recordRecoveryDrill,
} from "./lib/restore-verify.mjs";
import { withProofLock } from "./lib/proof-lock.mjs";

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function main() {
  await withProofLock({ label: "restore:verify" }, async () => {
    const sql = createMigrationClient();
    const notes = String(argValue("--notes") || "").trim();
    const recordSuccess = hasFlag("--record-success");
    const recordFailure = hasFlag("--record-failure");
    const requireCurrentMigrations = hasFlag("--require-current-migrations");

    try {
      const summary = await readRestoreVerificationSnapshot({ sql });
      console.log(
        JSON.stringify(
          summary,
          null,
          2
        )
      );

      await assertRestoreVerificationReady({ sql, requireCurrentMigrations, getMigrationStatus });

      if (recordSuccess || recordFailure) {
        await recordRecoveryDrill({
          sql,
          status: recordSuccess ? "success" : "failed",
          notes,
          requireCurrentMigrations,
        });
        console.log(`Recorded recovery drill status: ${recordSuccess ? "success" : "failed"}.`);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
