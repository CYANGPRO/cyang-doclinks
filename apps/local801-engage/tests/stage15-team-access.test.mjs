import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { can, navForRole } from "../src/lib/access.ts";

test("role capability preview is derived from current access policy", () => {
  assert.equal(can("cat_member", "recordEngagement"), true);
  assert.equal(can("cat_member", "manageUsers"), false);
  assert.equal(can("report_viewer", "viewReports"), true);
  assert.equal(can("report_viewer", "viewDirectory"), false);
  assert.equal(navForRole("cat_member").some((item) => item.href === "/outreach"), true);
  assert.equal(navForRole("cat_member").some((item) => item.href === "/team"), false);
});

test("Team Access explains roles without impersonating identities", () => {
  const source = readFileSync(new URL("../src/app/team/page.tsx", import.meta.url), "utf8");
  assert.match(source, /What each role can do/);
  assert.match(source, /permitted actions assigned to each Local 801 role/);
  assert.match(source, /CAT never creates or emails a password/);
  assert.match(source, /grants access to the Entra enterprise application/);
  assert.match(source, /navForRole/);
  assert.match(source, /can\(role, permission\)/);
  assert.doesNotMatch(source, /impersonate user/i);
});
