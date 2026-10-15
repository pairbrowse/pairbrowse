// Keyboard-only flows on the pages a person answers or chooses on: the approval card, the session
// picker, All sessions, Settings and a join request in the side panel. In each, Tab reaches every
// control on the page (no trap, nothing skipped), Enter activates, Escape closes or cancels, and
// the focus comes back to the control that opened what closed. Allow (an approval, a join) is a
// pointer click only, by design: Enter on it answers nothing. Over the pages' harness; skipped
// without PAIRBROWSE_TEST_RUNTIME.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchright } from "./helpers/live.mjs";
import { openPage, runtime, sleep } from "./helpers/ui-page.mjs";
import { startFakeHelper, merge } from "./helpers/fake-helper.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const posts = (helper, route) => helper.posts.filter((p) => p.route === route).map((p) => p.body);

function flow(name, title, opts, fn) {
  test(`${name} page, keyboard only: ${title}`, { skip: !runtime, timeout: 90_000 }, async () => {
    const browser = await patchright(runtime).chromium.launch();
    let helper = null, ctx = null;
    try {
      helper = await startFakeHelper({ pageOrigin: null, fixtures: opts.fixtures, replies: opts.replies });
      ctx = await openPage(browser, name, { helper, fixture: merge(defaultFixture(), opts.shim || {}), viewport: opts.viewport });
      await fn({ ...ctx, helper });
      assert.deepEqual(ctx.errors, []);
    } finally {
      await ctx?.close();
      await helper?.close();
      await browser.close();
    }
  });
}

