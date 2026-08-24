import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { followupSuggestionForOutcome, suggestedLocalDateTime } from "../src/lib/follow-up-suggestions.ts";

test("follow-up suggestions are deterministic explanations from explicit outcomes", () => {
  assert.deepEqual(followupSuggestionForOutcome("no_answer"), {
    days: 2,
    label: "Try again in 2 days",
    reason: "No answer was recorded.",
  });
  assert.equal(followupSuggestionForOutcome("left_message")?.days, 3);
  assert.equal(followupSuggestionForOutcome("not_available")?.days, 3);
  assert.equal(followupSuggestionForOutcome("contacted")?.days, 7);
  assert.equal(followupSuggestionForOutcome("wrong_contact"), null);
  assert.equal(followupSuggestionForOutcome("declined_conversation"), null);
});

test("suggested due time preserves local clock time while moving by the requested number of days", () => {
  const base = new Date(2026, 7, 17, 10, 30, 0, 0);
  const result = suggestedLocalDateTime(2, base);
  assert.match(result, /^2026-08-19T10:30$/);
});

test("engagement recorder never silently creates a suggested follow-up", () => {
  const source = readFileSync(new URL("../src/components/EngagementRecorder.tsx", import.meta.url), "utf8");
  assert.match(source, /Nothing is scheduled unless you use the suggestion and save the conversation\./);
  assert.match(source, /type="button" onClick=\{applyFollowupSuggestion\}>Use suggestion<\/button>/);
  assert.match(source, /followup: followupEnabled \? \{/);
  assert.match(source, /setFollowupEnabled\(true\)/);
});
