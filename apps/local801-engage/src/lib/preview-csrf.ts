import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_LIFETIME_SECONDS = 10 * 60;

function csrfSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.NEXTAUTH_SECRET;
  if (configured && Buffer.byteLength(configured, "utf8") >= 32) return configured;
  if (env.NODE_ENV !== "production") return "local801-local-development-preview-csrf-only";
  throw new Error("Preview CSRF protection is not configured.");
}

function signature(payload: string, env: NodeJS.ProcessEnv = process.env) {
  return createHmac("sha256", csrfSecret(env)).update(`local801-preview-csrf:v1:${payload}`, "utf8").digest("base64url");
}

export function issuePreviewCsrfToken(nextPath: string, nowSeconds = Math.floor(Date.now() / 1000), env: NodeJS.ProcessEnv = process.env) {
  const payload = Buffer.from(JSON.stringify({ nextPath, expiresAt: nowSeconds + TOKEN_LIFETIME_SECONDS }), "utf8").toString("base64url");
  return `${payload}.${signature(payload, env)}`;
}

export function verifyPreviewCsrfToken(
  token: unknown,
  nextPath: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  env: NodeJS.ProcessEnv = process.env,
) {
  if (typeof token !== "string" || token.length > 1_024) return false;
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return false;
  try {
    const expectedSignature = signature(payload, env);
    const supplied = Buffer.from(suppliedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return false;
    const parsed = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    return parsed.nextPath === nextPath
      && Number.isSafeInteger(parsed.expiresAt)
      && (parsed.expiresAt as number) >= nowSeconds
      && (parsed.expiresAt as number) <= nowSeconds + TOKEN_LIFETIME_SECONDS;
  } catch {
    return false;
  }
}

export const __testing = { TOKEN_LIFETIME_SECONDS };
