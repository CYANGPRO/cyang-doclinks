import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/engagement-command-center.ts", import.meta.url), "utf8");

test("engagement-depth bucket is materialized before CASE ordering", () => {
  const start = source.indexOf("reports:command-center-engagement-depth");
  const end = source.indexOf("reports:command-center-coverage-by-department", start);
  assert.ok(start >= 0 && end > start);
  const sql = source.slice(start, end);
  assert.match(sql, /bucketed AS \([\s\S]*FROM person_depth[\s\S]*FROM bucketed[\s\S]*ORDER BY CASE depth_bucket/);
});

test("action-readiness bucket is materialized before CASE ordering", () => {
  const start = source.indexOf("reports:command-center-action-readiness-depth");
  assert.ok(start >= 0);
  const sql = source.slice(start);
  assert.match(sql, /bucketed AS \([\s\S]*FROM willingness_depth[\s\S]*FROM bucketed[\s\S]*ORDER BY CASE willingness_bucket/);
});
