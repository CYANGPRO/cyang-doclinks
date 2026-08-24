import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Data Imports exposes bounded server pagination with page-size-preserving recovery", () => {
  const page = source("src/app/imports/page.tsx");
  const persistence = source("src/lib/import-persistence.ts");

  assert.match(page, /getImportBatchesPage\(/);
  assert.match(page, /cursor: input\.cursor, pageSize: input\.limit/);
  assert.match(page, /Imports per page/);
  assert.match(page, /previousHref=\{previousPageHref \?\? \(hasCursor \? firstPageHref : null\)\}/);
  assert.match(page, /nextHref=\{nextPageHref\}/);
  assert.match(page, /No older imports/);
  assert.match(persistence, /LIMIT \$4::integer/);
  assert.match(persistence, /pageSize \+ 1/);
  assert.match(persistence, /digest\(batch\.organization_id::text \|\| ':' \|\| batch\.id::text, 'sha256'\)/);
});

test("account and session actions are authentication-mode aware and restore keyboard focus", () => {
  const shell = source("src/components/AppShell.tsx");
  const menu = source("src/components/AccountSessionMenu.tsx");
  const navigation = source("src/components/AppNavigation.tsx");
  const unauthorized = source("src/app/unauthorized/page.tsx");

  assert.match(shell, /user\?\.authentication === "preview" \? <div className="preview-status"/);
  assert.doesNotMatch(shell, /Production workspace|Production session/);
  assert.match(shell, /user\?\.authentication === "preview" \? <Link href="\/sign-in">Switch Preview role<\/Link> : null/);
  assert.match(navigation, /previewAuth \? <NavLink[\s\S]*Switch Preview role/);
  assert.match(menu, /authentication === "preview"/);
  assert.match(menu, /signOut\(\{ callbackUrl: "\/sign-in" \}\)/);
  assert.match(menu, /event\.key === "Escape"/);
  assert.match(menu, /triggerRef\.current\?\.focus\(\)/);
  assert.match(menu, /window\.location\.pathname/);
  assert.doesNotMatch(menu, /email|localStorage|sessionStorage|indexedDB/i);
  assert.match(unauthorized, /safeReturnPath\(input\.next\)/);
  assert.match(unauthorized, /isPreview && user/);
  assert.match(unauthorized, /production account/);
});

test("Production pages omit redundant workspace banners while Preview remains clearly identified", () => {
  const home = source("src/app/page.tsx");
  const shell = source("src/components/AppShell.tsx");

  assert.doesNotMatch(home, /title="Production workspace"/);
  assert.doesNotMatch(shell, /Production workspace/);
  assert.match(home, /user\.authentication === "preview"/);
  assert.match(home, /title="Preview environment"/);
  assert.match(shell, /Preview environment/);
  assert.doesNotMatch(home, /synthetic/i);
  assert.doesNotMatch(shell, /synthetic/i);
});

test("request protection retains same-origin path and filters for sign-in and unauthorized recovery", () => {
  const authz = source("src/lib/authz.server.ts");
  const proxy = source("src/proxy.ts");
  const previewAuth = source("src/app/api/auth/preview/route.ts");
  const previewRoleForm = source("src/components/PreviewRoleForm.tsx");
  const safePath = source("src/lib/safe-return-path.ts");

  assert.match(authz, /requestedPath = `\$\{pathname\}\$\{request\.nextUrl\.search\}`/);
  assert.match(authz, /url\.search = "";[\s\S]*url\.searchParams\.set\("next", requestedPath\)/);
  assert.match(safePath, /parsed\.origin !== RETURN_BASE/);
  assert.match(safePath, /parsed\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(previewAuth, /hasExactSameOrigin\(request\)/);
  assert.match(previewAuth, /suppliedOrigin !== "null"/);
  assert.match(previewAuth, /FORBIDDEN_ORIGIN/);
  assert.match(previewAuth, /verifyPreviewCsrfToken\(form\.get\("csrfToken"\), nextPath\)/);
  assert.match(previewAuth, /MAX_FORM_BYTES = 4_096/);
  assert.match(previewRoleForm, /fetch\("\/api\/auth\/preview"/);
  assert.match(previewRoleForm, /credentials: "same-origin"/);
  assert.match(previewRoleForm, /cache: "no-store"/);
  assert.match(previewRoleForm, /new URLSearchParams\(\)/);
  assert.match(proxy, /return protectRequest\(request\)/);
  for (const route of ["imports", "membership", "new-hires", "outreach", "follow-ups", "workload", "campaigns", "cat-actions", "documents", "notifications", "reports", "team", "settings", "audit"]) {
    assert.match(proxy, new RegExp(`"/${route.replaceAll("-", "\\-")}/:path\\*"`));
  }
});

test("Stage 20 controls retain coarse-pointer target sizing and responsive layouts", () => {
  const css = source("src/app/stage18.css");
  assert.match(css, /\.account-menu-trigger[\s\S]*min-height: 40px/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*\.account-menu-trigger,[\s\S]*\.account-menu-action \{ min-height: 48px; \}/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.account-menu-panel/);
  assert.match(css, /\.imports-page-size[\s\S]*display: flex/);
});
