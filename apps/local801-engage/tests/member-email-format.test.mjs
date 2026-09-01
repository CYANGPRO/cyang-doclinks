import assert from "node:assert/strict";
import test from "node:test";
import { renderMemberEmailHtml, renderMemberEmailText } from "../src/lib/member-email-format.ts";

test("limited member-email formatting renders headings, emphasis, lists, and safe links", () => {
  const source = [
    "# Meeting reminder",
    "",
    "Please review the **updated agenda** before the *membership meeting*.",
    "",
    "- Sign in to CAT",
    "- Read the agenda",
    "",
    "[Open CAT](https://cat.cyang.io/meeting?view=agenda&month=9)",
  ].join("\n");
  const html = renderMemberEmailHtml(source);
  assert.match(html, /<h2[^>]*>Meeting reminder<\/h2>/);
  assert.match(html, /<strong>updated agenda<\/strong>/);
  assert.match(html, /<em>membership meeting<\/em>/);
  assert.match(html, /<ul[^>]*><li[^>]*>Sign in to CAT<\/li>/);
  assert.match(html, /href="https:\/\/cat\.cyang\.io\/meeting\?view=agenda&amp;month=9"/);
});

test("limited member-email formatting escapes raw HTML and rejects unsafe link protocols", () => {
  const html = renderMemberEmailHtml('<script>alert("no")</script>\n[Unsafe](javascript:alert(1))');
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href=/i);
  assert.match(html, /\[Unsafe\]\(javascript:alert\(1\)\)/);
});

test("plain-text fallback removes formatting markers and preserves link destinations", () => {
  const text = renderMemberEmailText("## Update\n\nA **bold** notice with [details](https://cat.cyang.io/details).");
  assert.equal(text, "Update\n\nA bold notice with details (https://cat.cyang.io/details).");
});
