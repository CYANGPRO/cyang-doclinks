import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const libDirectory = fileURLToPath(new URL("../src/lib/", import.meta.url));

test("secure configuration explicitly disables production browser source maps", async () => {
  const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(source, /productionBrowserSourceMaps: false/);
  for (const header of [
    "Content-Security-Policy",
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
  ]) assert.match(source, new RegExp(header));
  assert.match(source, /Cache-Control[\s\S]*no-store, max-age=0/);
});

test("production session cookie is host-scoped, httpOnly, secure, and SameSite", async () => {
  const source = await readFile(new URL("../src/lib/auth-options.ts", import.meta.url), "utf8");
  assert.match(source, /__Secure-local801\.session-token/);
  assert.match(source, /httpOnly: true/);
  assert.match(source, /sameSite: "lax"/);
  assert.match(source, /secure: secureCookie/);
  assert.doesNotMatch(source, /domain\s*:/i);
});

test("preview authentication rejects cross-origin login CSRF and is non-cacheable", async () => {
  const source = await readFile(new URL("../src/app/api/auth/preview/route.ts", import.meta.url), "utf8");
  assert.match(source, /hasExactSameOrigin\(request\)/);
  assert.match(source, /FORBIDDEN_ORIGIN/);
  assert.match(source, /private, no-store/);
});

test("audit migration prevents update and delete while retaining organization scope evidence", async () => {
  const source = await readFile(new URL("../db/migrations/0019__append_only_audit_events.sql", import.meta.url), "utf8");
  assert.match(source, /before update or delete on local801\.audit_events/i);
  assert.match(source, /raise exception/i);
  assert.match(source, /organization_id/i);
});

test("runtime SQL schema-qualifies pgcrypto digest for the restricted application role", async () => {
  const files = await readdir(libDirectory, { recursive: true, withFileTypes: true });
  const typescriptFiles = files.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  for (const entry of typescriptFiles) {
    const source = await readFile(join(entry.parentPath, entry.name), "utf8");
    assert.doesNotMatch(source, /(?<![.\w])digest\(/, `${entry.name} contains an unqualified pgcrypto digest call`);
  }
});
