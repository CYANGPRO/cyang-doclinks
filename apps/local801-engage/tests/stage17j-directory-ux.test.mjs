import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Stage 17J Directory keeps the primary search focused and secondary filters behind More filters", () => {
  const directory = source("src/app/directory/page.tsx");

  assert.match(directory, /Find people by name, workplace, classification, membership status, or work email\./);
  assert.match(directory, /className="field directory-search-field"/);
  assert.match(directory, /className="button directory-search-submit"/);
  assert.match(directory, /className="directory-more-filters"/);
  assert.match(directory, /<summary>More filters/);
  assert.match(directory, /id="department"/);
  assert.match(directory, /id="classification"/);
  assert.match(directory, /id="workLocation"/);
  assert.doesNotMatch(directory, /Rows per page/);
});

test("Stage 17J Directory only shows result controls when they are useful", () => {
  const directory = source("src/app/directory/page.tsx");

  assert.match(directory, /results\.total > 25 \? <div className="directory-results-toolbar">/);
  assert.match(directory, /aria-label="People per page"/);
  assert.match(directory, /\(results\.previousCursor \|\| results\.nextCursor\) \? <Pagination/);
  assert.match(directory, /Protected PII/);
  assert.doesNotMatch(directory, /Protected PII · \$\{results\.total\} found/);
  assert.doesNotMatch(directory, /Showing up to/);
});

test("Stage 17J Directory presents membership status and outreach-record actions as user-facing labels", () => {
  const directory = source("src/app/directory/page.tsx");

  assert.match(directory, /if \(status === "member"\) return "Member"/);
  assert.match(directory, /if \(status === "nonmember"\) return "Nonmember"/);
  assert.match(directory, /if \(status === "unknown"\) return "Unknown"/);
  assert.match(directory, />Outreach record <span aria-hidden="true">→<\/span><\/Link>/);
  assert.doesNotMatch(directory, /Member 360/);
});

test("Stage 17J Directory preserves contextual Member 360 access without widening permissions", () => {
  const directory = source("src/app/directory/page.tsx");
  const access = source("src/lib/access.ts");

  assert.match(directory, /const canOpenEmployee = can\(user\.role, "recordEngagement"\)/);
  assert.match(directory, /href=\{`\/outreach\/\$\{person\.handle\}`\}/);
  assert.match(access, /recordEngagement: \["system_owner", "local_admin", "cat_admin", "cat_lead", "cat_member"\]/);
  assert.doesNotMatch(access, /recordEngagement: \[[^\]]*membership_data_manager/);
});

test("Stage 17J Directory swaps the wide table for compact member rows on small screens", () => {
  const directory = source("src/app/directory/page.tsx");
  const css = source("src/app/stage17.css");

  assert.match(directory, /className="directory-desktop-results"/);
  assert.match(directory, /className="directory-mobile-results" aria-label="Directory results"/);
  assert.match(directory, /className="directory-person-card"/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.directory-desktop-results \{[\s\S]*display: none/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.directory-mobile-results \{[\s\S]*display: block/);
});
