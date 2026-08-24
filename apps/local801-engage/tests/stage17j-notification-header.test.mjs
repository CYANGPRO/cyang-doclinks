import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("notification bell is permission-gated in the authenticated app header", () => {
  const shell = source("../src/components/AppShell.tsx");
  const access = source("../src/lib/access.ts");

  assert.match(shell, /import \{ NotificationBell \}/);
  assert.match(shell, /can\(user\.role, "viewPersonalWorkspace"\) \? <NotificationBell \/>/);
  assert.doesNotMatch(access, /href: "\/notifications", label: "Notifications"/);
});

test("notification summary endpoint is private, no-store, permission-checked, and bounded", () => {
  const route = source("../src/app/api/work-preferences/notifications/route.ts");

  assert.match(route, /requirePreviewUser\("viewPersonalWorkspace"\)/);
  assert.match(route, /resolveWorkspaceContext\(auth\.user\)/);
  assert.match(route, /getWorkNotifications\(context\)/);
  assert.match(route, /private, no-store, max-age=0, must-revalidate/);
  assert.match(route, /notifications\.slice\(0, 5\)/);
  assert.doesNotMatch(route, /localStorage|sessionStorage|indexedDB|caches\./i);
});

test("notification bell loads asynchronously and keeps the full notification page available", () => {
  const bell = source("../src/components/NotificationBell.tsx");
  const page = source("../src/app/notifications/page.tsx");

  assert.match(bell, /fetch\("\/api\/work-preferences\/notifications"/);
  assert.match(bell, /cache: "no-store"/);
  assert.match(bell, /credentials: "same-origin"/);
  assert.match(bell, /items: Array\.isArray\(body\.items\) \? body\.items\.slice\(0, 5\)/);
  assert.match(bell, /View all notifications/);
  assert.match(bell, /href="\/notifications"/);
  assert.match(bell, /method: "POST"/);
  assert.match(bell, /We couldn’t dismiss that notification\. Try again\./);
  assert.doesNotMatch(bell, /localStorage|sessionStorage|indexedDB|caches\./i);

  assert.match(page, /getWorkNotifications\(context\)/);
  assert.match(page, /ProtectedPage permission="viewPersonalWorkspace"/);
});

test("notification panel keeps actions reachable while making work items easy to open", () => {
  const bell = source("../src/components/NotificationBell.tsx");
  const css = source("../src/components/NotificationBell.module.css");

  assert.match(bell, /className=\{styles\.scroller\}/);
  assert.match(bell, /className=\{styles\.itemBody\} href=\{notification\.href\}/);
  assert.match(bell, /className=\{styles\.dismiss\}/);
  assert.match(css, /\.panel \{[\s\S]*display: flex;[\s\S]*flex-direction: column;[\s\S]*overflow: hidden;/);
  assert.match(css, /\.scroller \{[\s\S]*overflow-y: auto;/);
  assert.match(css, /\.footer \{[\s\S]*flex: 0 0 auto;/);
  assert.match(css, /\.dismiss \{[\s\S]*min-height: 34px;/);
  assert.match(bell, /aria-label="Close notifications"/);
  assert.match(bell, /triggerRef\.current\?\.focus\(\)/);
  assert.match(css, /\.close \{[\s\S]*min-height: 36px;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.close \{[\s\S]*min-height: 44px;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.trigger \{[\s\S]*height: 44px;[\s\S]*width: 44px;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.dismiss \{[\s\S]*min-height: 44px;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.panel \{[\s\S]*position: fixed;[\s\S]*width: calc\(100% - 24px\);/);
  assert.doesNotMatch(css, /@media \(max-width: 640px\) \{[\s\S]*\.panel \{[\s\S]*100vw/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*:global\(\.topbar\):has\(\.panel\) \{[\s\S]*backdrop-filter: none;/);
});
