const slugPattern = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Production initialization requires ${name}.`);
  return value;
}

export function parseProductionInitializationTarget(env = process.env) {
  const databaseUrl = required(env, "LOCAL801_DATABASE_URL");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("LOCAL801_DATABASE_URL is invalid."); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname || parsed.pathname === "/") {
    throw new Error("LOCAL801_DATABASE_URL is not a PostgreSQL database target.");
  }
  const sslmode = parsed.searchParams.get("sslmode")?.toLowerCase();
  if (!new Set(["require", "verify-ca", "verify-full"]).has(sslmode)) {
    throw new Error("Production initialization requires database TLS.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const expectedHostname = required(env, "LOCAL801_PRODUCTION_DATABASE_HOST").toLowerCase();
  const expectedDatabaseName = required(env, "LOCAL801_PRODUCTION_DATABASE_NAME");
  const organizationSlug = required(env, "LOCAL801_ORGANIZATION_SLUG");
  if (env.LOCAL801_DATABASE_ENVIRONMENT !== "production") throw new Error("Database environment must be explicitly production.");
  if (hostname !== expectedHostname || databaseName !== expectedDatabaseName) {
    throw new Error("Configured database target does not match the exact approved production target.");
  }
  if (/^(?:localhost|127\.0\.0\.1|::1)$/.test(hostname) || !hostname.includes(".")) {
    throw new Error("Production database hostname is ambiguous.");
  }
  if (/doclinks?/i.test(`${hostname}/${databaseName}/${organizationSlug}`)) {
    throw new Error("Production initialization refuses a DocLinks target.");
  }
  if (/preview|test|development|dev/i.test(databaseName) || databaseName === "local801_sql_test") {
    throw new Error("Production initialization refuses Preview, test, or development databases.");
  }
  if (!slugPattern.test(organizationSlug) || organizationSlug === "local801-preview" || /preview|test|dev/i.test(organizationSlug)) {
    throw new Error("Production organization slug is invalid.");
  }
  if ((env.LOCAL801_PRODUCTION_LAUNCH_ENABLED ?? "0") !== "0") {
    throw new Error("Production launch must remain disabled during initialization.");
  }
  if ((env.LOCAL801_ALLOW_SYNTHETIC_SEED ?? "0") !== "0") {
    throw new Error("Synthetic Preview seeding must remain disabled during initialization.");
  }
  if (env.DATABASE_URL) {
    let legacy;
    try { legacy = new URL(env.DATABASE_URL); } catch { throw new Error("Legacy DATABASE_URL is invalid and cannot be proven separate."); }
    const legacyName = decodeURIComponent(legacy.pathname.replace(/^\//, ""));
    const legacyPort = legacy.port || "5432";
    const targetPort = parsed.port || "5432";
    if (legacy.hostname.toLowerCase() === hostname && legacyPort === targetPort && legacyName === databaseName) {
      throw new Error("Production initialization refuses a database target reused by the root application.");
    }
  }
  return Object.freeze({ databaseUrl, hostname, databaseName, organizationSlug });
}

export function assertProductionInitializationRequest(env = process.env, mode = "inspect") {
  const target = parseProductionInitializationTarget(env);
  if (mode === "inspect") return target;
  if (mode !== "initialize") throw new Error("Initializer mode must be inspect or initialize.");
  if (env.LOCAL801_PRODUCTION_INITIALIZE !== "1") throw new Error("Production initialization opt-in is missing.");
  const expectedConfirmation = `INITIALIZE LOCAL801 PRODUCTION ${target.hostname}/${target.databaseName} ${target.organizationSlug}`;
  if (env.LOCAL801_PRODUCTION_INITIALIZATION_CONFIRMATION !== expectedConfirmation) {
    throw new Error("Typed production initialization confirmation does not match the exact target.");
  }
  const organizationName = required(env, "LOCAL801_ORGANIZATION_NAME");
  const ownerEmail = required(env, "LOCAL801_INITIAL_SYSTEM_OWNER_EMAIL").toLowerCase();
  const ownerDisplayName = required(env, "LOCAL801_INITIAL_SYSTEM_OWNER_DISPLAY_NAME");
  if (organizationName.length > 160 || ownerDisplayName.length > 160 || !emailPattern.test(ownerEmail) || ownerEmail.length > 320) {
    throw new Error("Initial organization or System Owner input is invalid.");
  }
  return Object.freeze({ ...target, organizationName, ownerEmail, ownerDisplayName });
}

export const __testing = { emailPattern, slugPattern };
