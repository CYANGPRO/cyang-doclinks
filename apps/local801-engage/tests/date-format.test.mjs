import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatCatDate, formatCatDateTime } from "../src/lib/date-format.ts";

test("CAT date displays use two-digit month, day, and four-digit year", () => {
  assert.equal(formatCatDate("2000-01-01"), "01/01/2000");
  assert.equal(formatCatDate("2026-08-05"), "08/05/2026");
  assert.equal(formatCatDate("not-a-date", "Unknown"), "Unknown");
});

test("CAT timestamp displays retain the matching date view and include time", () => {
  assert.equal(formatCatDateTime("2000-01-01T18:30:00.000Z"), "01/01/2000, 12:30 PM");
  assert.equal(formatCatDateTime(null, "Not yet"), "Not yet");
});

test("exact-moment date controls expose minute-level time selection", () => {
  const files = [
    "../src/components/CampaignMutations.tsx",
    "../src/components/CatActionMutations.tsx",
    "../src/components/EngagementRecorder.tsx",
    "../src/components/FollowupEditForm.tsx",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of files) {
    for (const input of source.matchAll(/<input\b[^>]*(?:due|occurred)[^>]*>/gi)) {
      assert.match(input[0], /type="datetime-local"/);
      assert.match(input[0], /step=\{60\}/);
    }
  }
});
