import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mobileNavForRole, navForRole, navGroupsForRole, roleLabels, shellForRole } from "../src/lib/access.ts";

const expectedNavigation = {
  system_owner: [
    "/", "/membership", "/directory", "/new-hires", "/imports", "/outreach",
    "/follow-ups", "/campaigns", "/cat-actions", "/documents", "/reports",
    "/audit", "/team", "/settings", "/install",
  ],
  local_admin: [
    "/", "/membership", "/directory", "/new-hires", "/imports", "/outreach",
    "/follow-ups", "/campaigns", "/cat-actions", "/documents", "/reports",
    "/audit", "/team", "/settings", "/install",
  ],
  membership_data_manager: [
    "/", "/membership", "/directory", "/new-hires", "/imports", "/documents", "/reports", "/install",
  ],
  cat_admin: [
    "/", "/directory", "/outreach", "/follow-ups", "/campaigns", "/cat-actions", "/documents", "/reports", "/install",
  ],
  cat_lead: [
    "/", "/directory", "/outreach", "/follow-ups", "/documents", "/reports", "/install",
  ],
  cat_member: ["/", "/directory", "/outreach", "/follow-ups", "/documents", "/install"],
  report_viewer: ["/", "/reports", "/install"],
};

const expectedLabels = {
  system_owner: "System Owner",
  local_admin: "Local Administrator",
  membership_data_manager: "Membership Data Manager",
  cat_admin: "CAT Administrator",
  cat_lead: "CAT Lead",
  cat_member: "CAT Member",
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

test("unauthenticated shell has no role fallback or authenticated navigation", () => {
  assert.deepEqual(shellForRole(null), { navigation: [], roleLabel: null });
});

test("AppShell reads the preview session without a hardcoded local administrator fallback", () => {
  const source = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /await getPreviewUser\(\)/);
  assert.match(source, /shellForRole\(user\?\.role \?\? null\)/);
  assert.doesNotMatch(source, /demoRole|shellForRole\(["']local_admin["']\)/);
});

test("AppShell uses the approved MAPE asset without duplicating its accessible name", () => {
  const source = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /from "next\/image"/);
  assert.match(source, /src="\/brand\/mape-logo\.png"/);
  assert.match(source, /aria-label="Local 801 Engage home"/);
  assert.match(source, /alt=""/);
  assert.doesNotMatch(source, /Logo pending|brand-asset-placeholder/);
});

test("report viewer does not receive Directory", () => {
  assert.equal(navForRole("report_viewer").some((item) => item.href === "/directory"), false);
});

test("Documents navigation follows viewDocuments for every role", () => {
  const expected = {
    system_owner: true,
    local_admin: true,
    membership_data_manager: true,
    cat_admin: true,
    cat_lead: true,
    cat_member: true,
    report_viewer: false,
  };

  for (const [role, mayViewDocuments] of Object.entries(expected)) {
    const hasDocuments = navForRole(role).some((item) => item.href === "/documents");
    assert.equal(hasDocuments, mayViewDocuments, `${role} Documents visibility is incorrect`);
  }
});

test("navigation groups omit empty categories and mobile destinations are role-aware", () => {
  assert.equal(navGroupsForRole("report_viewer").some((group) => group.label === "Members"), false);
  assert.deepEqual(mobileNavForRole("cat_member").map((item) => item.href), ["/", "/directory", "/outreach", "/follow-ups"]);
  assert.deepEqual(mobileNavForRole("membership_data_manager").map((item) => item.href), ["/", "/membership", "/imports"]);
  assert.deepEqual(mobileNavForRole("report_viewer").map((item) => item.href), ["/", "/reports"]);
});

for (const role of ["cat_lead", "cat_member"]) {
  test(`${role} does not receive organization administration links`, () => {
    const hrefs = new Set(navForRole(role).map((item) => item.href));
    for (const href of [
      "/membership", "/new-hires", "/imports", "/campaigns", "/cat-actions",
      "/audit", "/team", "/settings",
    ]) {
      assert.equal(hrefs.has(href), false, `${role} unexpectedly received ${href}`);
    }
    if (role === "cat_member") assert.equal(hrefs.has("/documents"), true);
  });
}
