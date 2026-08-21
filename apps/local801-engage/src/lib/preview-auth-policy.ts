export function previewAuthEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production") return false;
  return env.LOCAL801_PREVIEW_AUTH_ENABLED === "1" || env.NODE_ENV !== "production";
}
