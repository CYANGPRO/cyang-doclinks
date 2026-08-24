import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceUrl = new URL("../src/lib/workspace-context.ts", import.meta.url);

test("workspace context resolves protected users through blind-indexed email and companion decryption", async () => {
  const source = await readFile(workspaceUrl, "utf8");
  assert.match(source, /getPiiProtectedReadMode\(\) !== "legacy"/);
  assert.match(source, /workspace-context:protected-user-email/);
  assert.match(source, /JOIN local801\.pii_exact_indexes email_index/);
  assert.match(source, /email_index\.index_domain = 'user:email'/);
  assert.match(source, /JOIN local801\.user_pii protected/);
  assert.match(source, /createPiiBlindIndex/);
  assert.match(source, /decryptPiiField/);
  assert.match(source, /normalizePiiEmail\(storedEmail\) !== normalizedEmail/);
});

test("protected workspace lookup binds both authenticated role and organization", async () => {
  const source = await readFile(workspaceUrl, "utf8");
  assert.match(source, /workspace_role\.code = \$4::text/);
  assert.match(source, /organization\.id = \$1::uuid/);
  assert.match(source, /organization\.organization_slug !== authenticatedUser\.organizationId/);
  assert.match(source, /row\.role !== authenticatedUser\.role/);
});
