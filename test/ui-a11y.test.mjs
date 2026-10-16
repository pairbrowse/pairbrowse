// Accessibility of every ui/<page>/index.html: axe-core (pinned dev dependency) over each page as
// the harness renders it (fake helper, the chrome pages' CSP), in its first state and with its
// menus, folds and dialogs that open from a button opened. Zero serious or critical violations.
// Skipped without PAIRBROWSE_TEST_RUNTIME, like the other rendered page tests.
import "./helpers/home.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pageTest, pages, sleep } from "./helpers/ui-page.mjs";

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

// Known violations, each with its reason: "page: rule" -> why.
const EXCEPTIONS = new Map([
  // The engine's own tab pattern: each tab (role tab) carries its close button, so a tab holds a
  // focusable descendant. Tab reaches only the active tab's close (roving tabindex), Delete closes
  // the focused tab, and the close is named "Close <title>". Moving role="tab" onto an inner
  // element would clear it; it touches every tab selector in strip.js and its tests.
  ["strip: nested-interactive", "a tab carries its close button, as in Chromium's own tab strip; Delete closes the focused tab"],
]);
const excepted = (name, line) => EXCEPTIONS.has(`${name}: ${line.replace(/^\([^)]*\) /, "").split(":")[0]}`);

// Violations axe reports as serious or critical, as "rule: target (summary)" lines.
async function audit(page) {
  // Through the DevTools protocol, as the harness reads pages: the page's CSP and Trusted Types
  // don't apply to it, and nothing is added to the page's own code.
  const has = await page.evaluate(() => typeof window.axe === "object");
  if (!has) await page.evaluate(`${AXE}\n;void 0`);
  const found = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} (${(n.failureSummary || v.help).replace(/\s+/g, " ").slice(0, 200)})`));
  });
  return found;
}

// Every button that opens something (aria-expanded="false", aria-haspopup), clicked one at a time,
// audited open, and closed again with Escape.
async function auditOpened(page) {
  const out = [];
  const count = await page.evaluate(() => document.querySelectorAll('[aria-expanded="false"]:not([disabled])').length);
  for (let i = 0; i < Math.min(count, 12); i++) {
    const opened = await page.evaluate((k) => {
      const el = [...document.querySelectorAll('[aria-expanded="false"]:not([disabled])')][k];
      if (!el || !el.checkVisibility?.()) return "";
      el.click();
      return el.id || el.className || el.tagName;
    }, i);
    if (!opened) continue;
    await sleep(250);
    for (const v of await audit(page)) out.push(`(${opened} open) ${v}`);
    await page.keyboard.press("Escape");
    await sleep(150);
  }
  return out;
}

for (const name of pages()) {
  pageTest(name, { timeout: 120_000 }, async ({ page, errors }) => {
    const first = await audit(page);
    const opened = await auditOpened(page);
    const all = [...new Set([...first, ...opened])];
    assert.deepEqual(all.filter((v) => !excepted(name, v)), [], `${name}: serious or critical axe violations`);
    for (const key of EXCEPTIONS.keys()) {
      if (key.startsWith(`${name}: `)) assert.ok(all.some((v) => excepted(name, v)), `${key} no longer happens; drop the exception`);
    }
    assert.deepEqual(errors, []);
  });
}
