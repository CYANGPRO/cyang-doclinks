import "server-only";

import { previewAuthEnabled } from "./preview-auth-policy.ts";
import { productionAuthRuntimeEnabled } from "./production-launch-policy.ts";

/**
 * Operational features are available to synthetic Preview sessions or to the fully gated
 * Entra-backed runtime. Production never falls back to Preview cookies.
 */
export function operationalRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production") return productionAuthRuntimeEnabled(env);
  return previewAuthEnabled(env) || productionAuthRuntimeEnabled(env);
}
