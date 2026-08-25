import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the application shell includes a responsive site-wide utility footer", async () => {
  const [shell, frame, footer, css] = await Promise.all([
    read("../src/components/AppShell.tsx"),
    read("../src/components/RouteAwareFrame.tsx"),
    read("../src/components/UtilityFooter.tsx"),
    read("../src/app/stage17-redesign.css"),
  ]);

  assert.match(shell, /<UtilityFooter signedIn=\{Boolean\(user\)\} \/>/);
  assert.match(shell, /<RouteAwareFrame footer=\{footer\}/);
  assert.match(frame, /<div className="route-body">\{children\}<\/div>/);
  assert.match(frame, /\{footer\}[\s\S]*<\/main>/);
  assert.match(frame, /pathname === "\/about"/);
  assert.match(frame, /pathname === "\/accessibility"/);
  assert.match(footer, /aria-label="Site information"/);
  for (const path of ["/about", "/legal/privacy", "/legal/terms", "/accessibility", "/support", "/install"]) {
    assert.match(footer, new RegExp(`href: "${path.replaceAll("/", "\\/")}"`));
  }
  assert.match(footer, /signedIn \? "\/" : "\/sign-in"/);
  assert.match(css, /\.utility-footer-inner \{[\s\S]*display: flex;/);
  assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*\.utility-footer-inner \{ display: grid; \}/);
});

test("recommended public information pages are present and link to support", async () => {
  const [about, terms, accessibility, privacy, support] = await Promise.all([
    read("../src/app/about/page.tsx"),
    read("../src/app/legal/terms/page.tsx"),
    read("../src/app/accessibility/page.tsx"),
    read("../src/app/legal/privacy/page.tsx"),
    read("../src/app/support/page.tsx"),
  ]);

  assert.match(about, /export const metadata/);
  assert.match(about, /There is no public registration/);
  assert.match(terms, /Authorized use only/);
  assert.match(terms, /href="\/legal\/privacy"/);
  assert.match(accessibility, /Report an accessibility barrier/);
  assert.match(accessibility, /href="\/support"/);
  assert.match(privacy, /href="\/support"/);
  assert.match(support, /Never send credentials or member records/);
});
