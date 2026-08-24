import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const campaignPage = readFileSync(new URL("../src/app/campaigns/[campaignHandle]/page.tsx", import.meta.url), "utf8");
const catActionPage = readFileSync(new URL("../src/app/cat-actions/[actionHandle]/page.tsx", import.meta.url), "utf8");
const roadmap = readFileSync(new URL("../docs/STAGE17_ADVANCED_WORKFLOWS.md", import.meta.url), "utf8");
const featureFreeze = readFileSync(new URL("../docs/FEATURE_FREEZE.md", import.meta.url), "utf8");

test("campaign progress is an explicit workflow funnel rather than a member score", () => {
  assert.match(campaignPage, /StatCard label="Population"/);
  assert.match(campaignPage, /StatCard label="Assigned"/);
  assert.match(campaignPage, /StatCard label="Contacted"/);
  assert.match(campaignPage, /StatCard label="Completed"/);
  assert.match(campaignPage, /progress measures, not member scores or predictions/);
  assert.match(campaignPage, /Assignment coverage/);
  assert.match(campaignPage, /Contact coverage/);
  assert.match(campaignPage, /Completion/);
  assert.match(campaignPage, /campaignTimingAlert/);
});

test("campaign handoff links only to open CAT Action contexts and carries an opaque campaign handle", () => {
  assert.match(campaignPage, /getCatActionsPage\(context, \{ pageSize: 100 \}\)/);
  assert.match(campaignPage, /action\.status !== "closed"/);
  assert.match(campaignPage, /new URLSearchParams\(\{ fromCampaign: campaignHandle \}\)/);
  assert.match(campaignPage, /Open with campaign context/);
  assert.match(campaignPage, /does not copy people, assignments, responses, or commitments/);
});

test("CAT Action validates and preserves campaign handoff context without changing task mutation semantics", () => {
  assert.match(catActionPage, /const HANDLE_RE = \/\^\[0-9a-f\]\{64\}\$\/i/);
  assert.match(catActionPage, /sourceCampaignHandle\(input\.fromCampaign\)/);
  assert.match(catActionPage, /getCampaignDetail\(context, fromCampaign\)/);
  assert.match(catActionPage, /getCampaignActionReadiness\(context, fromCampaign\)/);
  assert.match(catActionPage, /name="fromCampaign" value=\{fromCampaign\}/);
  assert.match(catActionPage, /taskHref\(action\.handle, tasks, tasks\.nextCursor, fromCampaign\)/);
  assert.match(catActionPage, /did not copy people, assignments, action-readiness responses, or commitments/);
  assert.match(catActionPage, /New tasks and responses still require a separate action from an authorized user/);
});

test("Stage 17C historical context is explicitly superseded by the final durable relationship freeze", () => {
  assert.match(roadmap, /### 17C — Campaign and CAT Action integration — (?:implementation wave|complete)/);
  assert.match(roadmap, /does not copy member responses, people, assignments, commitments, or tasks/i);
  assert.match(featureFreeze, /durable Campaign-to-CAT-Action relationship/i);
  assert.match(featureFreeze, /0026__feature_complete_relationships_and_operator_controls\.sql/);
});
