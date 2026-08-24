import "server-only";

import { createPiiBlindIndex, getPiiKeyConfiguration, normalizePiiEmail } from "./pii-protection.ts";

export type PreparedPiiProtectedLookup = Readonly<{ sql: string; parameters: readonly unknown[] }>;

function protectedMode(env: NodeJS.ProcessEnv) {
  return env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1";
}

function isLegacyUserEmailExactLookup(sql: string) {
  const normalized = sql.replace(/\s+/g, " ").toLowerCase();
  return /from local801\.users/.test(normalized)
    && /organization_id\s*=\s*\$1::uuid/.test(normalized)
    && /lower\(email\)\s*=\s*lower\(\$2::text\)/.test(normalized);
}

export function preparePiiProtectedLookupQuery(
  query: string,
  parameters: readonly unknown[],
  env: NodeJS.ProcessEnv = process.env,
): PreparedPiiProtectedLookup | null {
  if (!protectedMode(env) || !isLegacyUserEmailExactLookup(query)) return null;
  const organizationId = parameters[0];
  const email = parameters[1];
  if (typeof organizationId !== "string" || typeof email !== "string") {
    throw new Error("Protected user-email lookup requires organization and email values.");
  }
  const config = getPiiKeyConfiguration(env);
  const index = createPiiBlindIndex(normalizePiiEmail(email), { organizationId, domain: "user:email" }, config);
  return {
    sql: `
      /* pii-protected-query:user-email-exact */
      SELECT 1
      FROM local801.pii_exact_indexes email_index
      JOIN local801.users app_user
        ON app_user.organization_id = email_index.organization_id
       AND app_user.id = email_index.entity_id
      WHERE email_index.organization_id = $1::uuid
        AND email_index.entity_type = 'user'
        AND email_index.index_domain = 'user:email'
        AND email_index.index_key_version = $2::text
        AND email_index.index_hash = $3::text
      LIMIT 1
    `,
    parameters: [organizationId, index.blindIndexKeyVersion, index.blindIndex],
  };
}

export const __testing = { isLegacyUserEmailExactLookup };
