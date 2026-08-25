import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activeNavigationHref, can, mobileNavForRole, navForRole, navGroupsForRole, roleLabels, shellForRole } from "../src/lib/access.ts";

const expectedNavigation = {
  system_owner: [
    "/", "/membership", "/directory", "/new-hires", "/outreach", "/action-readiness", "/workload", "/follow-ups", "/notifications", "/campaigns", "/email-broadcasts", "/cat-actions",
    "/imports", "/membership/data-quality", "/membership/contact-corrections", "/documents", "/reports", "/audit", "/team", "/settings",
  ],
  local_admin: [
    "/", "/membership", "/directory", "/new-hires", "/outreach", "/action-readiness", "/workload", "/follow-ups", "/notifications", "/campaigns", "/email-broadcasts", "/cat-actions",
    "/imports", "/membership/data-quality", "/membership/contact-corrections", "/documents", "/reports", "/audit", "/team", "/settings",
  ],
  membership_data_manager: [
    "/", "/membership", "/directory", "/new-hires", "/action-readiness", "/notifications", "/imports", "/membership/data-quality", "/membership/contact-corrections", "/documents", "/reports",
  ],
  cat_admin: [
    "/", "/directory", "/new-hires", "/outreach", "/action-readiness", "/workload", "/follow-ups", "/notifications", "/campaigns", "/cat-actions", "/documents", "/reports",
  ],
  cat_lead: [
    "/", "/directory", "/new-hires", "/outreach", "/action-readiness", "/workload", "/follow-ups", "/notifications", "/documents", "/reports",
  ],
  cat_member: ["/", "/directory", "/outreach", "/action-readiness", "/workload", "/follow-ups", "/notifications", "/documents"],
  report_viewer: ["/", "/documents", "/reports"],
};

const expectedLabels = {
  system_owner: "System Owner",
  local_admin: "Local Administrator",
  membership_data_manager: "Membership Data Manager",
  cat_admin: "801 Administrator",
  cat_lead: "LCAT",
  cat_member: "CAT",
  report_viewer: "Report Viewer",
};

test("role labels cover every preview role", () => {
  assert.deepEqual(roleLabels, expectedLabels);
});

for (const [role, expectedHrefs] of Object.entries(expectedNavigation)) {
  test(`navForRole returns only authorized links for ${role}`, () => {
    assert.deepEqual(navForRole(role).map((item) => item.href), expectedHrefs);
    assert.equal(shellForRole(role).roleLabel, expectedLabels[role]);
  });
}

test("New Hires navigation follows the dedicated assignment permission", () => {
  const allowed = new Set(["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead"]);
  for (const role of Object.keys(expectedNavigation)) {
    const hasNewHires = navForRole(role).some((item) => item.href === "/new-hires");
    assert.equal(can(role, "assignNewHires"), allowed.has(role), `${role} assignNewHires permission is incorrect`);
    assert.equal(hasNewHires, allowed.has(role), `${role} New Hires navigation visibility is incorrect`);
  }
});

test("Data Quality and Contact Updates navigation are limited to membership data roles", () => {
  const allowed = new Set(["system_owner", "local_admin", "membership_data_manager"]);
  for (const role of Object.keys(expectedNavigation)) {
    const hrefs = new Set(navForRole(role).map((item) => item.href));
    assert.equal(hrefs.has("/membership/data-quality"), allowed.has(role), `${role} Data Quality navigation visibility is incorrect`);
    assert.equal(hrefs.has("/membership/contact-corrections"), allowed.has(role), `${role} Contact Updates navigation visibility is incorrect`);
  }
});

test("active navigation chooses the most-specific authorized route", () => {
  const hrefs = navForRole("local_admin").map((item) => item.href);
  assert.equal(activeNavigationHref("/membership/contact-corrections", hrefs), "/membership/contact-corrections");
  assert.equal(activeNavigationHref("/membership/data-quality", hrefs), "/membership/data-quality");
  assert.equal(activeNavigationHref("/membership", hrefs), "/membership");
  assert.equal(activeNavigationHref("/", hrefs), "/");
  assert.equal(activeNavigationHref("/not-authorized", hrefs), null);
});

test("unauthenticated shell has no role fallback or authenticated navigation", () => {
  assert.deepEqual(shellForRole(null), { navigation: [], roleLabel: null });
});

