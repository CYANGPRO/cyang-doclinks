import { R2RecoveryError, runEncryptedR2RecoveryDrill } from "../src/lib/r2-recovery.ts";

try {
  const result = await runEncryptedR2RecoveryDrill();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const code = error instanceof R2RecoveryError ? error.code : "R2_RECOVERY_FAILED";
  console.error(JSON.stringify({ storageRecovery: "error", code }, null, 2));
  process.exitCode = 2;
}
