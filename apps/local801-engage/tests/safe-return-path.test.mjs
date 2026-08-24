import assert from "node:assert/strict";
import test from "node:test";
import { safeReturnPath } from "../src/lib/safe-return-path.ts";

test("sign-in return paths stay same-origin, relative, and outside auth APIs", () => {
  assert.equal(safeReturnPath("/follow-ups?scope=mine&focus=overdue"), "/follow-ups?scope=mine&focus=overdue");
  assert.equal(safeReturnPath("https://attacker.example/follow-ups"), "/");
  assert.equal(safeReturnPath("//attacker.example/follow-ups"), "/");
  assert.equal(safeReturnPath("/api/team/users"), "/");
  assert.equal(safeReturnPath("/sign-in?next=/team"), "/");
  assert.equal(safeReturnPath("/team\\settings"), "/");
});