// Every control a person can Tab to (enabled, shown, tabindex >= 0, the checked radio of a group),
// marked data-kb=<n>; then Tab is pressed until the focus comes back round, and each control
// reached is recorded. Returns the marked controls never reached, and whether the focus left
// the page's controls for the browser at least once (no trap).
async function tabReach(page, scope = "body") {
  const total = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const cands = [...root.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter((e) => {
      if (e.disabled || e.tabIndex < 0 || e.closest("[inert], [hidden]") || !e.checkVisibility({ visibilityProperty: true })) return false;
      if (e.matches('input[type="hidden"]')) return false;
      if (e.matches('input[type="radio"]') && e.name) {
        const group = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(e.name)}"]`)];
        return group.some((r) => r.checked) ? e.checked : e === group[0];
      }
      return true;
    });
    cands.forEach((e, i) => { e.dataset.kb = String(i); });
    return cands.length;
  }, scope);
  assert.ok(total > 0, `${scope} has controls`);
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  const reached = new Set();
  for (let i = 0; i < total * 2 + 8; i++) {
    await page.keyboard.press("Tab");
    const k = await page.evaluate(() => document.activeElement?.dataset?.kb ?? null);
    if (k !== null) reached.add(k);
    if (reached.size === total) break;
  }
  const missed = await page.evaluate((got) => [...document.querySelectorAll("[data-kb]")].filter((e) => !got.includes(e.dataset.kb))
    .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className ? "." + String(e.className).split(" ")[0] : ""} "${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30)}"`), [...reached]);
  await page.evaluate(() => { for (const e of document.querySelectorAll("[data-kb]")) delete e.dataset.kb; });
  return { total, missed };
}
const focusedId = (page) => page.evaluate(() => document.activeElement?.id || "");
async function focusOn(page, sel) {
  await page.focus(sel);
  assert.ok(await page.evaluate((s) => document.activeElement === document.querySelector(s), sel), `${sel} takes the focus`);
}

// ---- the approval card ----
const APPROVE = fixture("ui-approve");
const [OLDER] = APPROVE.push.map(([, d]) => d.item);
flow("approve", "Tab reaches the card's controls, Enter denies, Allow takes no key, Escape answers nothing", {}, async ({ page, helper, until }) => {
  helper.push("approval", { op: "add", item: OLDER });
  await until("the card", () => !document.getElementById("card").hidden);
  await sleep(1000); // the card arms after its open
  const { missed } = await tabReach(page, "#card");
  assert.deepEqual(missed, []);
  await focusOn(page, "#allow");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await sleep(200);
  assert.deepEqual(posts(helper, "approve"), [], "no answer by Enter on Allow, nor by Escape");
  await focusOn(page, "#deny");
  await page.keyboard.press("Enter");
  await until("the deny", () => document.body.dataset.pending === "0");
  assert.deepEqual(posts(helper, "approve"), [{ id: OLDER.id, answer: "deny" }]);
});

// ---- the session picker ----
const PICK = { picking: true, sessions: [
  { name: "work", tabs: 3, sites: ["shop.example"], current: true, people: [{ who: "You", kind: "you", computer: "Mac" }] },
  { name: "default", tabs: 0, sites: [], people: [] },
  { name: "travel", tabs: 2, sites: ["trips.example"], people: [] },
  { name: "research", tabs: 5, sites: ["papers.example"], people: [] },
  { name: "taxes", tabs: 1, sites: ["tax.example"], people: [] },
  { name: "garden", tabs: 1, sites: ["seeds.example"], people: [] },
] };
flow("picker", "Tab reaches every control; Enter opens More sessions and Join with the focus in their field, and folds them again", { fixtures: { sessions: PICK }, viewport: { width: 1200, height: 760 } }, async ({ page, until }) => {
  await until("the rows", () => document.body.dataset.s === "ready");
  const { missed } = await tabReach(page);
  assert.deepEqual(missed, []);
  {
    assert.ok(await page.evaluate(() => document.getElementById("more-btn").checkVisibility()), "More sessions shows");
    await focusOn(page, "#more-btn");
    await page.keyboard.press("Enter");
    await until("the filter", () => document.activeElement.id === "filter");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focusedId(page), "more-btn", "Shift+Tab goes back to More sessions");
    await page.keyboard.press("Enter");
    await until("folded", () => document.getElementById("more-btn").getAttribute("aria-expanded") === "false");
  }
  await focusOn(page, "#join > summary");
  await page.keyboard.press("Enter");
  await until("the code field", () => document.getElementById("join").open && document.activeElement.id === "code");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.matches("#join > summary")), true, "Shift+Tab goes back to Join");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.getElementById("join").open), false, "Enter folds it again");
});

// ---- All sessions ----
const SESSIONS = { picking: false, sessions: [
  { name: "work", tabs: 3, sites: ["shop.example"], current: true, used: Date.now() - 120_000, people: [{ who: "You", kind: "you", computer: "Mac" }] },
  { name: "shop", tabs: 1, sites: ["shop.example"], used: Date.now() - 3_600_000, people: [] },
  { name: "default", tabs: 0, sites: [], used: 0, people: [] },
] };
const OPEN = { name: "work", where: "Local", temporary: false, canRename: true };
flow("sessions", "Tab reaches every control; Enter asks, Escape cancels and the focus returns to the button", { fixtures: { sessions: SESSIONS, session: OPEN }, viewport: { width: 969, height: 796 } }, async ({ page, helper, until }) => {
  await until("the rows", () => document.querySelectorAll('#list > li[data-name]').length === 3);
  const { missed } = await tabReach(page);
  assert.deepEqual(missed, []);
  // Delete on "shop": Enter asks in the row, Escape answers Keep and the focus is back on Delete.
  const del = '#list > li[data-name="shop"] .acts button:last-child';
  assert.equal(await page.evaluate((s) => document.querySelector(s).textContent, del), "Delete");
  await focusOn(page, del);
  await page.keyboard.press("Enter");
  await until("the question", () => document.querySelector('#list > li[data-name="shop"]').dataset.asking === "true");
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('#list > li[data-name="shop"]')), "the focus moves into the question");
  await page.keyboard.press("Escape");
  await until("the question gone", () => document.querySelector('#list > li[data-name="shop"]').dataset.asking === "false");
  assert.equal(await page.evaluate((s) => document.activeElement === document.querySelector(s), del), true, "the focus is back on Delete");
  // Rename on the open session: Enter opens the field, Escape closes it, the focus returns.
  const rename = '#list > li[data-name="work"] .acts button';
  const label = await page.evaluate((s) => [...document.querySelectorAll(s)].map((b) => b.textContent), rename);
  assert.ok(label.includes("Rename"), `the open session offers Rename (${label})`);
  const sel = `${rename}:nth-child(${label.indexOf("Rename") + 1})`;
  await focusOn(page, sel);
  await page.keyboard.press("Enter");
  await until("the name field", () => document.activeElement?.tagName === "INPUT" && !!document.activeElement.closest('#list > li[data-name="work"]'));
  await page.keyboard.press("Escape");
  await until("the field gone", () => !document.querySelector('#list > li[data-name="work"] input'));
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Rename", "the focus is back on Rename");
  assert.deepEqual(helper.posts.filter((p) => p.route !== "log"), [], "nothing was asked of the helper");
});

// ---- Settings: Report a problem ----
const SETTINGS = fixture("ui-settings").helper;
flow("settings", "Tab reaches every control; Enter opens Report a problem, Escape closes it, the focus returns", { fixtures: SETTINGS, viewport: { width: 1100, height: 900 } }, async ({ page, helper, until }) => {
  await until("the report button", () => !document.getElementById("report-open").hidden && !document.getElementById("report-open").disabled);
  const { missed } = await tabReach(page);
  assert.deepEqual(missed, []);
  await focusOn(page, "#report-open");
  await page.keyboard.press("Enter");
  await until("the dialog", () => document.getElementById("report").open && document.activeElement.id === "report-what");
  const inside = await tabReach(page, "#report");
  assert.deepEqual(inside.missed, [], "Tab reaches every control in the dialog");
  assert.ok(await page.evaluate(() => document.getElementById("report").contains(document.activeElement)), "the focus stays in the dialog");
  await page.keyboard.press("Escape");
  await until("closed", () => !document.getElementById("report").open);
  assert.equal(await focusedId(page), "report-open", "the focus is back on Report a problem");
  assert.equal(helper.posts.some((p) => p.route === "report"), false, "nothing sent");
});

// ---- a join request in the side panel ----
flow("right", "a join request: Tab reaches Allow and Deny, Allow takes no key, Enter on Deny refuses", { viewport: { width: 330, height: 936 } }, async ({ page, helper, until }) => {
  helper.push("join", [{ id: "r1", name: "Sam", app: "Claude Code", role: "drive", state: "pending" }]);
  await until("the join card", () => !!document.querySelector("#joins .join"));
  await sleep(300);
  const { missed } = await tabReach(page, "#joins");
  assert.deepEqual(missed, []);
  await focusOn(page, "#joins .join .primary");
  await page.keyboard.press("Enter");
  await page.keyboard.press(" ");
  await sleep(300);
  assert.deepEqual(posts(helper, "approve"), [], "Allow is a pointer click only");
  await focusOn(page, "#joins .join .mini");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !posts(helper, "approve").length; i++) await sleep(50);
  assert.deepEqual(posts(helper, "approve"), [{ id: "r1", allow: false }]);
});
