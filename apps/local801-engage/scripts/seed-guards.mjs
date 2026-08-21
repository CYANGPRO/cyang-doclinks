export function assertSyntheticSeedAllowed(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed synthetic Local 801 data when NODE_ENV=production.");
  }
  if (env.VERCEL_ENV === "production") {
    throw new Error("Refusing to seed synthetic Local 801 data when VERCEL_ENV=production.");
  }
  if (env.LOCAL801_ALLOW_SYNTHETIC_SEED !== "1") {
    throw new Error("Refusing to seed unless LOCAL801_ALLOW_SYNTHETIC_SEED=1 is set.");
  }
  if (!env.LOCAL801_DATABASE_URL) {
    throw new Error("LOCAL801_DATABASE_URL is required to seed synthetic data.");
  }
  return env.LOCAL801_DATABASE_URL;
}
