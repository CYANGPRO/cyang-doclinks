import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8"));
}

export function loadLocalVerifyEnv(baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ...readEnvFile(".env.example"),
    ...readEnvFile(".env.local.verify.example"),
  };

  env.VERIFY_LOCAL_RUNTIME = env.VERIFY_LOCAL_RUNTIME || "1";
  env.SKIP_ENV_LOCAL_BOOTSTRAP = "1";
  return env;
}

export function localVerifyRuntimeProofFiles() {
  return [
    "tests/upload-runtime-proof.spec.ts",
    "tests/share-runtime-proof.spec.ts",
    "tests/stripe-webhook-runtime-proof.spec.ts",
    "tests/public-health-runtime-proof.spec.ts",
    "tests/restore-verify-runtime-proof.spec.ts",
    "tests/local-verification-profile.spec.ts",
    "tests/health-checks.spec.ts",
  ];
}
