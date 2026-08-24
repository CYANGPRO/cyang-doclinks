import "server-only";

import { previewAuthEnabled } from "./preview-auth-policy.ts";
import { productionAuthRuntimeEnabled } from "./production-launch-policy.ts";

/**
 * Mutating and protected workspace routes are available only behind one of the
 * two authenticated runtime boundaries. Vercel Production can satisfy this
 * policy only after every production-launch interlock has passed.
 */
export function workspaceRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return previewAuthEnabled(env) || productionAuthRuntimeEnabled(env);
}
