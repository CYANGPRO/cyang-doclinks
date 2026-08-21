import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const directoryService = readFileSync(new URL("../src/lib/directory.ts", import.meta.url), "utf8");
const directoryPage = readFileSync(new URL("../src/app/directory/page.tsx", import.meta.url), "utf8");
const followupEditForm = readFileSync(new URL("../src/components/FollowupEditForm.tsx", import.meta.url), "utf8");

test("Stage 8B Directory results expose the existing opaque outreach handle", () => {
  assert.match(directoryService, /import \{ outreachHandle \} from "\.\/outreach\.ts"/);
  assert.match(directoryService, /handle: outreachHandle\(context\.organizationId, row\.person_id!\)/);
  assert.doesNotMatch(directoryPage, /person\.personId|person\.id/);
});

test("Stage 8B Directory offers employee workspace navigation only to engagement-authorized roles", () => {
  assert.match(directoryPage, /import Link from "next\/link"/);
  assert.match(directoryPage, /const canOpenEmployee = can\(user\.role, "recordEngagement"\)/);
  assert.match(directoryPage, /href=\{`\/outreach\/\$\{person\.handle\}`\}/);
  assert.match(directoryPage, />Open employee<\/Link>/);
  assert.match(directoryPage, /canOpenEmployee \? <td>/);
});

test("Stage 8B successful follow-up edits use success feedback rather than error red", () => {
  assert.match(followupEditForm, /setMessage\("Follow-up updated\."\)/);
  assert.match(followupEditForm, /role="status" style=\{\{ color: "var\(--success\)" \}\}/);
  assert.match(followupEditForm, /role="alert">\{error\}/);
});