test("AppShell reads the preview session without a hardcoded local administrator fallback", () => {
  const source = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /await getPreviewUser\(\)/);
  assert.match(source, /shellForRole\(user\?\.role \?\? null\)/);
  assert.doesNotMatch(source, /demoRole|shellForRole\(["']local_admin["']\)/);
});

test("AppShell uses the approved MAPE asset and Engaging Local 801 name", () => {
  const source = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /from "next\/image"/);
  assert.match(source, /src="\/brand\/mape-logo\.png"/);
  assert.match(source, /aria-label="Engaging Local 801 home"/);
  assert.match(source, /brand-title">Engaging Local 801/);
  assert.match(source, /alt="MAPE"/);
  assert.match(source, /className="brand-logo"/);
  assert.match(source, /className="topbar-mape-logo"/);
  assert.doesNotMatch(source, /className="brand-mark"/);
  assert.doesNotMatch(source, /Logo pending|brand-asset-placeholder/);
});

test("To Do is available from both the authenticated header and task navigation", () => {
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  const access = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
  assert.match(shell, /<NotificationBell \/>/);
  assert.match(shell, /can\(user\.role, "viewPersonalWorkspace"\)/);
  assert.match(access, /href: "\/notifications", label: "To Do", group: "My work"/);
  for (const role of Object.keys(expectedNavigation)) {
    assert.equal(navForRole(role).some((item) => item.href === "/notifications"), can(role, "viewPersonalWorkspace"), `${role} To Do visibility is incorrect`);
  }
});

test("report viewer receives reporting only, not operational personal workspace", () => {
  const hrefs = new Set(navForRole("report_viewer").map((item) => item.href));
  assert.equal(hrefs.has("/directory"), false);
  assert.equal(hrefs.has("/notifications"), false);
  assert.equal(hrefs.has("/membership/data-quality"), false);
});

test("Documents navigation follows viewDocuments for every role", () => {
  const expected = {
    system_owner: true,
    local_admin: true,
    membership_data_manager: true,
    cat_admin: true,
    cat_lead: true,
    cat_member: true,
    report_viewer: true,
  };

  for (const [role, mayViewDocuments] of Object.entries(expected)) {
    const hasDocuments = navForRole(role).some((item) => item.href === "/documents");
    assert.equal(hasDocuments, mayViewDocuments, `${role} Documents visibility is incorrect`);
  }
});

test("navigation groups organizing work by user intent", () => {
  const groups = navGroupsForRole("cat_lead");
  const myWork = groups.find((group) => group.label === "My work");
  assert.ok(myWork);
  assert.deepEqual(myWork.items.map((item) => item.label), ["Member outreach", "Work planner", "Follow-ups", "To Do"]);
  assert.equal(groups.some((group) => group.label === "Organizing"), false);
});

test("navigation groups omit empty categories and mobile destinations remain role-aware", () => {
  assert.equal(navGroupsForRole("report_viewer").some((group) => group.label === "People"), false);
  assert.deepEqual(mobileNavForRole("cat_member").map((item) => item.href), ["/", "/directory", "/outreach", "/notifications"]);
  assert.deepEqual(mobileNavForRole("membership_data_manager").map((item) => item.href), ["/", "/membership", "/notifications", "/imports"]);
  assert.deepEqual(mobileNavForRole("report_viewer").map((item) => item.href), ["/", "/reports"]);
});

for (const role of ["cat_lead", "cat_member"]) {
  test(`${role} does not receive organization administration links`, () => {
    const hrefs = new Set(navForRole(role).map((item) => item.href));
    const forbidden = [
      "/membership", "/imports", "/membership/data-quality", "/membership/contact-corrections", "/campaigns", "/cat-actions",
      "/audit", "/team", "/settings",
    ];
    if (role === "cat_member") forbidden.push("/new-hires");
    for (const href of forbidden) {
      assert.equal(hrefs.has(href), false, `${role} unexpectedly received ${href}`);
    }
    if (role === "cat_lead") assert.equal(hrefs.has("/new-hires"), true, "cat_lead should receive New Hires");
    assert.equal(hrefs.has("/workload"), true, `${role} should receive Work Planner`);
    assert.equal(hrefs.has("/notifications"), true, `${role} should receive To Do navigation`);
    if (role === "cat_member") assert.equal(hrefs.has("/documents"), true);
  });
}
