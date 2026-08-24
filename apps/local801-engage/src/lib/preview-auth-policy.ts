export function previewAuthEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production" || env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") return false;
  return env.LOCAL801_PREVIEW_AUTH_ENABLED === "1" || env.NODE_ENV !== "production";
}
