import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { getEncryptionConfig, getStorageConfig } from "./config.ts";
import { decryptEnvelope, encryptEnvelope } from "./encryption.ts";
import { deleteObject, generateStorageKey, getObject, headObject, putObject } from "./r2.ts";

const REQUIRED_CONFIRMATION = "CREATE_ENCRYPTED_SYNTHETIC_OBJECT_AND_DELETE";
const PRODUCTION_BUCKET = "local801-engage-private";
const SYNTHETIC_PLAINTEXT = Buffer.from("Local 801 synthetic encrypted R2 recovery drill", "utf8");

export type R2RecoveryErrorCode =
  | "R2_RECOVERY_PRECONDITION_FAILED"
  | "R2_RECOVERY_FAILED"
  | "R2_RECOVERY_CLEANUP_FAILED";

export class R2RecoveryError extends Error {
  readonly code: R2RecoveryErrorCode;

  constructor(code: R2RecoveryErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "R2RecoveryError";
    this.code = code;
  }
}

type RecoveryDependencies = {
  putObject: typeof putObject;
  getObject: typeof getObject;
  headObject: typeof headObject;
  deleteObject: typeof deleteObject;
};

const defaultDependencies: RecoveryDependencies = { putObject, getObject, headObject, deleteObject };

function precondition(condition: boolean) {
  if (!condition) throw new R2RecoveryError("R2_RECOVERY_PRECONDITION_FAILED");
}

/**
 * Writes one application-encrypted synthetic object, proves authenticated
 * decryption, and verifies deletion. It deliberately does not touch database
 * metadata and never returns the object key or secret configuration.
 */
export async function runEncryptedR2RecoveryDrill(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RecoveryDependencies = defaultDependencies,
) {
  precondition(env.LOCAL801_R2_RECOVERY_CONFIRM === REQUIRED_CONFIRMATION);
  precondition(env.LOCAL801_R2_RECOVERY_EXPECT_BUCKET === PRODUCTION_BUCKET);

  let storageConfig: ReturnType<typeof getStorageConfig>;
  try {
    storageConfig = getStorageConfig(env);
    getEncryptionConfig(env);
  } catch (error) {
    throw new R2RecoveryError("R2_RECOVERY_PRECONDITION_FAILED", { cause: error });
  }
  precondition(storageConfig.LOCAL801_R2_BUCKET === PRODUCTION_BUCKET);

  const storageKey = generateStorageKey("documents");
  const encrypted = encryptEnvelope(SYNTHETIC_PLAINTEXT, env);
  precondition(!encrypted.payload.includes(SYNTHETIC_PLAINTEXT));

  let putAttempted = false;
  let primaryFailure: unknown;
  try {
    const before = await dependencies.headObject(storageKey);
    if (before.exists) throw new Error("Synthetic recovery key collision.");

    // Set before awaiting so cleanup is attempted after a committed-response loss.
    putAttempted = true;
    await dependencies.putObject(storageKey, encrypted.payload);

    const stored = await dependencies.headObject(storageKey);
    if (!stored.exists || stored.contentLength !== encrypted.payload.byteLength) {
      throw new Error("Synthetic encrypted object metadata mismatch.");
    }

    const downloaded = await dependencies.getObject(storageKey);
    const decrypted = decryptEnvelope(downloaded.body, env);
    const expectedHash = createHash("sha256").update(SYNTHETIC_PLAINTEXT).digest();
    const actualHash = createHash("sha256").update(decrypted.plaintext).digest();
    if (
      decrypted.keyVersion !== encrypted.keyVersion
      || decrypted.formatVersion !== encrypted.formatVersion
      || decrypted.plaintext.byteLength !== SYNTHETIC_PLAINTEXT.byteLength
      || !timingSafeEqual(decrypted.plaintext, SYNTHETIC_PLAINTEXT)
      || !timingSafeEqual(actualHash, expectedHash)
    ) {
      throw new Error("Synthetic encrypted object round trip mismatch.");
    }
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  if (putAttempted) {
    try {
      await dependencies.deleteObject(storageKey);
      const after = await dependencies.headObject(storageKey);
      if (after.exists) throw new Error("Synthetic recovery object remains after deletion.");
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (cleanupFailure) {
    throw new R2RecoveryError("R2_RECOVERY_CLEANUP_FAILED", {
      cause: primaryFailure ? new AggregateError([primaryFailure, cleanupFailure]) : cleanupFailure,
    });
  }
  if (primaryFailure) throw new R2RecoveryError("R2_RECOVERY_FAILED", { cause: primaryFailure });

  return {
    storageRecovery: "ok" as const,
    encryptedRoundTrip: "ok" as const,
    cleanup: "ok" as const,
  };
}
