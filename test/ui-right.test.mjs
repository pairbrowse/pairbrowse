// The right dock (ui/right/) in the pages' harness: window.pairbrowse present (the browser
// build's host), the fake helper's routes and stream. Tabs, the agent card's states in words,
// pause, the Checklist with the task and the saved time, the Status box, the participant rows,
// the session card, Pictures (with and without the timeline, never while hidden), Tools, the
// rail and the hidden dock, the collapse and expand buttons, and the request count. The common
// checks stay in test/ui.test.mjs; the extension host (no shim) is covered by its own scenarios
// here (native: false): among them the side panel's walk-throughs at the end (once
// test/right.test.mjs), with the markup, logo, script and sheet pinned as files.
import "./helpers/home.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageTest, runtime, sleep } from "./helpers/ui-page.mjs";
import { patchright } from "./live.mjs";
import { startFakeHelper, UNMARKED, CONFIRM_PROGRAM, CONFIRM_WEB, FILE_CHANGED, NO_APP } from "./helpers/fake-helper.mjs";
import { startUiServer } from "./helpers/ui-server.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";

const SERVED = readFileSync(new URL("../ui/right/index.html", import.meta.url), "utf8");

const VIEWPORT = { width: 330, height: 936 };
const PEOPLE = [
  { who: "Claude", kind: "agent", color: "#e9763f", tab: "shop.example/checkout", task: "Filling the shipping form", status: "working", last: "Typed into Email" },
  { who: "Alice · Codex", kind: "agent", color: "#7088f0", tab: "shop.example/cart", task: "", status: "you", last: "Clicked Cart" },
  { who: "Sam · Claude Code", kind: "agent", color: "#22d3ee", where: "Sam", tab: "docs.example", task: "", status: "done", last: "Read the docs" },
  { who: "Sam (by hand)", kind: "person", color: "", where: "Sam", status: "idle" },
  { who: "Gemini · Gemini CLI", kind: "agent", color: "#20c997", tab: "shop.example/prices", task: "Checking prices", status: "working" },
  { who: "Bob · Codex", kind: "agent", color: "nope", tab: "bob.example", status: "idle", last: "Opened a tab" },
];
const JOURNAL = { name: "shop.example 2026-10-11 10:00", status: "in progress", done: ["Sign up <https://shop.example/signup>: Filled **Email**", "Details <https://shop.example/details>: Filled **Name**"], yourTurn: ["Enter the code"], left: ["VAT number"], updatedAt: "2026-10-11T10:00:00.000Z" };
// A 16 x 10 JPEG.
const JPEG = "/9j/4AAQSkZJRgABAQAASABIAAD/4QCARXhpZgAATU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAABCgAwAEAAAAAQAAAAoAAAAA/+0AOFBob3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAAOEJJTQQlAAAAAAAQ1B2M2Y8AsgTpgAmY7PhCfv/AABEIAAoAEAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAQEBAQEBAYEBAYJBgYGCQwJCQkJDA8MDAwMDA8SDw8PDw8PEhISEhISEhIVFRUVFRUZGRkZGRwcHBwcHBwcHBz/2wBDAQQFBQcHBwwHBwwdFBAUHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR3/3QAEAAH/2gAMAwEAAhEDEQA/AMqyl6V19lL0rhLLtXXWPavQxmbVtT8hx9Nan//Z";
const CARD = { id: "0123456789ab", t: 1760169600000, caption: "Checkout page", step: { url: "https://shop.example/checkout", title: "Checkout" }, who: "Claude", pinned: false, note: false };
const opts = (fixtures = {}, more = {}) => ({ viewport: VIEWPORT, fixtures, ...more });
const visible = (sel) => { const e = document.querySelector(sel); return !!e && e.checkVisibility(); };
const text = (id) => document.getElementById(id).textContent;
const journalReads = (helper) => helper.gets.filter((r) => r === "journal.json").length;
const posted = async (helper, route, n = 1) => { for (let i = 0; i < 40 && helper.posts.filter((p) => p.route === route).length < n; i++) await sleep(50); return helper.posts.filter((p) => p.route === route); };
// WCAG contrast of an element's text on its composited background (its own and its ancestors'
// background colors, layered from the first opaque one down).
const textContrast = (sel) => {
  const rgba = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const el = document.querySelector(sel);
  const layers = [];
  for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; }
  let bg = { r: 255, g: 255, b: 255 };
  if (layers.length && layers[layers.length - 1].a >= 1) bg = layers.pop();
  for (const c of layers.reverse()) bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
  const fg0 = rgba(getComputedStyle(el).color);
  const fg = { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// The page's own value of a token, as the computed style of a probe.
const token = (name, prop = "color") => {
  const probe = document.createElement("span");
  probe.style[prop] = `var(--${name})`;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe)[prop];
  probe.remove();
  return v;
};

describe("tabs", () => pageTest("right", opts(), async ({ page, inPage, until, errors }) => {
  assert.equal(await inPage(() => document.documentElement.dataset.host), "native");
  assert.equal(await inPage(visible, "#session-line"), false, "no session line, no placeholder, before the helper names a session");
  assert.equal(await inPage(() => getComputedStyle(document.querySelector(".top")).display), "none", "the strip owns the header in the build");
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("[role=tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected"), t.tabIndex])),
    [["Agent", "true", 0], ["Page", "false", -1], ["Screenshots", "false", -1], ["Tools", "false", -1]]);
  // the top of the Agent panel: 8 px under the dock's top, 44 px tall, its labels centred 30 px
  // under the dock's top (the mockup: Agent at y 83, the dock from y 53); the card at the 8 px
  // gutter and its first label on the shared 20 px edge (545)
  assert.deepEqual(await inPage(() => { const r = document.querySelector(".tabs").getBoundingClientRect(); return [r.top, r.height, r.left, innerWidth - r.right]; }), [8, 44, 8, 8]);
  assert.equal(await inPage(() => Math.round(document.getElementById("tab-agent").getBoundingClientRect().left + parseFloat(getComputedStyle(document.getElementById("tab-agent")).paddingLeft))), 20, "the first label 20 px in");
  const mid = await inPage(() => { const r = document.getElementById("tab-agent").getBoundingClientRect(); return r.top + r.height / 2; });
  assert.ok(Math.abs(mid - 30) <= 1, `the tab labels centred 30 px under the dock's top (${mid})`);
  await page.click("#tab-tools");
  assert.deepEqual(await inPage(() => ["agent", "page", "pictures", "tools"].map((t) => document.getElementById(`pane-${t}`).checkVisibility())), [false, false, false, true]);
  assert.equal(await inPage(() => { const a = getComputedStyle(document.getElementById("tab-tools"), "::after"); return a.height === "2px" && a.backgroundColor === "rgb(50, 133, 246)"; }), true, "the accent underline (2 px, under the label)");
  await page.keyboard.press("ArrowLeft");
  await until("Pictures", () => document.getElementById("tab-pictures").getAttribute("aria-selected") === "true" && document.activeElement.id === "tab-pictures");
  await page.keyboard.press("Home");
  await until("Agent", () => document.getElementById("tab-agent").getAttribute("aria-selected") === "true" && document.activeElement.id === "tab-agent");
  assert.equal(await inPage(() => document.getElementById("tab-pictures").tabIndex), -1, "only the selected tab is in the Tab order");
  await page.keyboard.press("End");
  await until("Tools by End", () => document.body.dataset.tab === "tools");
  assert.equal(await inPage(() => document.querySelector('[aria-label="Open the dock as a sheet"]')), null, "no sheet state in the mojom: no sheet button");
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const collapse = await inPage(() => {
    const b = document.getElementById("dock-collapse"), r = b.getBoundingClientRect(), bar = document.querySelector(".tabs").getBoundingClientRect();
    return { w: r.width, h: r.height, right: r.right, middle: r.top + r.height / 2 - (bar.top + (bar.height - 1) / 2), label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded") };
  });
  assert.equal(collapse.w, 28);
  assert.equal(collapse.h, 28);
  assert.ok(Math.abs(collapse.right - (330 - 20)) <= 1, `right edge ${collapse.right}`); // on the shared right edge, inside the Agent panel card
  assert.ok(Math.abs(collapse.middle) <= 1, `vertically centered in the bar (${collapse.middle})`);
  assert.equal(collapse.label, "Collapse the agent panel");
  assert.equal(collapse.expanded, "true");
  assert.equal(await inPage(visible, "#dock-expand"), false, "no expand button while open");
  assert.deepEqual(errors, []);
}));

describe("agent states in words", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  assert.equal(await inPage(text, "driver-text"), "Idle", "connected, nothing done yet");
  assert.equal(await inPage(visible, "#status-live"), false);
  helper.push("activity", [{ t: Date.now(), text: "Typed into **Email**", who: "Claude", tab: "Checkout" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  assert.equal(await inPage(() => document.getElementById("driver").dataset.state), "working");
  // One home for Live (DESIGN.md Part G): in the browser the strip's pill says the session is live
  // and this line says "Working…"; the Status box's Live pill is the side panel's (the side panel scenarios below).
  assert.equal(await inPage(visible, "#status-live"), false, "no Live pill in the browser, even while driving");
  assert.equal(await inPage(() => document.getElementById("status-live").hidden), false, "its state is kept (the side panel shows it)");
  assert.equal(await inPage(() => getComputedStyle(document.querySelector("#driver .dot")).backgroundColor), await inPage(token, "ok"));
  helper.push("status", { kind: "you", text: "Solve the CAPTCHA" });
  await until("your turn", () => document.getElementById("driver-text").textContent === "Waiting for you");
  assert.equal(await inPage(text, "turn-text"), "Solve the CAPTCHA", "the helper's own words");
  assert.equal(await inPage(() => document.body.dataset.turn), "true");
  assert.equal(await inPage(visible, "#turn"), true);
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("driver")).color), await inPage(token, "warn"));
  assert.equal(await inPage(visible, "#status-live"), false, "not driving while it waits for you");
  assert.equal(await inPage(() => document.getElementById("status-live").hidden), true, "not driving: the pill's state is off too");
  helper.push("status", { kind: "clear", text: "" });
  helper.push("pause", { paused: true, can: true, by: "Sam" });
  await until("paused", () => document.getElementById("driver-text").textContent === "Paused by Sam");
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("driver")).color), await inPage(token, "muted"), "paused in --muted, words and dot");
  assert.equal(await inPage(visible, "#turn"), false);
  await page.click("#agent-fold");
  // The body folds with the sheet's motion (.m-fold, DESIGN.md Part I): read where it lands.
  await until("folded", () => document.getElementById("agent-body").getAnimations().length === 0);
  assert.equal(await inPage(visible, "#agent-body"), false, "folded to one line");
  assert.equal(await page.getAttribute("#agent-fold", "aria-expanded"), "false");
  assert.equal(await page.getAttribute("#agent-fold", "aria-label"), "Expand the agent card");
  await page.click("#agent-fold");
  assert.equal(await inPage(visible, "#agent-body"), true);
  assert.deepEqual(errors, []);
}));

// The card is about an agent the helper named (here on the board): with none it is not drawn.
const ONE_AGENT = { people: [{ ...PEOPLE[0], task: "" }], messages: [] };

describe("pause and resume", () => pageTest("right", opts({ pause: { paused: false, can: true }, board: ONE_AGENT }), async ({ page, helper, inPage, until, errors }) => {
  await until("the pause row", () => !document.getElementById("pause").hidden && !document.getElementById("agent").hidden);
  assert.equal(await inPage(text, "pause-btn"), "Pause");
  assert.equal(await page.getAttribute("#pause-btn", "aria-label"), "Pause agents");
  // On the name row: between the name and the fold, and nothing else in the card's header.
  const head = await inPage(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const btn = r("pause-btn"), name = r("agent-name"), driver = r("driver"), fold = r("agent-fold");
    const shown = [...document.getElementById("agent").children].filter((c) => c.id !== "agent-body" && c.checkVisibility()).map((c) => c.id);
    return { mid: btn.top + btn.height / 2, top: name.top, bottom: driver.bottom, right: btn.right, foldLeft: fold.left, shown };
  });
  assert.ok(head.mid >= head.top && head.mid <= head.bottom, `Pause centered on the name and state lines (${head.mid} in ${head.top}..${head.bottom})`);
  assert.ok(head.right <= head.foldLeft, "Pause sits left of the fold");
  assert.deepEqual(head.shown, ["agent-avatar", "agent-name", "driver", "pause", "agent-fold"], "the header holds avatar, name, state, Pause and the fold only");
  const tabLine = await inPage(() => { const t = document.getElementById("agent-tab"); return { inBox: t.closest("#agent-status") !== null, hidden: t.hidden, shown: t.checkVisibility(), text: t.textContent, nameTitle: document.getElementById("agent-name").title }; });
  assert.equal(tabLine.inBox, true, "the tab line stays in the Status box (pinned id)");
  assert.deepEqual([tabLine.hidden, tabLine.shown, tabLine.text], [true, false, ""], "hidden and empty");
  assert.match(tabLine.nameTitle, /^(In \S.*)?$/, "the tab is in #agent-name's title");
  assert.deepEqual(await inPage(() => { const e = document.getElementById("pause-text"); return [e.className, e.getBoundingClientRect().width <= 1]; }), ["sr", true], "the description is for readers only");
  const box = await inPage(() => { const b = document.getElementById("pause-btn"); const s = getComputedStyle(b); return { h: b.getBoundingClientRect().height, bg: s.backgroundColor, border: s.borderTopWidth }; });
  assert.equal(box.h, 32, "B4's Pause: 32 px (--ctl), as every text button in the docks");
  assert.equal(box.bg, await inPage(token, "btn"));
  assert.equal(box.border, "1px");
  await page.click("#pause-btn");
  assert.deepEqual((await posted(helper, "pause"))[0]?.body, { paused: true });
  helper.push("pause", { paused: true, can: true, by: "Sam" });
  await until("resume", () => document.getElementById("pause-btn").textContent === "Resume");
  assert.equal(await page.getAttribute("#pause-btn", "aria-label"), "Resume agents");
  assert.equal(await inPage(text, "pause-text"), "Paused by Sam");
  assert.equal(await inPage(text, "driver-text"), "Paused by Sam", "who paused, in the state line");
  assert.deepEqual(errors, []);
}));

describe("checklist marks, task and saved", () => pageTest("right", opts({ journal: JOURNAL, board: ONE_AGENT }), async ({ page, helper, inPage, until, errors }) => {
  // No task before the goal log is read: the served markup starts with it hidden, the steps open.
  assert.match(SERVED, /<div class="task" id="task" hidden>/, "no task before the goal log is read");
  assert.match(SERVED, /<small class="saved" id="session-saved" hidden>/, "no Saved line before the goal log is read");
  assert.match(SERVED, /<button class="more" id="agent-more"[^>]*aria-expanded="true"/);
  await until("the agent card", () => !document.getElementById("agent").hidden);
  assert.equal(await inPage(visible, "#checklist"), true, "the checklist is open on load");
  helper.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  await until("the checklist, no click needed", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
  const rows = await inPage(() => [...document.querySelectorAll("#checklist-items li")].map((li) => {
    const m = getComputedStyle(li.querySelector(".mark"));
    const r = li.querySelector(".mark").getBoundingClientRect();
    return { state: li.dataset.state, h: li.getBoundingClientRect().height, w: r.width, mh: r.height, bg: m.backgroundColor, color: m.color, border: m.borderTopWidth, borderColor: m.borderTopColor, label: getComputedStyle(li.querySelector(".text")).color };
  }));
  // Every step's label in one light ink (--ink-soft, the mockup's); the state is in the mark's shape.
  for (const r of rows) assert.equal(r.label, "rgb(201, 210, 222)", `${r.state}: the label in --ink-soft`);
  assert.deepEqual(rows.map((r) => r.state), ["done", "current", "waiting", "pending"]);
  for (const r of rows) { assert.ok(r.h >= 28, `${r.state}: ${r.h}px row`); assert.equal(r.w, 17); assert.equal(r.mh, 17); }
  assert.equal(rows[0].bg, await inPage(token, "ok"), "done: filled --ok");
  assert.equal(rows[0].color, "rgb(255, 255, 255)", "the white check");
  assert.equal(rows[1].border, "2px");
  assert.equal(rows[1].borderColor, await inPage(token, "accent-ink"), "current: the mockup's light blue ring (--accent-ink)");
  assert.equal(rows[2].borderColor, await inPage(token, "warn"));
  assert.equal(rows[3].borderColor, await inPage(token, "muted"));
  assert.equal(await inPage(text, "task-name"), JOURNAL.name);
  assert.equal(await inPage(visible, "#task"), true);
  assert.match(await inPage(text, "session-saved"), /^Saved /);
  // The chevron folds the steps only, and reads nothing.
  const reads = journalReads(helper);
  await page.click("#agent-more");
  assert.equal(await inPage(() => document.getElementById("checklist").hidden), true);
  assert.equal(await page.getAttribute("#agent-more", "aria-expanded"), "false");
  assert.equal(await inPage(visible, "#task"), true, "the task stays");
  await sleep(300);
  assert.equal(journalReads(helper), reads, "folding reads nothing");
  assert.deepEqual(errors, []);
}));

describe("journal read follows the Agent tab", () => pageTest("right", opts({ journal: JOURNAL }, { timeout: 90_000 }), async ({ page, helper, harness, shim, until, errors }) => {
  const act = (text) => helper.push("activity", [{ t: Date.now(), text, who: "Claude", tab: "Details" }]);
  const reads = async (n, what) => { for (let i = 0; i < 80 && journalReads(helper) < n; i++) await sleep(50); assert.equal(journalReads(helper), n, what); };
  await reads(1, "one read when the panel connects with Agent in front");
  await sleep(500);
  assert.equal(journalReads(helper), 1, "exactly one");
  // A burst of actions: one more read, at most once per 5 s.
  for (let i = 0; i < 3; i++) { act(`Act ${i}`); await sleep(150); }
  await sleep(5600);
  assert.equal(journalReads(helper), 2, "a burst is one read");
  // Another tab in front: nothing.
  await page.click("#tab-tools");
  act("On Tools");
  await sleep(6000);
  assert.equal(journalReads(helper), 2, "no read while Tools is in front");
  await page.click("#tab-agent");
  await reads(3, "back on Agent: one read");
  // Hidden: nothing, and no timer pending.
  await harness.setHidden(true);
  act("Hidden");
  await sleep(6000);
  assert.equal(journalReads(helper), 3, "no read while hidden");
  assert.equal((await harness.live()).timeouts, 0, "no timer while hidden");
  await harness.setHidden(false);
  await reads(4, "shown again: one read");
  // The rail shows no pane: nothing.
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  act("Railed");
  await sleep(6000);
  assert.equal(journalReads(helper), 4, "no read while the dock is a rail");
  assert.deepEqual(errors, []);
}));

describe("status box", () => pageTest("right", opts({ board: { people: [PEOPLE[0]], messages: [] } }), async ({ helper, inPage, until, errors }) => {
  await until("the status", () => document.getElementById("agent-status-text").textContent === "Filling the shipping form");
  // Its header names what it holds: the agent's own status text, never "reasoning" (545).
  assert.equal(await inPage(() => document.getElementById("status-head").textContent.trim()), "Status");
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("agent-status")).borderTopWidth), "1px");
  // A hand-off ("your turn") is the turn line's: the Status box keeps the agent's own text.
  helper.push("status", { kind: "you", text: "Solve the CAPTCHA" });
  await until("your turn", () => document.getElementById("turn-text").textContent === "Solve the CAPTCHA");
  assert.equal(await inPage(text, "agent-status-text"), "Filling the shipping form", "the Status box is not the turn line");
  // The helper's board then carries the hand-off as the agent's task (status "you"): the box
  // still keeps the last task that was not a hand-off.
  helper.push("board", { people: [{ ...PEOPLE[0], status: "you", task: "Solve the CAPTCHA", tab: "shop.example/pay" }], messages: [] });
  await until("the board's hand-off", () => document.getElementById("agent-name").title === "In shop.example/pay");
  assert.equal(await inPage(text, "agent-status-text"), "Filling the shipping form", "the board's hand-off stays out of the Status box");
  // Its header and its body start on the same line (545).
  const lines = await inPage(() => { const h = document.getElementById("status-head").getBoundingClientRect().left, p = document.querySelector("#agent-status .sbox"), b = p.getBoundingClientRect().left + parseFloat(getComputedStyle(p).paddingLeft); return Math.abs(h - b); });
  assert.ok(lines <= 0.5, `header and body on one line (${lines}px apart)`);
  helper.push("board", { people: [{ ...PEOPLE[0], task: "" }], messages: [] });
  await until("no status", () => document.getElementById("agent-status-text").textContent === "No status from the agent yet.");
  assert.equal(await inPage(visible, "#agent-status"), true, "the box stays");
  assert.deepEqual(errors, []);
}));

describe("participants", () => pageTest("right", opts({ board: { people: PEOPLE, messages: [] }, activity: [{ t: Date.now(), text: "Typed into **Email**", who: "Claude", tab: "Checkout" }] }), async ({ page, helper, inPage, until, errors }) => {
  // In the browser the people (you, guests) are the left dock's: here the agents only (DESIGN.md
  // Part G); the side panel keeps everyone (the side panel scenarios below).
  await until("the rows", () => document.querySelectorAll("#people li").length === 4);
  assert.equal(await inPage(() => [...document.querySelectorAll("#people li")].some((li) => li.textContent.includes("Sam (by hand)"))), false, "no person row");
  const rows = await inPage(() => [...document.querySelectorAll("#people li")].map((li) => {
    const line = (el) => ({ h: el.getBoundingClientRect().height, ws: getComputedStyle(el).whiteSpace });
    const st = li.querySelector(".st");
    return { h: li.getBoundingClientRect().height, text: li.textContent, name: line(li.querySelector(".name")), st: line(st), stText: st.textContent, first: getComputedStyle(st, "::first-letter").textTransform, clamp: getComputedStyle(st).webkitLineClamp };
  }));
  for (const r of rows) {
    assert.ok(r.h >= 56, `${r.text}: ${r.h}px`);
    assert.ok(r.name.h <= 18, `${r.text}: the name is one line (${r.name.h}px)`);
    assert.equal(r.name.ws, "nowrap");
    // The state line wraps to two lines at most (545: "Working · Suggesting inputs" whole).
    assert.ok(r.st.h <= 36, `${r.text}: the state line is two lines at most (${r.st.h}px)`);
    assert.equal(r.clamp, "2");
  }
  const alice = rows.findIndex((r) => r.text.includes("Alice"));
  // the state in the left dock's words (common.js agentWords); the tab in the line's title
  assert.ok(alice >= 0 && rows[alice].stText.startsWith("Waiting for you") && !rows[alice].stText.includes("shop.example/cart"), rows[alice]?.stText);
  const sam = rows.find((r) => r.text.includes("Sam · Claude Code"));
  assert.ok(sam.stText.startsWith("Done") && sam.stText.includes("Sam's browser"), sam.stText);
  assert.ok(rows.find((r) => r.text.includes("Gemini")).stText.startsWith("Working · Checking prices"));
  assert.ok(rows.find((r) => r.text.includes("Bob")).stText.startsWith("Idle"));
  // Idle and Done dots are --muted, as in the left dock (B3), never the agent's own color.
  const muted = await inPage(token, "muted");
  const dots = await inPage(() => [...document.querySelectorAll("#people li")].filter((li) => ["idle", "done"].includes(li.dataset.state)).map((li) => getComputedStyle(li.querySelector(".st")).backgroundImage));
  assert.ok(dots.length >= 2, `idle and done rows (${dots.length})`);
  for (const d of dots) assert.ok(d.includes(muted) && !d.includes("rgb(34, 211, 238)"), d);
  // The rows' dividers run from gutter to gutter; avatars on the shared 20 px edge; the chevrons
  // on the shared right edge (545).
  const edges = await inPage(() => { const li = document.querySelector("#people li").getBoundingClientRect(), av = document.querySelector("#people li .avatar").getBoundingClientRect(), ch = document.querySelector("#people li .chev")?.getBoundingClientRect(); return { li: [li.left, innerWidth - li.right], av: av.left, chev: ch ? innerWidth - ch.right : 20 }; });
  assert.deepEqual(edges, { li: [8, 8], av: 20, chev: 20 });
  assert.match(await inPage((i) => document.querySelectorAll("#people li .st")[i].title, alice), /shop\.example\/cart/);
  assert.equal(rows[alice].first, "uppercase", "the state line starts with a capital");
  const sel = `#people li:nth-child(${alice + 1})`;
  assert.equal(await page.getAttribute(`${sel} .chev`, "aria-expanded"), "false");
  assert.equal(await inPage(visible, `${sel} .acts`), false);
  await page.click(`${sel} .chev`);
  assert.equal(await inPage(visible, `${sel} .acts`), true);
  assert.match(await inPage((s) => document.querySelector(s).textContent, `${sel} .acts`), /Clicked Cart/);
  assert.equal(await inPage(() => document.querySelectorAll(".pause-one").length), 0, "no per-agent pause from today's helper");
  helper.push("pause", { paused: false, can: true, perAgent: true });
  await until("per-agent pause", () => document.querySelectorAll(".pause-one").length === 4);
  // Two or more agents: the card's button stops them all and says so ("Pause all").
  assert.equal(await inPage(text, "pause-btn"), "Pause all");
  assert.equal(await page.getAttribute("#pause-btn", "aria-label"), "Pause all agents");
  // Every Take control says whose: several rows never read as identical buttons.
  assert.ok(await inPage(() => [...document.querySelectorAll(".pause-one")].every((b) => /^Take control from \S/.test(b.getAttribute("aria-label")))), "each Take control names its agent");
  const place = await inPage((s) => {
    const li = document.querySelector(s), p = li.querySelector(".pause-one"), c = li.querySelector(".chev");
    return { col: getComputedStyle(p).gridColumnStart, right: p.getBoundingClientRect().right, chev: c.getBoundingClientRect().left };
  }, sel);
  assert.equal(place.col, "3", "Pause this agent in column 3");
  assert.ok(place.right <= place.chev, "left of the chevron");
  assert.equal(await inPage(() => [...document.querySelectorAll("#people li")].filter((li) => li.textContent.startsWith("Sam (by hand)") && li.querySelector(".pause-one")).length), 0, "agents only");
  await inPage((s) => document.querySelector(s).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })), `${sel} .pause-one`);
  await sleep(300);
  assert.equal(helper.posts.filter((p) => p.route === "pause").length, 0, "a synthetic click pauses nothing");
  await page.click(`${sel} .pause-one`);
  assert.deepEqual((await posted(helper, "pause"))[0]?.body, { paused: true, who: "Alice · Codex" });
  // From the keyboard: a trusted Enter pauses too (pausing is the safe direction), once the first
  // answer is in (a press while the request is out is the same press: the button says busy).
  await until("answered", (q) => !document.querySelector(q)?.hasAttribute("aria-busy"), `${sel} .pause-one`);
  await page.focus(`${sel} .pause-one`);
  await page.keyboard.press("Enter");
  assert.deepEqual((await posted(helper, "pause", 2))[1]?.body, { paused: true, who: "Alice · Codex" }, "Enter on Pause this agent pauses it");
  // Take control on every agent row, by its accessible name; icon-only on a row with a task line
  // (Gemini: "Checking prices"), whose state line then shows in full; with its text where there is none.
  const take = await inPage(() => [...document.querySelectorAll("#people li")].filter((li) => li.querySelector(".pause-one")).map((li) => {
    const b = li.querySelector(".pause-one"), st = li.querySelector(".st");
    return { who: li.querySelector(".name").title, name: b.getAttribute("aria-label") || b.textContent.trim(), icon: b.classList.contains("icon"), text: b.textContent.trim(), title: b.title, fits: st.scrollWidth <= st.clientWidth, w: b.getBoundingClientRect().width };
  }));
  assert.equal(take.length, 4);
  for (const t of take) { assert.match(t.name, /Take control/, t.who); assert.match(t.title, /you take control/, t.who); }
  const gemini = take.find((t) => t.who.startsWith("Gemini"));
  assert.deepEqual([gemini.icon, gemini.text, gemini.w, gemini.fits], [true, "", 32, true], "Gemini: icon-only (32 x 32, --ctl), the task line in full");
  // Take control (text and icon) and Pause share one height; the buttons and chevrons one right edge.
  assert.deepEqual(await inPage(() => [...new Set([...document.querySelectorAll(".pause-one, #pause-btn")].map((b) => b.getBoundingClientRect().height))]), [32]);
  assert.deepEqual(await inPage(() => [...new Set([...document.querySelectorAll("#people .chev, #agent-fold")].map((b) => innerWidth - b.getBoundingClientRect().right))]), [20]);
  const aliceBtn = take.find((t) => t.who === "Alice · Codex");
  assert.deepEqual([aliceBtn.icon, aliceBtn.text], [false, "Take control"], "no task line: the button keeps its text");
  await page.focus("#people li .pause-one.icon");
  assert.equal(await inPage(() => document.activeElement.classList.contains("icon")), true, "the icon-only button takes focus");
  // Part H: an agent held on its own shows it and offers Resume (Take control was one-way).
  helper.push("pause", { paused: false, can: true, perAgent: true, agents: [{ who: "Alice · Codex", by: "You", at: Date.now() }] });
  await until("Resume on Alice", () => [...document.querySelectorAll("#people li")].some((li) => li.querySelector(".name")?.title === "Alice · Codex" && li.querySelector(".pause-one")?.textContent === "Resume"));
  const held = await inPage(() => { const li = [...document.querySelectorAll("#people li")].find((x) => x.querySelector(".name")?.title === "Alice · Codex"); return { name: li.querySelector(".pause-one").getAttribute("aria-label"), state: li.querySelector(".state").textContent }; });
  assert.equal(held.name, "Resume Alice");
  const n = helper.posts.filter((p) => p.route === "pause").length;
  await page.click("#people li .pause-one[aria-label='Resume Alice']");
  assert.deepEqual((await posted(helper, "pause", n + 1))[n]?.body, { paused: false, who: "Alice · Codex" });
  assert.deepEqual(errors, []);
}));

describe("checklist read retried on return", () => pageTest("right", opts({ journal: JOURNAL }), async ({ page, helper, inPage, until, errors }) => {
  await until("the first read", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
  // The goal log not reached once: the next show of the Agent tab reads again, no timer meanwhile.
  await page.route("**/journal.json", (r) => r.abort());
  helper.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
  for (let i = 0; i < 160 && !(await inPage(() => document.getElementById("checklist-items").textContent.includes("Couldn't reach PairBrowse."))); i++) await sleep(50);
  assert.match(await inPage(text, "checklist-items"), /Couldn't reach PairBrowse\./);
  await page.unroute("**/journal.json");
  await page.click("#tab-tools");
  const reads = journalReads(helper);
  await sleep(300);
  assert.equal(journalReads(helper), reads, "nothing read while another tab is in front");
  await page.click("#tab-agent");
  for (let i = 0; i < 160 && journalReads(helper) === reads; i++) await sleep(50);
  assert.equal(journalReads(helper), reads + 1, "read once more on return");
  await until("the steps back", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
  assert.deepEqual(errors, []);
}));

describe("session card", () => pageTest("right", opts({ session: { name: "Checkout test", where: "Local", temporary: false } }), async ({ page, helper, inPage, until, errors }) => {
  await until("the session name", () => document.getElementById("session-name").textContent === "Checkout test");
  assert.equal(await inPage(visible, "#session-line"), true);
  const card = await inPage(() => { const c = document.getElementById("session-card").getBoundingClientRect(); return { bottom: c.bottom, vh: innerHeight }; });
  assert.ok(card.vh - card.bottom >= 0 && card.vh - card.bottom <= 12, `a raised card just above the bottom (its 8 px margin): ${card.vh - card.bottom}`);
  // Part H: in the browser the session card switches nothing (the strip's logo and the left dock's
  // Sessions row do) and End session, which only opened the picker, is gone: no Save, no buttons.
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#session-card button")].filter((b) => b.checkVisibility()).map((b) => b.id)), [], "no Share, Save, Switch or fold without a helper route");
  assert.equal(await inPage(() => !!document.getElementById("end-confirm")), false);
  assert.equal(await inPage(visible, "#share-card"), false);
  // At the gutter on every side, its icon on the shared 20 px edge.
  assert.deepEqual(await inPage(() => { const c = document.getElementById("session-card").getBoundingClientRect(), i = document.querySelector("#session-card .sicon").getBoundingClientRect(); return [c.left, innerWidth - c.right, innerHeight - c.bottom, i.left]; }), [8, 8, 8, 20]);
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  await sleep(200);
  assert.equal(helper.posts.filter((p) => p.route === "picker").length, 0);
  assert.equal(dialogs, 0, "no JavaScript dialog");
  assert.deepEqual(errors, []);
}));

describe("session card in the side panel: Switch session", () => pageTest("right", opts({ session: { name: "Checkout test", where: "Local", temporary: false } }, { native: false }), async ({ page, helper, inPage, until, errors }) => {
  await until("the session name", () => document.getElementById("session-name").textContent === "Checkout test");
  // Part H: the button says what it does (it was "End session" and only opened the picker).
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#session-card .row3 button")].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim())), ["Share", "Switch session"]);
  await inPage(() => document.getElementById("switch-btn").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await sleep(200);
  assert.equal(helper.posts.filter((p) => p.route === "picker").length, 0, "a synthetic click switches nothing");
  await page.click("#switch-btn");
  assert.equal((await posted(helper, "picker")).length, 1);
  await until("said", () => document.getElementById("session-msg").textContent === "The session picker opened in a new tab.");
  helper.replies.picker = () => ({ status: 404, body: { error: "Not found" } });
  await page.click("#switch-btn");
  await until("refused", () => document.getElementById("session-msg").textContent === "Couldn't open the session picker.");
  assert.deepEqual(errors, []);
}));

describe("session card with the helper's routes", () => pageTest("right", opts({ session: { name: "Checkout test", where: "Local", canSave: true, canRename: true } }), async ({ page, helper, inPage, until, errors }) => {
  await until("Save and the pencil", () => document.getElementById("session-save").checkVisibility() && document.getElementById("session-rename").checkVisibility());
  // Save alone takes the row (the browser's session card, Part H).
  assert.equal(await inPage(() => Math.abs(document.getElementById("session-save").getBoundingClientRect().width - document.getElementById("session-actions").getBoundingClientRect().width) <= 1), true, "Save takes the row");
  assert.equal(await inPage(visible, "#switch-btn"), false);
  const sessions = () => helper.posts.filter((p) => p.route === "session");
  // Save: a synthetic click posts nothing; a person's click saves.
  await inPage(() => document.getElementById("session-save").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await sleep(300);
  assert.equal(sessions().length, 0, "a synthetic click saves nothing");
  await page.click("#session-save");
  assert.deepEqual((await posted(helper, "session"))[0]?.body, { op: "save" });
  await until("saved just now", () => document.getElementById("session-saved").textContent === "Saved just now");
  // Rename: the pencil opens the field; Enter posts the trimmed name.
  await page.click("#session-rename");
  await until("the field", () => document.activeElement?.id === "session-name-input");
  assert.equal(await inPage(visible, "#session-line"), false);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Renamed");
  await page.keyboard.press("Enter");
  assert.deepEqual((await posted(helper, "session", 2))[1]?.body, { op: "rename", name: "Renamed" });
  await until("the new name", () => document.getElementById("session-name").textContent === "Renamed" && document.getElementById("session-line").checkVisibility());
  assert.equal(await inPage(() => document.activeElement?.id), "session-rename", "focus back on the pencil");
  // Escape cancels with no post.
  await page.click("#session-rename");
  await until("the field again", () => document.activeElement?.id === "session-name-input");
  await page.keyboard.type(" more");
  await page.keyboard.press("Escape");
  await until("closed", () => document.getElementById("session-name-input").hidden);
  await sleep(200);
  assert.equal(sessions().length, 2, "Escape posts nothing");
  assert.equal(await inPage(text, "session-name"), "Renamed");
  // A helper without the route (404): Save goes away.
  helper.replies.session = () => ({ status: 404, body: { error: "Not found" } });
  await page.click("#session-save");
  await until("Save hidden", () => document.getElementById("session-save").hidden);
  assert.equal(await inPage(() => document.activeElement?.id), "session-card", "focus moves to the card (Share is the strip's here), not lost to the body");
  assert.equal(await inPage(visible, "#session-fold"), false, "nothing left to fold");
  assert.deepEqual(errors, []);
}));

describe("pictures with the timeline", () => pageTest("right", opts({ timeline: { cards: [CARD] }, pictures: { [CARD.id]: JPEG } }), async ({ page, helper, harness, shim, inPage, until, errors }) => {
  assert.equal(await inPage(() => document.getElementById("picture-img").getAttribute("src")), null, "nothing fetched while the tab is not shown");
  // timeline.json not reached once: asked again the next time the tab opens, not given up on.
  let refused = 0;
  await page.route("**/timeline.json", (r) => { refused++; return r.abort(); });
  await page.click("#tab-pictures");
  for (let i = 0; i < 40 && !refused; i++) await sleep(50);
  assert.equal(refused, 1);
  await sleep(200);
  assert.equal(await inPage(visible, "#pictures-empty"), true);
  await page.unroute("**/timeline.json");
  await page.click("#tab-agent");
  await page.click("#tab-pictures");
  await until("the picture", () => document.getElementById("picture-img").src.startsWith("blob:"));
  assert.equal(await inPage(text, "picture-caption"), "Checkout page");
  assert.notEqual(await inPage(text, "picture-time"), "");
  assert.equal(await inPage(visible, "#pictures-empty"), false);
  assert.ok(await inPage(() => document.getElementById("picture-img").getBoundingClientRect().width <= innerWidth), "scaled to the dock");
  const first = await inPage(() => document.getElementById("picture-img").src);
  helper.fixtures.pictures["0123456789ac"] = JPEG;
  helper.push("timeline", { op: "add", card: { id: "0123456789ac", t: Date.now(), caption: "Cart", note: false } });
  await until("the next picture", () => document.getElementById("picture-caption").textContent === "Cart");
  assert.notEqual(await inPage(() => document.getElementById("picture-img").src), first, "a new blob URL");
  helper.push("timeline", { op: "add", card: { id: "0123456789ae", t: Date.now(), caption: "A note", note: true } });
  await sleep(300);
  assert.equal(await inPage(text, "picture-caption"), "Cart", "a note has no picture");
  await harness.setHidden(true);
  helper.fixtures.pictures["0123456789ad"] = JPEG;
  helper.push("timeline", { op: "add", card: { id: "0123456789ad", t: Date.now(), caption: "Later", note: false } });
  await sleep(400);
  assert.equal(await inPage(text, "picture-caption"), "Cart", "nothing fetched while hidden");
  await harness.setHidden(false);
  await until("shown on return", () => document.getElementById("picture-caption").textContent === "Later");
  // The dock as a rail shows no pane: nothing fetched until it opens again on Pictures.
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  helper.fixtures.pictures["0123456789af"] = JPEG;
  helper.push("timeline", { op: "add", card: { id: "0123456789af", t: Date.now(), caption: "Railed", note: false } });
  await sleep(400);
  assert.equal(await inPage(text, "picture-caption"), "Later", "nothing fetched while the dock is a rail");
  await shim.layout({ right: 2 });
  await until("shown when the dock opens", () => document.documentElement.dataset.dock === "open" && document.getElementById("picture-caption").textContent === "Railed");
  await page.click("#tab-agent");
  helper.push("timeline", { op: "show", id: CARD.id });
  await until("show", () => document.body.dataset.tab === "pictures" && document.getElementById("picture-caption").textContent === "Checkout page");
  assert.equal(await page.getAttribute("#tab-pictures", "aria-selected"), "true");
  assert.deepEqual(errors, []);
}));

describe("pictures without the timeline", () => pageTest("right", opts({ timeline: { cards: [] } }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-pictures");
  await until("the empty line", () => document.getElementById("pictures-empty").checkVisibility());
  assert.equal(await inPage(text, "pictures-empty"), "Nothing sent yet.");
  assert.equal(await inPage(visible, "#picture"), false);
  await page.click("#tab-page");
  await until("the outline read", () => document.getElementById("outline-empty").textContent === "No outline yet: it shows once an agent reads a page.");
  assert.deepEqual(errors, []);
}));

// Part H: the Page tab reads outline.json when shown and on new activity while in front.
describe("page tab: the outline an agent read", () => pageTest("right", opts({ outline: { outline: { tab: "t1", host: "shop.example", who: "Claude", at: Date.now(), cut: false, text: "- heading \"Checkout\"\n- textbox \"Email\"" } } }), async ({ page, helper, inPage, until, errors }) => {
  await until("live", () => document.body.dataset.s === "live");
  const reads = () => helper.gets.filter((r) => r === "outline.json").length;
  const before = reads();
  await page.click("#tab-page");
  await until("the outline", () => document.getElementById("outline").checkVisibility());
  assert.match(await inPage(text, "outline"), /textbox "Email"/);
  assert.match(await inPage(text, "outline-head"), /^shop\.example · read by Claude · /);
  assert.equal(await inPage(visible, "#outline-empty"), false);
  assert.ok(reads() > before);
  helper.fixtures.outline = { outline: null };
  const n = reads();
  helper.push("activity", [{ t: Date.now(), text: "Clicked **Pay**", who: "Claude", tab: "Checkout" }]);
  await until("read again", () => document.getElementById("outline-empty").checkVisibility());
  assert.ok(reads() > n);
  await page.click("#tab-agent");
  const m = reads();
  helper.push("activity", [{ t: Date.now(), text: "Typed", who: "Claude", tab: "Checkout" }]);
  await sleep(300);
  assert.equal(reads(), m, "not read while another tab is in front");
  assert.deepEqual(errors, []);
}));

describe("tools", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  assert.deepEqual(await inPage(() => ["sec-details", "sec-secrets", "dev", "hosts"].map((id) => document.getElementById(id).closest(".pane").id)), ["pane-tools", "pane-tools", "pane-tools", "pane-tools"]);
  // Dev servers' one home (DESIGN.md Part G; Settings has none): the rows and Stop, here.
  helper.push("dev", { asks: [], shared: [{ port: 3000 }], open: [{ port: 5173, title: "Vite" }], joiners: 1 });
  await until("the dev section", () => !document.getElementById("dev").hidden && document.querySelectorAll("#devs li").length === 2);
  assert.match(await inPage(text, "devs"), /localhost:3000 · shared/);
  await page.click("#dev .disclose");
  await page.click("#devs li:first-child button");
  assert.deepEqual((await posted(helper, "dev")).map((p) => p.body), [{ op: "unshare", port: 3000 }]);
  helper.push("profile", { details: [{ label: "VAT", value: "1", source: "you" }], secrets: [] });
  await until("a detail", () => !!document.querySelector("#details .row"));
  assert.equal(await inPage(text, "record-btn"), "Record");
  assert.equal(await inPage(visible, "#record-btn"), true);
  assert.equal(await inPage(() => document.getElementById("record-btn").closest("section")?.id), "sec-recordings", "Record sits in the Recordings section");
  assert.equal(await inPage(() => document.getElementById("record-note").closest("section")?.id), "sec-recordings");
  assert.equal(await inPage(() => document.querySelector("section.record")), null, "the old Recording block is gone");
  assert.deepEqual(errors, []);
}));

// ---- The Tools tab's sections (TOOLS-CONTRACT.md) ----
const NOW = Date.now();
const LIST_ROUTES = ["handoffs.json", "downloads.json", "recordings.json"];
const reads = (helper, route) => helper.gets.filter((r) => r === route).length;
const waitFor = async (what, fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } assert.fail(`timed out waiting for ${what}`); };
const synthetic = (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
const HANDOFFS = [
  { id: "h2", kind: "captcha", text: "Solve the CAPTCHA on the cart page", tab: { id: 12, host: "cart.example", title: "Cart" }, by: { label: "Alice · Codex", color: "#7088f0" }, at: NOW - 60_000 },
  { id: "h1", kind: "2fa", text: "Enter the code sent to your phone", tab: { id: 11, host: "shop.example", title: "Shop" }, by: { label: "Claude", color: "#e9763f" }, at: NOW - 120_000 },
];
const DOWNLOADS = [
  { id: "d1", name: "invoice-2026-10.pdf", size: 2_400_000, at: NOW - 30_000, from: { host: "shop.example", title: "Invoices" }, state: "done", by: { label: "Claude", color: "#e9763f" } },
  { id: "d2", name: "export.csv", size: 0, at: NOW - 20_000, from: { host: "data.example", title: "Export" }, state: "failed", by: { label: "Alice · Codex", color: "#7088f0" } },
  { id: "d3", name: "big-video.mp4", size: 52_000_000, at: NOW - 10_000, from: { host: "media.example", title: "Media" }, state: "in-progress", by: { label: "Claude", color: "#e9763f" } },
];
const RECORDINGS = [
  { id: "r1", name: "pairbrowse-0910.webm", size: 4_200_000, at: NOW - 3_600_000, duration: 83 },
  { id: "r2", name: "pairbrowse-1015.webm", size: 52_000_000, at: NOW - 60_000, duration: 3700 },
];

describe("tools order and reads", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  await sleep(300);
  for (const r of LIST_ROUTES) assert.equal(reads(helper, r), 0, `no ${r} before the Tools tab is shown`);
  await page.click("#tab-tools");
  await waitFor("the three reads", () => LIST_ROUTES.every((r) => reads(helper, r) === 1));
  const secs = await inPage(() => [...document.querySelectorAll("#pane-tools .scroll > section")].map((sec) => {
    const b = sec.querySelector(".disclose");
    return { id: sec.id, head: b ? [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("") : "", expanded: b?.getAttribute("aria-expanded") ?? null };
  }));
  // In the browser (DESIGN.md Part G) Join addresses, Remembered details and Passwords are the
  // Settings page's, with one row here that opens it; the side panel keeps all of them
  // (the side panel scenarios below).
  assert.deepEqual(secs.map((x) => x.id), ["sec-handoffs", "sec-downloads", "sec-recordings", "dev", "hosts", "sec-details", "sec-secrets", "sec-settings-link", "sec-diag"]);
  assert.deepEqual(secs.map((x) => x.head), ["Hand-offs", "Downloads", "Recordings", "Dev servers", "Join addresses", "Remembered details", "Passwords", "", "Diagnostics"]);
  assert.deepEqual(secs.map((x) => x.expanded), ["true", "true", "true", "false", "false", "false", "false", null, "false"]);
  helper.push("dev", { asks: [], shared: [{ port: 3000 }], open: [], joiners: 1 });
  helper.push("joinhost", { asks: [], hosts: [{ host: "tunnel.example.org", always: true }] });
  await until("Hand-offs and Downloads shown", () => document.getElementById("sec-handoffs").checkVisibility() && document.getElementById("sec-downloads").checkVisibility());
  await until("Dev servers shown", () => document.getElementById("dev").checkVisibility());
  const shownNow = await inPage(() => [...document.querySelectorAll("#pane-tools .scroll > section")].filter((sec) => sec.checkVisibility()).map((sec) => sec.id));
  assert.deepEqual(shownNow, ["sec-handoffs", "sec-downloads", "sec-recordings", "dev", "sec-settings-link"], "the browser's Tools: Diagnostics is in Settings (Part H)");
  assert.equal(await inPage(text, "settings-link-note"), "Passwords, remembered details, join addresses and diagnostics are in Settings.");
  // Open settings: the Settings page on its Passwords section, in a new tab of this window.
  await page.click("#open-settings");
  await until("a settings tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual(await inPage(() => window.__pairbrowse.calls.filter((c) => c.iface === "tabs" && c.method === "create").map((c) => c.args)), [["pairbrowse://settings#passwords", true, -1]]);
  assert.equal(await inPage(text, "handoffs-empty"), "Nothing waiting for you.");
  assert.equal(await inPage(text, "downloads-empty"), "Nothing downloaded in this session.");
  await until("No recordings yet", () => document.getElementById("recordings-empty").checkVisibility());
  await page.click("#tab-agent");
  await page.click("#tab-tools");
  await sleep(300);
  for (const r of LIST_ROUTES) assert.equal(reads(helper, r), 1, `${r}: once per connection`);
  assert.equal(reads(helper, "diagnostics.json"), 0, "the browser's dock never reads diagnostics (Settings does)");
  assert.deepEqual(errors, []);
}));

describe("hand-offs", () => pageTest("right", opts({ handoffs: { items: HANDOFFS } }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", () => document.querySelectorAll("#handoffs li").length === 2);
  const rows = () => inPage(() => [...document.querySelectorAll("#handoffs li")].map((li) => {
    const a = li.querySelector(".avatar");
    return { kind: li.querySelector(".kind").textContent, label: a?.getAttribute("aria-label"), bg: a && getComputedStyle(a).backgroundColor, text: li.querySelector(".text").textContent,
      meta: li.querySelector(".meta").textContent, show: li.querySelector("button").getAttribute("aria-label") };
  }));
  assert.deepEqual(await rows(), [
    { kind: "Two-step code", label: "Claude", bg: "rgb(233, 118, 63)", text: "Enter the code sent to your phone", meta: "shop.example · Claude", show: "Show the tab on shop.example" },
    { kind: "CAPTCHA", label: "Alice", bg: "rgb(112, 136, 240)", text: "Solve the CAPTCHA on the cart page", meta: "cart.example · Alice · Codex", show: "Show the tab on cart.example" },
  ], "oldest first, the kind in words, who in their color");
  assert.equal(await inPage(text, "handoffs-count"), "2");
  assert.equal(await inPage(visible, "#handoffs-count"), true);
  assert.equal(await inPage(text, "handoffs-said"), "2 steps waiting for you");
  assert.equal(await inPage(visible, "#handoffs-empty"), false);
  const shows = () => helper.posts.filter((p) => p.route === "handoffs");
  await inPage(synthetic, "#handoffs li:first-child button");
  await sleep(300);
  assert.equal(shows().length, 0, "a synthetic click shows nothing");
  await page.click("#handoffs li:first-child button");
  assert.deepEqual((await posted(helper, "handoffs"))[0]?.rest, ["h1", "show"]);
  const add = (id, kind) => helper.push("handoffs", { op: "add", item: { id, kind, text: `Step ${id}`, tab: { id: 13, host: "pay.example", title: "Pay" }, by: { label: "Claude", color: "#e9763f" }, at: Date.now() } });
  add("h3", "login"); add("h4", "payment"); add("h5", "other");
  await until("five rows", () => document.querySelectorAll("#handoffs li").length === 5);
  assert.deepEqual((await rows()).map((r) => r.kind), ["Two-step code", "CAPTCHA", "Sign in", "Payment", "Your turn"]);
  helper.push("handoffs", { op: "add", item: { id: "h9", kind: "nope", text: "Unknown kind", at: Date.now() } });
  helper.push("handoffs", { op: "remove", item: { id: "h3" } });
  await until("four rows", () => document.querySelectorAll("#handoffs li").length === 4);
  assert.equal(await inPage(text, "handoffs-count"), "4", "an unknown kind is skipped");
  assert.equal(await inPage(text, "handoffs-said"), "4 steps waiting for you");
  // Gone meanwhile (404): the row goes, in words, and the focus moves to the next row's Show.
  helper.replies.handoffs = () => ({ status: 404, body: { ok: false } });
  await page.click("#handoffs li:first-child button");
  await until("the row goes", () => document.querySelectorAll("#handoffs li").length === 3);
  assert.equal(await inPage(text, "handoffs-msg"), "That step is no longer waiting.");
  assert.equal(await inPage(() => document.activeElement?.closest("#handoffs") !== null && document.activeElement.tagName), "BUTTON", "focus stays in the list");
  for (const id of ["h2", "h4", "h5"]) helper.push("handoffs", { op: "remove", item: { id } });
  await until("none waiting", () => document.getElementById("handoffs-empty").checkVisibility());
  assert.equal(await inPage(text, "handoffs-empty"), "Nothing waiting for you.");
  assert.equal(await inPage(visible, "#handoffs-count"), false);
  assert.equal(await inPage(text, "handoffs-said"), "Nothing waiting for you");
  const meta = await inPage(textContrast, "#handoffs-empty");
  assert.ok(meta >= 4.5, `the empty line keeps AA: ${meta.toFixed(2)}:1`);
  assert.deepEqual(errors, []);
}));

describe("downloads", () => pageTest("right", opts({ downloads: { items: DOWNLOADS } }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", () => document.querySelectorAll("#downloads li").length === 3);
  const rows = () => inPage(() => [...document.querySelectorAll("#downloads li")].map((li) => ({
    name: li.querySelector(".name").textContent, meta: li.querySelector(".meta").textContent, state: li.querySelector(".state").textContent, data: li.dataset.state,
    buttons: [...li.querySelectorAll("button")].map((b) => [b.textContent, b.getAttribute("aria-label")]),
  })));
  const reveal = await inPage(() => (/mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "Show in Finder" : "Show in folder"));
  const revealLabel = reveal === "Show in Finder" ? "Show invoice-2026-10.pdf in Finder" : "Show invoice-2026-10.pdf in its folder";
  const r = await rows();
  assert.deepEqual(r.map((x) => x.name), ["big-video.mp4", "export.csv", "invoice-2026-10.pdf"], "newest first");
  assert.deepEqual(r.map((x) => x.state), ["Downloading", "Failed", "Done"], "the state in words");
  assert.deepEqual(r.map((x) => x.data), ["in-progress", "failed", "done"]);
  assert.equal(r[2].meta, "2.4 MB · shop.example · Claude");
  assert.equal(r[1].meta, "data.example · Alice · Codex", "no size when none is known");
  assert.deepEqual(r.map((x) => x.buttons.length), [0, 0, 2], "actions on Done rows only");
  assert.deepEqual(r[2].buttons, [["Open", "Open invoice-2026-10.pdf"], [reveal, revealLabel]]);
  const dots = await inPage(() => [...document.querySelectorAll("#downloads li .sd")].map((d) => getComputedStyle(d).backgroundColor));
  assert.deepEqual(dots, [await inPage(token, "muted"), await inPage(token, "bad"), await inPage(token, "ok")]);
  const sel = '#downloads li[data-state="done"] button';
  await inPage(synthetic, sel);
  await sleep(300);
  assert.equal(helper.posts.filter((p) => p.route === "downloads").length, 0, "a synthetic click opens nothing");
  await page.click(sel);
  assert.deepEqual((await posted(helper, "downloads"))[0]?.rest, ["d1", "open"]);
  await page.click(`${sel}:nth-of-type(2)`);
  assert.deepEqual((await posted(helper, "downloads", 2))[1]?.rest, ["d1", "reveal"]);
  for (const s of ["#downloads .meta", "#downloads .state"]) {
    const c = await inPage(textContrast, s);
    assert.ok(c >= 4.5, `${s} keeps AA on the card: ${c.toFixed(2)}:1`);
  }
  // An update patches the same row in place, without taking the focus.
  await inPage(() => { window.__d3 = document.querySelector("#downloads li:first-child"); });
  await page.focus(sel);
  helper.push("downloads", { op: "update", item: { ...DOWNLOADS[2], state: "done" } });
  await until("d3 done", () => window.__d3.dataset.state === "done");
  assert.equal(await inPage(() => document.querySelector("#downloads li:first-child") === window.__d3), true, "the same element");
  assert.equal(await inPage(() => window.__d3.querySelector(".state").textContent), "Done");
  assert.equal(await inPage(() => window.__d3.querySelectorAll("button").length), 2, "the buttons come with Done");
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Open invoice-2026-10.pdf", "the focus stays");
  helper.push("downloads", { op: "add", item: { id: "d4", name: "receipt.pdf", size: 812, at: Date.now(), from: { host: "shop.example", title: "Receipt" }, state: "in-progress" } });
  await until("d4 first", () => document.querySelector("#downloads li:first-child .name")?.textContent === "receipt.pdf");
  assert.equal(await inPage(() => document.querySelector("#downloads li:first-child .meta").textContent), "812 bytes · shop.example");
  assert.equal(await inPage(() => document.querySelector("#downloads li:first-child .avatar")), null, "no avatar without who");
  helper.replies.downloads = () => ({ status: 404, body: { error: "That file is no longer in Downloads." } });
  await page.click('#downloads li[data-state="done"]:last-child button');
  await until("the helper's words", () => document.getElementById("downloads-msg").textContent === "That file is no longer in Downloads.");
  assert.deepEqual(errors, []);
}));

const ASKED = [
  { id: "p1", name: "run.command", size: 900, at: NOW - 30_000, from: { host: "tools.example" }, state: "done", program: true },
  { id: "h1", name: "page.html", size: 4_000, at: NOW - 20_000, from: { host: "mail.example" }, state: "done", program: true },
  { id: "u1", name: "old.pdf", size: 1_000, at: NOW - 10_000, from: { host: "shop.example" }, state: "done", marked: false },
];
describe("downloads: the helper's confirm and refusal in the row", () => pageTest("right", opts({ downloads: { items: ASKED } }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", () => document.querySelectorAll("#downloads li").length === 3);
  const opens = () => helper.posts.filter((p) => p.route === "downloads" && p.rest[1] === "open");
  const box = (id) => inPage((i) => {
    const b = document.getElementById(`dl-confirm-${i}`);
    return b && { hidden: b.hidden, text: b.querySelector("p").textContent, choice: !b.querySelector(".confirm-row").hidden,
      buttons: [...b.querySelectorAll(".confirm-row button")].map((x) => x.textContent), focus: document.activeElement?.textContent };
  }, id);
  const confirm = await inPage(() => typeof window.confirm);
  await inPage(() => { window.confirm = () => { window.__asked = true; return true; }; });

  // 428: the sentence in the row, Open anyway and Cancel; nothing opened yet.
  await page.click('button[aria-label="Open run.command"]');
  await until("the question", () => document.getElementById("dl-confirm-p1")?.hidden === false);
  assert.deepEqual(await box("p1"), { hidden: false, text: CONFIRM_PROGRAM, choice: true, buttons: ["Open anyway", "Cancel"], focus: "Cancel" });
  assert.deepEqual(opens().map((p) => p.body), [null], "the first Open carries no body");
  // A synthetic click on Open anyway sends nothing.
  await inPage(synthetic, "#dl-confirm-p1 .confirm-row button");
  await sleep(300);
  assert.equal(opens().length, 1, "a synthetic Open anyway opens nothing");
  // Open anyway repeats the POST with { confirm: true }; the box goes, the focus back on Open.
  await page.click("#dl-confirm-p1 .confirm-row button");
  await waitFor("the confirmed open", () => opens().length === 2);
  assert.deepEqual(opens()[1], { route: "downloads", rest: ["p1", "open"], body: { confirm: true } });
  await until("the box goes", () => document.getElementById("dl-confirm-p1").hidden);
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Open run.command");
  assert.equal(await inPage(() => document.getElementById("downloads-msg").textContent), "");

  // Cancel posts nothing and puts the focus back on Open; Escape cancels too.
  await page.click('button[aria-label="Open page.html"]');
  await until("the question", () => document.getElementById("dl-confirm-h1")?.hidden === false);
  assert.equal((await box("h1")).text, CONFIRM_PROGRAM);
  const before = helper.posts.length;
  await page.click('button[aria-label="Don\'t open page.html"]');
  await until("cancelled", () => document.getElementById("dl-confirm-h1").hidden);
  await sleep(300);
  assert.equal(helper.posts.length, before, "Cancel posts nothing");
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Open page.html");
  await page.click('button[aria-label="Open page.html"]');
  await until("asked again", () => document.getElementById("dl-confirm-h1")?.hidden === false);
  await page.keyboard.press("Escape");
  await until("Escape cancels", () => document.getElementById("dl-confirm-h1").hidden);
  assert.equal(opens().filter((p) => p.body?.confirm === true).length, 1, "only the one confirmed open");

  // 409: the helper's sentence in the row, no Open anyway, Show in Finder still there.
  await page.click('button[aria-label="Open old.pdf"]');
  await until("the refusal", () => document.getElementById("dl-confirm-u1")?.hidden === false);
  const u = await box("u1");
  assert.equal(u.text, UNMARKED);
  assert.equal(u.choice, false, "no Open anyway for a refusal");
  const reveal = await inPage(() => !!document.querySelector('#downloads button[aria-label^="Show old.pdf"]'));
  assert.equal(reveal, true, "Show in Finder still there");
  await page.click('#downloads button[aria-label^="Show old.pdf"]');
  await waitFor("the reveal", () => helper.posts.some((p) => p.route === "downloads" && p.rest[0] === "u1" && p.rest[1] === "reveal"));
  assert.equal(opens().filter((p) => p.rest[0] === "u1").length, 1);

  assert.equal(await inPage(() => window.__asked), undefined, "no window.confirm");
  assert.equal(confirm, "function");
  assert.deepEqual(errors, []);
}));

// The helper's Open answers say where it opened ({ opened }); Word-type names get Open in app.
const OPENS = [
  { id: "t1", name: "statement.pdf", state: "done", at: NOW - 60_000, size: 1000, from: { host: "bank.example" }, opens: "tab" },
  { id: "w1", name: "contract.docx", state: "done", at: NOW - 50_000, size: 1000, from: { host: "mail.example" }, opens: "preview" },
  { id: "x1", name: "sheet.xlsx", state: "done", at: NOW - 40_000, size: 1000, from: { host: "data.example" }, opens: "app" },
  { id: "o1", name: "notes.txt", state: "done", at: NOW - 30_000, size: 10, from: { host: "docs.example" } },
  { id: "n1", name: "Minutes.ODT", state: "done", at: NOW - 20_000, size: 1000, from: { host: "team.example" }, app: false },
  { id: "g1", name: "gone.rtf", state: "done", at: NOW - 15_000, size: 1000, from: { host: "team.example" }, gone: true },
  { id: "m1", name: "report.docx.pdf", state: "done", at: NOW - 12_000, size: 1000, from: { host: "team.example" } },
  { id: "v1", name: "mail.html", state: "done", at: NOW - 10_000, size: 1000, from: { host: "mail.example" }, program: true, confirm: CONFIRM_WEB },
];
describe("downloads: where Open opened it, and Open in app", () => pageTest("right", opts({ downloads: { items: OPENS } }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", () => document.querySelectorAll("#downloads li").length === 8);
  const rowOf = (name) => `#downloads li:has(button[aria-label="Open ${name}"])`;
  const saids = () => inPage(() => [...document.querySelectorAll("#downloads .said")].map((p) => p.textContent).filter(Boolean));
  const saidIn = (name) => inPage((s) => document.querySelector(`${s} .said`).textContent, rowOf(name));
  const dl = () => helper.posts.filter((p) => p.route === "downloads");

  // (1) Open in app on Word-type names only, between Open and Show in Finder.
  const words = await inPage(() => [...document.querySelectorAll("#downloads button")].filter((b) => b.textContent === "Open in app").map((b) => b.getAttribute("aria-label")));
  assert.deepEqual(words.sort(), ["Open Minutes.ODT in its app", "Open contract.docx in its app", "Open gone.rtf in its app"]);
  const reveal = await inPage(() => (/mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? "Show in Finder" : "Show in folder"));
  assert.deepEqual(await inPage((s) => [...document.querySelectorAll(`${s} button`)].map((b) => b.textContent), rowOf("contract.docx")), ["Open", "Open in app", reveal]);
  // (2) Open's title, only for types the page can name.
  const mac = reveal === "Show in Finder";
  const titles = await inPage(() => Object.fromEntries([...document.querySelectorAll("#downloads li")].map((li) => {
    const b = li.querySelector("button");
    return [li.querySelector(".name").textContent, b.hasAttribute("title") ? b.title : null];
  })));
  assert.deepEqual(titles, {
    "statement.pdf": "Opens in a new tab", "contract.docx": mac ? "Opens as a read-only preview in a new tab" : "Opens in its app",
    "sheet.xlsx": null, "notes.txt": "Opens in a new tab", "Minutes.ODT": mac ? "Opens as a read-only preview in a new tab" : "Opens in its app",
    "gone.rtf": mac ? "Opens as a read-only preview in a new tab" : "Opens in its app", "report.docx.pdf": "Opens in a new tab", "mail.html": null,
  });
  assert.equal(await inPage(() => document.querySelector('button[aria-label="Open contract.docx in its app"]').title), "Opens the original in its default app, for editing");
  // (3) A synthetic click on Open in app sends nothing.
  await inPage(synthetic, 'button[aria-label="Open contract.docx in its app"]');
  await sleep(300);
  assert.equal(dl().length, 0, "a synthetic Open in app opens nothing");
  // (4)-(7) The row says where the helper opened it, only as it answered; one status at a time.
  await page.click('button[aria-label="Open statement.pdf"]');
  await until("t1 said", () => document.querySelector('#downloads li:has(button[aria-label="Open statement.pdf"]) .said').textContent === "Opened in a new tab");
  assert.deepEqual(await inPage((s) => { const p = document.querySelector(`${s} .said`); return [p.getAttribute("role"), p.getAttribute("aria-live"), p.parentElement.classList.contains("acts")]; }, rowOf("statement.pdf")), ["status", "polite", true]);
  assert.deepEqual(dl().at(-1), { route: "downloads", rest: ["t1", "open"], body: null });
  await page.click('button[aria-label="Open contract.docx"]');
  await until("w1 said", () => document.querySelector('#downloads li:has(button[aria-label="Open contract.docx"]) .said').textContent === "Opened as a read-only preview");
  assert.equal(await saidIn("statement.pdf"), "", "the earlier status goes");
  await page.click('button[aria-label="Open sheet.xlsx"]');
  await until("x1 said", () => document.querySelector('#downloads li:has(button[aria-label="Open sheet.xlsx"]) .said').textContent === "Opened in its app");
  assert.deepEqual(await saids(), ["Opened in its app"]);
  await page.click('button[aria-label="Open notes.txt"]');
  await waitFor("o1 open", () => dl().some((p) => p.rest[0] === "o1"));
  await sleep(200);
  assert.deepEqual(await saids(), [], "an answer without `opened` says nothing");
  assert.equal(await inPage(() => document.getElementById("downloads-msg").textContent), "");
  // (8) Open in app by keyboard: Tab from Open, Enter.
  await page.focus('button[aria-label="Open contract.docx"]');
  await page.keyboard.press("Tab");
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Open contract.docx in its app");
  await page.keyboard.press("Enter");
  await waitFor("open-app", () => dl().some((p) => p.rest[1] === "open-app"));
  assert.deepEqual(dl().at(-1), { route: "downloads", rest: ["w1", "open-app"], body: null });
  await until("w1 app", () => document.querySelector('#downloads li:has(button[aria-label="Open contract.docx"]) .said').textContent === "Opened in its app");
  await sleep(1500);
  assert.deepEqual(await saids(), ["Opened in its app"], "no timer clears it");
  const c = await inPage(textContrast, "#downloads .said:not(:empty)");
  assert.ok(c >= 4.5, `the row status keeps AA: ${c.toFixed(2)}:1`);
  // (9) Show in Finder empties it.
  await page.click(`${rowOf("contract.docx")} button:nth-of-type(3)`);
  await waitFor("w1 reveal", () => dl().some((p) => p.rest[0] === "w1" && p.rest[1] === "reveal"));
  assert.deepEqual(await saids(), []);
  // (10) open-app refused: the helper's sentence in the row, no Open anyway.
  await page.click('button[aria-label="Open Minutes.ODT in its app"]');
  await until("n1 refusal", () => document.getElementById("dl-confirm-n1")?.hidden === false);
  assert.deepEqual(await inPage(() => { const b = document.getElementById("dl-confirm-n1"); return [b.querySelector("p").textContent, b.querySelector(".confirm-row").hidden]; }), [NO_APP, true]);
  // (11) 410: the helper's sentence under the list.
  await page.click('button[aria-label="Open gone.rtf in its app"]');
  await until("g1 gone", () => document.getElementById("downloads-msg").dataset.kind === "error");
  assert.equal(await inPage(() => document.getElementById("downloads-msg").textContent), FILE_CHANGED);
  // (12) A web page's confirm, verbatim from the helper.
  await page.click('button[aria-label="Open mail.html"]');
  await until("v1 asks", () => document.getElementById("dl-confirm-v1")?.hidden === false);
  assert.equal(await inPage(() => document.querySelector("#dl-confirm-v1 p").textContent), CONFIRM_WEB);
  await page.click('button[aria-label="Don\'t open mail.html"]');
  await until("v1 cancelled", () => document.getElementById("dl-confirm-v1").hidden);
  // (13) open-app asks first: Open anyway repeats open-app, the focus back on Open in app.
  helper.replies.downloads = (body, rest) => (rest[1] === "open-app" && body?.confirm !== true ? { status: 428, body: { confirm: "Ask first." } } : { status: 200, body: { ok: true, opened: "app" } });
  await page.click('button[aria-label="Open contract.docx in its app"]');
  await until("w1 asks", () => document.getElementById("dl-confirm-w1")?.hidden === false && document.querySelector("#dl-confirm-w1 p").textContent === "Ask first.");
  const n = dl().length;
  await page.click("#dl-confirm-w1 .confirm-row button");
  await waitFor("the confirmed open-app", () => dl().length === n + 1);
  assert.deepEqual(dl().at(-1), { route: "downloads", rest: ["w1", "open-app"], body: { confirm: true } });
  await until("w1 box goes", () => document.getElementById("dl-confirm-w1").hidden);
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Open contract.docx in its app");
  assert.equal(await saidIn("contract.docx"), "Opened in its app");
  assert.deepEqual(errors, []);
}));

// Open's title matches the helper's openWay for what the name says: TAB_TYPES a tab, TEXT_TYPES a
// preview, the codec types (build-dependent) and mov / aac (their app) no hint.
const HINTS = {
  "a.ico": "Opens in a new tab", "README.md": "Opens in a new tab", "data.JSON": "Opens in a new tab", "song.flac": "Opens in a new tab", "photo.jpeg": "Opens in a new tab",
  "export.csv": "Opens as a read-only preview in a new tab", "server.LOG": "Opens as a read-only preview in a new tab",
  "clip.mp4": null, "clip.m4v": null, "voice.m4a": null, "movie.mov": null, "tune.aac": null, "photo.heic": null, "deck.pptx": null,
};
const HINT_ROWS = Object.keys(HINTS).map((name, i) => ({ id: `h${i}`, name, state: "done", at: NOW - 1000 * (i + 1), size: 10, from: { host: "files.example" } }));
describe("downloads: Open's title follows the helper's openWay", () => pageTest("right", opts({ downloads: { items: HINT_ROWS } }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", (n) => document.querySelectorAll("#downloads li").length === n, HINT_ROWS.length);
  const titles = await inPage(() => Object.fromEntries([...document.querySelectorAll("#downloads li")].map((li) => {
    const b = li.querySelector("button");
    return [li.querySelector(".name").textContent, b.hasAttribute("title") ? b.title : null];
  })));
  assert.deepEqual(titles, HINTS);
  assert.deepEqual(errors, []);
}));

describe("downloads without the route", () => pageTest("right", opts({ downloads: null }), async ({ page, helper, inPage, errors }) => {
  await page.click("#tab-tools");
  await waitFor("the read", () => reads(helper, "downloads.json") === 1);
  await sleep(300);
  assert.equal(await inPage(visible, "#sec-downloads"), false, "a helper without the route: no section");
  assert.equal(await inPage(visible, "#sec-handoffs"), true);
  assert.deepEqual(errors, []);
}));

describe("recordings", () => pageTest("right", opts({ recordings: { items: RECORDINGS } }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("the rows", () => document.querySelectorAll("#recordings li").length === 2);
  const metas = await inPage(() => [...document.querySelectorAll("#recordings li")].map((li) => [li.querySelector(".name").textContent, li.querySelector(".meta").textContent]));
  assert.deepEqual(metas.map(([n]) => n), ["pairbrowse-1015.webm", "pairbrowse-0910.webm"], "newest first");
  assert.match(metas[0][1], /^1:01:40 · 52 MB · \S/);
  assert.match(metas[1][1], /^1:23 · 4\.2 MB · \S/);
  assert.equal(await inPage(visible, "#recordings-empty"), false);
  const first = "#recordings li:first-child";
  await inPage(synthetic, `${first} .acts button`);
  await sleep(300);
  assert.equal(helper.posts.filter((p) => p.route === "recordings").length, 0, "a synthetic click opens nothing");
  await page.click(`${first} .acts button:nth-child(1)`);
  assert.deepEqual((await posted(helper, "recordings"))[0]?.rest, ["r2", "open"]);
  await page.click(`${first} .acts button:nth-child(2)`);
  assert.deepEqual((await posted(helper, "recordings", 2))[1]?.rest, ["r2", "reveal"]);
  // Delete asks in the row; focus on Keep, Escape closes it and returns to Delete.
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  await page.click(`${first} .acts .bad`);
  await until("the confirm", () => document.getElementById("rec-confirm-r2").checkVisibility());
  assert.equal(await inPage(text, "rec-q-r2"), "Delete pairbrowse-1015.webm from your Downloads folder?");
  assert.equal(await inPage(() => document.activeElement?.id), "rec-keep-r2", "focus on Keep: a second Enter keeps the file");
  assert.equal(await page.getAttribute(`${first} .acts .bad`, "aria-expanded"), "true");
  await page.keyboard.press("Escape");
  await until("closed", () => document.getElementById("rec-confirm-r2").hidden);
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "Delete pairbrowse-1015.webm", "focus back on Delete");
  await page.click(`${first} .acts .bad`);
  await until("the confirm again", () => !document.getElementById("rec-confirm-r2").hidden);
  await page.click("#rec-keep-r2");
  await until("Keep closes it", () => document.getElementById("rec-confirm-r2").hidden);
  await page.click(`${first} .acts .bad`);
  await until("the confirm once more", () => !document.getElementById("rec-confirm-r2").hidden);
  await inPage(synthetic, "#rec-confirm-r2 .bad");
  await sleep(300);
  assert.equal(helper.deletes.length, 0, "a synthetic click deletes nothing");
  const yes = await inPage(textContrast, "#rec-confirm-r2 .bad");
  assert.ok(yes >= 4.5, `Delete keeps AA in the confirm: ${yes.toFixed(2)}:1`);
  await page.click("#rec-confirm-r2 .bad");
  await waitFor("the delete", () => helper.deletes.length === 1);
  assert.deepEqual(helper.deletes.map((d) => d.rest), [["r2"]]);
  await until("the row goes", () => document.querySelectorAll("#recordings li").length === 1);
  assert.equal(await inPage(text, "recordings-msg"), "Deleted pairbrowse-1015.webm.");
  assert.equal(dialogs, 0, "no JavaScript dialog");
  assert.deepEqual(errors, []);
}));

describe("recordings: the Record button", () => pageTest("right", opts(), async ({ page, helper, harness, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("No recordings yet", () => document.getElementById("recordings-empty").checkVisibility());
  await page.click("#record-btn");
  assert.deepEqual((await posted(helper, "record"))[0]?.body, { on: true });
  await until("recording", () => document.getElementById("record-btn").textContent === "Stop recording");
  assert.match(await inPage(text, "record-note"), /^Recording 0:0\d$/);
  assert.equal((await harness.live()).intervals, 1, "the clock while recording and shown");
  await harness.setHidden(true);
  assert.equal((await harness.live()).intervals, 0, "no clock while hidden");
  const fires = await harness.hiddenFires();
  await sleep(1500);
  assert.equal((await harness.hiddenFires()) - fires, 0, "nothing ran while hidden");
  await harness.setHidden(false);
  assert.equal((await harness.live()).intervals, 1, "back with the page");
  helper.push("record", { op: "saved", item: { id: "r3", name: "pairbrowse-1100.webm", size: 1_000_000, at: Date.now(), duration: 12 } });
  await until("r3 first", () => document.querySelector("#recordings li:first-child .name")?.textContent === "pairbrowse-1100.webm");
  assert.equal(await inPage(visible, "#recordings-empty"), false);
  assert.equal(await inPage(text, "record-btn"), "Stop recording", "a saved notice alone keeps the state");
  helper.push("record", { recording: false });
  await until("stopped", () => document.getElementById("record-btn").textContent === "Record");
  assert.equal((await harness.live()).intervals, 0);
  assert.deepEqual(errors, []);
}));

describe("recordings: already recording", () => pageTest("right", opts({ recordings: { recording: { on: true, since: NOW - 5000 } } }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await until("Stop recording", () => document.getElementById("record-btn").textContent === "Stop recording");
  assert.match(await inPage(text, "record-note"), /^Recording \d+:\d\d$/);
  assert.deepEqual(errors, []);
}));

describe("recordings without the route", () => pageTest("right", opts({ recordings: null }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await waitFor("the read", () => reads(helper, "recordings.json") === 1);
  await sleep(300);
  assert.equal(await inPage(visible, "#recordings"), false);
  assert.equal(await inPage(visible, "#recordings-empty"), false);
  assert.equal(await inPage(visible, "#record-btn"), true);
  await page.click("#record-btn");
  assert.deepEqual((await posted(helper, "record"))[0]?.body, { on: true });
  await until("recording", () => document.getElementById("record-btn").textContent === "Stop recording");
  assert.deepEqual(errors, []);
}));

const DIAG = { joined: [{ label: "Sam", role: "drive" }], connections: { agents: 1, viewers: 2, joiners: 1, streams: 3 },
  errors: [{ at: NOW - 60_000, where: "serve.mjs", text: "older error" }, { at: NOW - 1000, where: "tunnel.mjs", text: "newer error" }] };
describe("diagnostics", () => pageTest("right", opts({ diagnostics: DIAG }, { native: false }), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  // Before its first answer the section shows no values (no placeholders).
  assert.equal(await inPage(visible, "#diag"), false);
  assert.equal(await inPage(visible, "#diag-errors-empty"), false);
  await page.click("#sec-diag .disclose");
  await until("the helper line", () => document.getElementById("diag").checkVisibility() && document.getElementById("diag-helper").textContent !== "");
  assert.equal(await inPage(text, "diag-helper"), "0.15.45 · Node 22.11.0 · up 2 h 5 min");
  assert.equal(await inPage(text, "diag-browser"), "PairBrowse browser 142.0.7444.59 (build 3)");
  assert.equal(await inPage(text, "diag-conn"), "1 agent · 2 viewers · 1 joiner · 3 streams");
  assert.equal(await inPage(text, "diag-joined"), "Sam (drive)");
  const errs = await inPage(() => [...document.querySelectorAll("#diag-errors li")].map((li) => [li.querySelector("strong").textContent, li.querySelector("time").dateTime !== "", li.textContent]));
  assert.deepEqual(errs.map(([w]) => w), ["tunnel.mjs", "serve.mjs"], "newest first");
  assert.ok(errs.every(([, t, s]) => t && /error$/.test(s)));
  assert.equal(await inPage(visible, "#diag-errors-empty"), false);
  assert.equal(await inPage(text, "diag-send-note"), "Nothing leaves this computer from here. Sending reports to PairBrowse comes in a later version, and only when you choose it.");
  assert.equal(await inPage(() => [...document.querySelectorAll("#sec-diag button")].some((b) => /send/i.test(b.textContent))), false, "no Send button");
  const n = reads(helper, "diagnostics.json");
  await page.click("#diag-refresh");
  await waitFor("Refresh reads once", () => reads(helper, "diagnostics.json") === n + 1);
  await page.click("#diag-prepare");
  assert.deepEqual((await posted(helper, "diagnostics"))[0]?.rest, ["report"]);
  await until("the report", () => document.getElementById("diag-report-box").checkVisibility());
  const report = helper.fixtures.report.text;
  assert.deepEqual(await inPage(() => { const t = document.getElementById("diag-report"); return [t.readOnly, t.value, document.activeElement === t]; }), [true, report, true]);
  await inPage(() => { window.__copied = null; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); });
  await page.click("#diag-copy");
  await until("copied", () => window.__copied !== null);
  assert.equal(await inPage(() => window.__copied), report, "the clipboard got exactly the report");
  assert.equal(await inPage(text, "diag-msg"), "Copied.");
  // Save: a download of that text made in the page; no request to the helper or anywhere else.
  const before = { gets: helper.gets.length, posts: helper.posts.length };
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  const download = page.waitForEvent("download");
  await page.click("#diag-save");
  const d = await download;
  assert.match(d.suggestedFilename(), /^pairbrowse-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
  assert.equal(readFileSync(await d.path(), "utf8"), report, "the file holds exactly the report");
  await sleep(200);
  assert.deepEqual({ gets: helper.gets.length, posts: helper.posts.length }, before, "Save asks the helper nothing");
  assert.deepEqual(requests.filter((u) => !u.startsWith("blob:")), [], "no network request");
  assert.equal(await inPage(text, "diag-msg"), "Saved to your Downloads folder.");
  assert.deepEqual(errors, []);
}));

describe("diagnostics without the route", () => pageTest("right", opts({ diagnostics: null }, { native: false }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await page.click("#sec-diag .disclose");
  await until("none", () => document.getElementById("diag-none").checkVisibility());
  assert.equal(await inPage(text, "diag-none"), "This PairBrowse doesn't offer diagnostics yet.");
  assert.equal(await inPage(visible, "#diag-prepare"), false);
  assert.equal(await inPage(visible, "#diag"), false);
  assert.equal(await inPage(text, "diag-msg"), "");
  assert.deepEqual(errors, []);
}));

describe("diagnostics read fails", () => pageTest("right", opts({ diagnostics: "not an object" }, { native: false }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await page.click("#sec-diag .disclose");
  await until("the failure", () => document.getElementById("diag-msg").textContent !== "");
  assert.equal(await inPage(text, "diag-msg"), "Couldn't read diagnostics from PairBrowse. Try Refresh.");
  assert.equal(await inPage(visible, "#diag"), false, "no placeholder values");
  assert.equal(await inPage(visible, "#diag-errors-empty"), false);
  assert.deepEqual(errors, []);
}));

describe("layout tab", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  const dock = await inPage(() => document.documentElement.dataset.dock);
  helper.push("layout", { left: "open", right: "hidden", strip: 88, tab: "tools" });
  await until("on Tools", () => document.body.dataset.tab === "tools" && document.getElementById("pane-tools").checkVisibility());
  assert.equal(await page.getAttribute("#tab-tools", "aria-selected"), "true");
  assert.equal(await inPage(() => document.documentElement.dataset.dock), dock, "the event's sides never change the dock");
  await page.click("#tab-agent");
  helper.push("layout", { left: "open", right: "open", strip: 88 });
  await sleep(300);
  assert.equal(await inPage(() => document.body.dataset.tab), "agent", "no tab: the tab stays");
  assert.deepEqual(errors, []);
}));

// No replay: a right page that joins the shared stream late is neither sent to Tools by an old
// layout event nor given a recording from an old saved notice (one context, two right pages).
test("layout tab and saved recordings are not replayed to a late page", { skip: !runtime, timeout: 60_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({ pageOrigin: null });
  const ui = await startUiServer({ helper, fixture: defaultFixture() });
  helper.setPageOrigin(ui.origin);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const errors = [];
    const open = async () => {
      const p = await context.newPage();
      p.on("pageerror", (e) => errors.push(String(e)));
      await p.goto(ui.url("right"), { waitUntil: "load" });
      await waitFor("live", async () => (await p.evaluate(() => document.body.dataset.s)) === "live");
      return p;
    };
    const first = await open();
    await sleep(300);
    helper.push("layout", { left: "open", right: "open", strip: 88, tab: "tools" });
    await waitFor("the first page on Tools", async () => (await first.evaluate(() => document.body.dataset.tab)) === "tools");
    helper.push("record", { op: "saved", item: { id: "r9", name: "old.webm", size: 1000, at: Date.now(), duration: 3 } });
    await first.click("#tab-agent");
    await sleep(200);
    const late = await open();
    await sleep(400);
    assert.equal(helper.streams.size, 1, "one shared stream");
    assert.equal(await late.evaluate(() => document.body.dataset.tab), "agent", "the late page stays on Agent");
    await late.click("#tab-tools");
    await waitFor("its own read", () => reads(helper, "recordings.json") >= 1);
    await sleep(300);
    assert.equal(await late.evaluate(() => document.querySelectorAll("#recordings li").length), 0, "no row from the old saved notice");
    assert.equal(await late.evaluate(() => document.getElementById("record-btn").textContent), "Record");
    assert.deepEqual(errors, []);
  } finally {
    await helper.close();
    await ui.close();
    await browser.close();
  }
});

describe("rail and hidden", () => pageTest("right", opts(), async ({ page, helper, shim, inPage, until, errors }) => {
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  assert.equal(await inPage(visible, "#rail"), true);
  assert.equal(await inPage(visible, "main"), false);
  assert.equal(await inPage(() => document.getElementById("rail").getBoundingClientRect().width), 44);
  assert.deepEqual(await inPage(() => { const b = document.getElementById("dock-expand"); return { shown: b.checkVisibility(), inTop: b.parentElement.classList.contains("rail-top"), h: b.parentElement.getBoundingClientRect().height }; }),
    { shown: true, inTop: true, h: 44 });
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".rail-btn")].map((b) => b.getAttribute("aria-label"))), ["Agent", "Page", "Screenshots", "Tools"]);
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".rail-btn")].map((b) => b.getAttribute("aria-current"))), ["true", null, null, null], "the rail says which tab opens");
  assert.equal(await inPage(() => getComputedStyle(document.querySelector(".rail-btn[aria-current]")).boxShadow.includes("inset")), true, "in a shape, not by color alone");
  // A join request while the dock is a rail shows on the rail's Agent button, in words too.
  helper.push("join", [{ id: "r1", name: "Sam", app: "Claude Code", role: "drive", state: "pending" }]);
  await until("the rail's count", () => document.getElementById("rail-count").textContent === "1" && document.getElementById("rail-count").checkVisibility());
  assert.equal(await page.getAttribute("#rail-agent", "aria-label"), "Agent, 1 request");
  helper.push("join", []);
  await until("the rail's count goes", () => document.getElementById("rail-count").hidden);
  assert.equal(await page.getAttribute("#rail-agent", "aria-label"), "Agent");
  // The recording clock draws in a pane only: on the rail it stops, and open again it goes on.
  helper.push("record", { recording: true, since: Date.now() - 5000 });
  await until("the clock's first tick", () => /^Recording 0:0\d$/.test(document.getElementById("record-note").textContent));
  const still = await inPage(text, "record-note");
  await sleep(2300);
  assert.equal(await inPage(text, "record-note"), still, "no tick while the dock is a rail");
  await page.click('.rail-btn[data-tab="tools"]');
  const set = (await shim.calls()).filter((c) => c.iface === "layout" && c.method === "set");
  assert.equal(set.at(-1)?.args[0].right, 2, "open through the mojom");
  await shim.layout({ right: 2 });
  await until("open on Tools", () => document.documentElement.dataset.dock === "open" && document.getElementById("pane-tools").checkVisibility());
  await until("the clock again", (was) => document.getElementById("record-note").textContent !== was, still);
  helper.push("record", { recording: false });
  assert.equal(await page.getAttribute('.rail-btn[data-tab="tools"]', "aria-current"), "true");
  await shim.layout({ right: 0 });
  await until("hidden", () => document.documentElement.dataset.dock === "hidden");
  assert.equal(await inPage(visible, "main"), false);
  assert.equal(await inPage(visible, "#rail"), false);
  assert.equal(await inPage(visible, "#dock-expand"), false);
  assert.equal(await inPage(visible, "#dock-collapse"), false);
  assert.deepEqual(errors, []);
}));

describe("requests count", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  helper.push("join", [{ id: "r1", name: "Sam", app: "Claude Code", role: "drive", state: "pending" }]);
  await until("the count", () => document.getElementById("agent-count").textContent === "1" && !document.getElementById("agent-count").hidden);
  assert.equal(await page.getAttribute("#agent-count", "aria-label"), null, "no name on the figure (a generic)");
  assert.equal(await page.getAttribute("#agent-count", "aria-hidden"), "true");
  assert.equal(await page.getAttribute("#tab-agent", "aria-label"), "Agent, 1 request");
  await page.click("#tab-agent");
  assert.equal(await inPage(visible, "#agent-count"), false, "hidden on the Agent tab");
  assert.equal(await page.getAttribute("#tab-agent", "aria-label"), null, "the tab's own text names it again");
  await inPage(() => document.querySelector("#joins .join .primary").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await sleep(300);
  assert.equal(helper.posts.filter((p) => p.route === "approve").length, 0, "a synthetic click allows nothing");
  await page.click("#joins .join .primary");
  assert.deepEqual((await posted(helper, "approve"))[0]?.body, { id: "r1", allow: true });
  assert.deepEqual(errors, []);
}));

// The browser narrows the dock to a rail as the window narrows, and opens it again as it widens
// (native 565), with no click: a focused control the new state no longer shows hands the focus to
// the dock's own button, and nothing is asked of the layout.
describe("the window narrows and widens the dock with the focus in it", () => pageTest("right", opts(), async ({ page, shim, inPage, until, errors }) => {
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  await page.focus("#dock-collapse");
  await shim.layout({ right: 1 });
  await until("the rail, focus on expand", () => document.documentElement.dataset.dock === "rail" && document.activeElement?.id === "dock-expand");
  await shim.layout({ right: 2 });
  await until("open, focus on collapse", () => document.documentElement.dataset.dock === "open" && document.activeElement?.id === "dock-collapse");
  await inPage(() => document.activeElement.blur());
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  assert.equal(await inPage(() => document.activeElement === document.body), true, "no focus taken");
  assert.deepEqual((await shim.calls()).filter((c) => c.iface === "layout" && c.method === "set"), []);
  assert.deepEqual(errors, []);
}));

describe("collapse and expand", () => pageTest("right", opts(), async ({ page, shim, harness, inPage, until, errors }) => {
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const live = await harness.live();
  const fixture = await inPage(() => ({ ...window.__pairbrowse.fixture.layout }));
  const sets = async () => (await shim.calls()).filter((c) => c.iface === "layout" && c.method === "set");
  await page.focus("#dock-collapse");
  await page.keyboard.press("Enter");
  await until("the rail, focus on expand", () => document.documentElement.dataset.dock === "rail" && document.activeElement?.id === "dock-expand");
  assert.deepEqual((await sets()).map((c) => c.args[0]), [{ ...fixture, right: 1 }]);
  const expand = await inPage(() => {
    const b = document.getElementById("dock-expand"), r = b.getBoundingClientRect(), top = b.parentElement.getBoundingClientRect(), cs = getComputedStyle(b), ts = getComputedStyle(b.parentElement);
    return { label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), cx: r.left + r.width / 2, cy: r.top + r.height / 2, topH: top.height,
      line: [ts.borderBottomWidth, ts.borderBottomColor], ring: [cs.outlineStyle, cs.outlineWidth, cs.outlineOffset, cs.outlineColor] };
  });
  assert.equal(expand.label, "Expand the agent panel");
  assert.equal(expand.expanded, "false");
  assert.equal(expand.cx, 22);
  assert.ok(Math.abs(expand.cy - 21.5) <= 1, `centered in the 44 px band (${expand.cy})`);
  assert.equal(expand.topH, 44);
  assert.deepEqual(expand.line, ["1px", await inPage(token, "edge")]);
  assert.deepEqual(expand.ring, ["solid", "2px", "2px", await inPage(token, "accent")], "the 2 px accent focus ring");
  await page.keyboard.press("Enter");
  await until("open, focus on collapse", () => document.documentElement.dataset.dock === "open" && document.activeElement?.id === "dock-collapse");
  const all = await sets();
  assert.equal(all.length, 2);
  assert.equal(all[1].args[0].right, 2);
  assert.ok(all.every((c) => c.args[0].right !== 0 && c.args[0].left !== 0), "no button hides a dock");
  // Hover: --hover under --ink, over the 120 ms transition.
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("dock-collapse")).transitionDuration), "0.12s, 0.12s");
  await page.hover("#dock-collapse");
  await until("the hover colors", () => { const cs = getComputedStyle(document.getElementById("dock-collapse")); const t = (n) => { const p = document.createElement("span"); p.style.color = `var(--${n})`; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; }; return cs.backgroundColor === t("hover") && cs.color === t("ink"); });
  assert.deepEqual(await harness.live(), live, "nothing new runs after the round trip");
  assert.deepEqual(errors, []);
}));

// The dock's inner (left) side: 1 px --edge from the nav row to the bottom (DESIGN.md B4), open
// and rail; none when hidden, so the columns stay apart on a dark page.
describe("the dock's inner edge", () => pageTest("right", opts({}), async ({ shim, inPage, until, errors }) => {
  const edge = () => { const p = document.createElement("i"); p.style.color = "var(--edge)"; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return { shadow: getComputedStyle(document.body).boxShadow, edge: c }; };
  await until("open", () => document.documentElement.dataset.dock === "open");
  let e = await inPage(edge);
  assert.equal(e.shadow, `${e.edge} 1px 0px 0px 0px inset`);
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  e = await inPage(edge);
  assert.equal(e.shadow, `${e.edge} 1px 0px 0px 0px inset`);
  await shim.layout({ right: 0 });
  await until("hidden", () => document.documentElement.dataset.dock === "hidden");
  assert.equal((await inPage(edge)).shadow, "none");
  assert.deepEqual(errors, []);
}));

// No agent named by the helper: no card for an invented one, an empty state that says what to do.
describe("no agent named: no card", () => pageTest("right", opts({}), async ({ helper, inPage, until, errors }) => {
  await until("live", () => document.body.dataset.s === "live");
  const state = () => ({ card: document.getElementById("agent").checkVisibility(), none: document.getElementById("agent-none").checkVisibility(), text: document.getElementById("agent-none-title").textContent, hint: document.querySelector("#agent-none p").textContent });
  assert.deepEqual(await inPage(state), { card: false, none: true, text: "No agent in this session", hint: "Ask Claude Code or Codex to use PairBrowse. Its task, checklist and status show here." });
  // an empty state, not a drop zone: no border, 16 px padding, the title in --ink at 14/600
  const look = await inPage(() => { const n = getComputedStyle(document.getElementById("agent-none")); const t = getComputedStyle(document.getElementById("agent-none-title")); const probe = document.createElement("i"); probe.style.color = "var(--ink)"; document.body.append(probe); const ink = getComputedStyle(probe).color; probe.remove(); return { border: n.borderTopStyle, pad: n.paddingTop, size: t.fontSize, weight: t.fontWeight, color: t.color === ink }; });
  assert.deepEqual(look, { border: "none", pad: "16px", size: "14px", weight: "600", color: true });
  helper.push("board", ONE_AGENT);
  await until("the card", () => document.getElementById("agent").checkVisibility());
  assert.equal(await inPage(() => document.getElementById("agent-none").checkVisibility()), false);
  assert.equal(await inPage(text, "agent-name"), "Claude");
  assert.deepEqual(errors, []);
}));

// No browser API and no extension storage: no agent connected, no agent card, no wait.
describe("no API and no storage: No agent connected", () => pageTest("right", opts({}, { native: false, bridge: false }), async ({ inPage, until, errors }) => {
  await until("the line", () => document.getElementById("agent-none-title").textContent === "No agent connected");
  assert.equal(await inPage(() => document.getElementById("agent-none").checkVisibility()), true);
  assert.equal(await inPage(() => document.getElementById("agent").checkVisibility()), false, "no agent card");
  assert.equal(await inPage(() => document.getElementById("session-card").checkVisibility()), false, "no session card: nothing to share or end");
  assert.equal(await inPage(() => document.body.dataset.s), "none");
  assert.deepEqual(errors, []);
}));

// A helper address that never answers (none running, or gone before the dock opened): the same
// resting state as no helper at all, not "in this session" and nothing in red. When it answers,
// the stream opens on its own (EventSource's retry, no poll of the page's) and the dock's content
// replaces the empty state in place.
describe("a helper that never answers, then does", () => pageTest("right", opts({}, { down: true, timeout: 90_000 }), async ({ helper, inPage, until, errors }) => {
  const look = () => {
    const probe = (v) => { const i = document.createElement("i"); i.style.color = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
    const reds = [probe("bad"), probe("bad-ink")];
    return { title: document.getElementById("agent-none-title").textContent, none: document.getElementById("agent-none").checkVisibility(), card: document.getElementById("agent").checkVisibility(),
      session: document.getElementById("session-card").checkVisibility(),
      red: [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && reds.includes(getComputedStyle(e).color)).map((e) => e.id || e.className) };
  };
  await until("the empty state", () => document.getElementById("agent-none").checkVisibility());
  assert.notEqual(await inPage(() => document.body.dataset.s), "live");
  assert.deepEqual(await inPage(look), { title: "No agent connected", none: true, card: false, session: false, red: [] });
  // The Page tab while nothing answers: its resting line, not an error.
  await inPage(() => document.getElementById("tab-page").click());
  await inPage(() => new Promise((r) => setTimeout(r, 300)));
  assert.equal(await inPage(text, "outline-empty"), "No outline yet: it shows once an agent reads a page.");
  await inPage(() => document.getElementById("tab-agent").click());
  helper.setDown(false);
  for (let i = 0; i < 160 && (await inPage(() => document.body.dataset.s)) !== "live"; i++) await sleep(50);
  assert.equal(await inPage(() => document.body.dataset.s), "live", "connected on its own");
  await until("the session's words", () => document.getElementById("agent-none-title").textContent === "No agent in this session");
  helper.push("board", ONE_AGENT);
  await until("the card replaces the empty state", () => document.getElementById("agent").checkVisibility() && !document.getElementById("agent-none").checkVisibility());
  assert.deepEqual(errors, []);
}));

// The session card only for a session the helper named.
describe("session card waits for the helper's session", () => pageTest("right", opts({}), async ({ helper, inPage, until, errors }) => {
  assert.match(SERVED, /<footer class="session-card" id="session-card" tabindex="-1" hidden>/, "served hidden");
  await until("live", () => document.body.dataset.s === "live");
  assert.equal(await inPage(() => document.getElementById("session-card").checkVisibility()), false, "no name yet: no card");
  helper.push("session", { name: "Checkout test", where: "Local", temporary: false });
  await until("the card", () => document.getElementById("session-card").checkVisibility());
  assert.equal(await inPage(text, "session-name"), "Checkout test");
  assert.deepEqual(errors, []);
}));

describe("extension host: no collapse or expand", () => pageTest("right", opts({}, { native: false }), async ({ helper, inPage, errors }) => {
  assert.equal(await inPage(() => document.documentElement.dataset.host), "extension");
  const state = () => ["dock-collapse", "dock-expand"].map((id) => { const b = document.getElementById(id); return [b.hidden, b.checkVisibility()]; });
  assert.deepEqual(await inPage(state), [[true, false], [true, false]]);
  helper.set("layout", { right: "rail" });
  await sleep(300);
  assert.deepEqual(await inPage(state), [[true, false], [true, false]]);
  assert.equal(await inPage(() => document.getElementById("rail").hidden), true);
  assert.equal(helper.posts.some((p) => p.route === "layout"), false, "no POST layout");
  assert.deepEqual(errors, []);
}));

describe("collapse under reduced motion", () => pageTest("right", opts({}, { reducedMotion: "reduce" }), async ({ page, harness, inPage, until, errors }) => {
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("dock-collapse")).transitionDuration), "0.001s");
  await page.hover("#dock-collapse");
  await sleep(50);
  assert.deepEqual(await harness.animations(), []);
  assert.deepEqual(errors, []);
}));

// The card's "Working…" is its own agent's: a joiner's line (from the other browser), a host's
// note and the other browser's agent are listed, and the card stays Idle on its agent's quiet.
// (Claude idle on the board here: the board's "working" is the next test's.)
const IDLE_CLAUDE = PEOPLE.map((p) => (p.who === "Claude" ? { ...p, status: "idle", task: "" } : p));
describe("the card works on its own agent's lines only", () => pageTest("right", opts(), async ({ helper, inPage, until, errors }) => {
  const t = Date.now();
  helper.push("board", { people: IDLE_CLAUDE, messages: [] });
  helper.push("activity", [{ t: t - 60_000, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }]);
  await until("the card names Claude", () => document.getElementById("agent-name").textContent === "Claude");
  assert.equal(await inPage(text, "driver-text"), "Idle", "its last action was a minute ago");
  const lines = [
    { t: t - 60_000, text: "Typed into **Email**", who: "Claude", tab: "Checkout" },
    { t: Date.now(), text: "Clicked **Next**", who: "Alice", tab: "Checkout", from: "inv:alice" },
    { t: Date.now(), text: "Note: check the totals", who: "Bob", tab: "" },
    { t: Date.now(), text: "Opened **Docs**", who: "Sam · Claude Code", tab: "Docs", from: "joined" },
  ];
  helper.push("activity", lines);
  await until("the lines listed", () => document.getElementById("activity").children.length === 4);
  assert.equal(await inPage(text, "driver-text"), "Idle", "a joiner's line, a note and another browser's agent leave it Idle");
  assert.equal(await inPage(text, "agent-name"), "Claude", "the card stays on its agent");
  helper.push("activity", [...lines, { t: Date.now(), text: "Typed into **Name**", who: "Claude", tab: "Checkout" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  assert.deepEqual(errors, []);
}));

// A second agent of this browser (Codex, no from) acting: the card names it, working; the first
// agent's earlier line never makes the card work.
describe("a second local agent's line moves the card to it, working", () => pageTest("right", opts(), async ({ helper, inPage, until, errors }) => {
  helper.push("board", { people: IDLE_CLAUDE, messages: [] });
  const lines = [{ t: Date.now() - 60_000, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }];
  helper.push("activity", lines);
  await until("the card names Claude", () => document.getElementById("agent-name").textContent === "Claude");
  assert.equal(await inPage(text, "driver-text"), "Idle", "Claude acted a minute ago");
  lines.push({ t: Date.now(), text: "Clicked **Next**", who: "Codex 1a2b", tab: "Checkout" });
  helper.push("activity", lines);
  await until("the card names Codex", () => /^Codex 1a2b/.test(document.getElementById("agent-name").textContent));
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  helper.push("activity", [...lines]);
  await sleep(200);
  assert.match(await inPage(text, "agent-name"), /^Codex 1a2b/, "Claude's older line doesn't take the card back");
  assert.equal(await inPage(text, "driver-text"), "Working…");
  assert.deepEqual(errors, []);
}));

// One truth for an agent's state (DESIGN.md Part G): the card reads the helper's board as the left
// dock does (common.js agentWords): its status "working" is "Working…" here without a recent action,
// and an idle agent is "Idle" in both.
describe("the card's state is the board's, as the left dock reads it", () => pageTest("right", opts(), async ({ helper, until, errors }) => {
  helper.push("board", { people: [{ who: "Claude 2e48", kind: "agent", color: "#e9763f", tab: "example.com", task: "Checking the page", status: "working" }], messages: [] });
  await until("working from the board", () => document.getElementById("driver-text").textContent === "Working…");
  helper.push("board", { people: [{ who: "Claude 2e48", kind: "agent", color: "#e9763f", tab: "example.com", task: "", status: "idle" }], messages: [] });
  await until("idle from the board", () => document.getElementById("driver-text").textContent === "Idle");
  assert.deepEqual(errors, []);
}));

// One agent connected (one MCP connection), idle and in no tab yet: the card is that agent; no
// "+ 1 idle agent in this browser" line counts it a second time. A second idle agent is the line.
describe("one idle agent is the card, not also an idle line", () => pageTest("right", opts(), async ({ helper, inPage, until, errors }) => {
  const one = { who: "Claude 2e48", kind: "agent", color: "#e9763f", tab: "", task: "", status: "idle" };
  helper.push("board", { people: [one, { who: "You", kind: "person", status: "idle" }], messages: [] });
  await until("the card names it", () => /Claude 2e48/.test(document.getElementById("agent-name").textContent));
  await sleep(200);
  assert.equal(await inPage(() => document.querySelector("#people li.idle")), null, "no idle line for the card's own agent");
  assert.equal(await inPage(() => document.getElementById("driver-text").textContent), "Idle");
  // The same agent once a line names it (lastWho): still no idle line.
  helper.push("activity", [{ t: Date.now() - 60_000, text: "Opened https://example.com", who: "Claude 2e48", tab: "Example Domain" }]);
  await sleep(200);
  assert.equal(await inPage(() => document.querySelector("#people li.idle")), null);
  helper.push("board", { people: [one, { ...one, who: "Codex 77aa", color: "#9b7bfa" }], messages: [] });
  await until("one idle line for the other", () => document.querySelector("#people li.idle")?.textContent === "+ 1 idle agent in this browser");
  assert.deepEqual(errors, []);
}));

// ---- the side panel as files and in the extension (once test/right.test.mjs) ----
const ROOT = join(import.meta.dirname, "..");
const readUi = (name) => readFileSync(join(ROOT, "ui", name), "utf8");
const html = readUi("right/index.html");
const js = readUi("right/right.js");
const toolsJs = readUi("right/tools.js");
const css = readUi("right/right.css");
const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

const IDS = ["where", "turn", "turn-text", "joins", "dev-asks", "host-asks", "driver", "driver-text", "pause", "pause-text", "pause-btn",
  "switch-btn", "record-btn", "record-note", "session", "session-line", "people", "messages", "hosts", "host-list", "dev", "devs", "collaboration",
  "activity", "details", "add-detail", "secrets", "add-secret", "profile-msg", "avatars", "agent", "agent-name", "agent-avatar",
  "agent-status", "agent-status-text", "agent-tab", "share-btn", "share-card", "share-name", "share-make", "share-code", "share-copy",
  "share-msg", "agent-more", "checklist", "checklist-items",
  "sec-handoffs", "handoffs", "handoffs-empty", "handoffs-msg", "handoffs-said", "sec-downloads", "downloads", "downloads-msg", "sec-recordings", "recordings",
  "recordings-msg", "sec-diag", "diag", "diag-report", "diag-copy", "diag-save", "diag-prepare", "diag-refresh"];
const KEYS = ["session", "dev", "hosts", "activity", "details", "secrets", "handoffs", "downloads", "recordings", "diagnostics"];
// Open by default; every other section starts folded.
const OPEN = new Set(["activity", "handoffs", "downloads", "recordings"]);

test("the panel's markup keeps every id once, and each section folds with a named button", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  for (const id of IDS) assert.equal(ids.filter((x) => x === id).length, 1, `#${id} once`);
  assert.equal(new Set(ids).size, ids.length, "no id twice");
  for (const key of KEYS) {
    // (A count's live line may describe the button: aria-describedby after aria-controls.)
    const sec = html.match(new RegExp(`<section class="sec"[^>]*data-key="${key}"[^>]*>\\s*<h2><button class="disclose" type="button" aria-expanded="(true|false)" aria-controls="([^"]+)"(?: aria-describedby="[^"]+")?>`));
    assert.ok(sec, `${key}: an h2 disclosure button`);
    assert.equal(sec[1], OPEN.has(key) ? "true" : "false", `${key}: ${OPEN.has(key) ? "open" : "folded"} by default`);
    // (It folds with the sheet's motion: class "body m-fold", DESIGN.md Part I.)
    const body = html.match(new RegExp(`<div class="body m-fold" id="${sec[2]}"( hidden)?>`));
    assert.ok(body, `${key}: its body #${sec[2]} exists`);
    assert.equal(!!body[1], !OPEN.has(key), `${key}: body hidden matches aria-expanded`);
  }
  for (const id of ["joins", "dev-asks", "host-asks"]) assert.match(html, new RegExp(`id="${id}" role="region" aria-label="[^"]+" aria-live="assertive"`), id);
  const status = html.match(/<section class="status"[^>]*>\s*<div class="joins" id="joins"[^>]*><\/div>\s*<div class="joins" id="dev-asks"[^>]*><\/div>\s*<div class="joins" id="host-asks"/);
  assert.ok(status, "requests come first in the status section");
  for (const id of ["collaboration", "profile-msg", "handoffs-said", "handoffs-msg", "downloads-msg", "recordings-msg", "diag-msg"]) assert.match(html, new RegExp(`id="${id}" role="status" aria-live="polite"`), id);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/tokens.css">\n<link rel="stylesheet" href="\.\.\/base.css">\n<link rel="stylesheet" href="right.css">/);
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  for (const name of ["label", "value", "domains"]) assert.match(html, new RegExp(`name="${name}"`), name);
  // Share and the Checklist: buttons that say what they open and whether it is open.
  for (const [id, target, open] of [["share-btn", "share-card", false], ["agent-more", "checklist", true]]) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.match(tag, new RegExp(`aria-expanded="${open}"`), id);
    assert.match(tag, new RegExp(`aria-controls="${target}"`), id);
    if (open) assert.doesNotMatch(html, new RegExp(`id="${target}"[^>]*hidden`), `#${target} starts open`);
    else assert.match(html, new RegExp(`id="${target}"[^>]*hidden`), `#${target} starts hidden`);
  }
  // It rises from the session card's Share with the sheet's motion (m-pop m-up, DESIGN.md Part I).
  assert.match(html, /<div class="share-card m-pop m-up" id="share-card" role="dialog" aria-labelledby="share-title" hidden>/);
  assert.deepEqual([...html.matchAll(/<input type="radio" name="share" value="(\w+)"/g)].map(([, v]) => v), ["code", "link"]);
  assert.match(html, /id="share-code" readonly aria-label="[^"]+"/);
  assert.match(html, /id="share-msg" role="status" aria-live="polite"/);
  assert.match(html, /<p class="sr" id="checklist-said" role="status" aria-live="polite"><\/p><ol id="checklist-items" aria-label="[^"]+">/);
  assert.match(html, /<footer class="session-card" id="session-card" tabindex="-1" hidden>[\s\S]*id="session-name"[\s\S]*<button class="mini share-btn" id="share-btn"/, "Share comes after the session's name (the session card)");
});

test("the logo is untouched: the same img line and the same files", () => {
  assert.ok(html.includes('    <img src="../logo.svg" alt="" width="22" height="22">\n'), "the header's logo line");
  assert.equal(sha("ui/logo.svg"), "415a3f8e100338210d7ffc070dd1d7ced24297bb682af9a4153a9f49d1bffd8a");
  assert.equal(sha("scripts/browser/icon.svg"), "d99eda89468eb2a84c2c04f52d54b5b0d028180a9d748023efb0982a79c84495");
  assert.equal(sha("scripts/browser/product-icon.svg"), "4d13634e72f51e15b8f3e2af6ff8a7423892e2480ffc6dc70e3a55534fdabf41");
});

test("the panel script keeps its three timers, writes no markup and stores one key", () => {
  assert.equal([...js.matchAll(/\bset(Interval|Timeout)\(/g)].length, 3, "the driver re-check, the recording clock and the checklist's debounce");
  assert.equal([...js.matchAll(/\bsetInterval\(/g)].length, 1, "the recording clock is the only interval");
  assert.match(js, /checklistTimer = setTimeout\(/, "the checklist's one pending timeout");
  assert.equal([...js.matchAll(/fetch\(base \+ "journal\.json"/g)].length, 1, "one place reads the goal log");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(js, /MutationObserver|IntersectionObserver|ResizeObserver|requestAnimationFrame/);
  assert.equal([...js.matchAll(/new EventSource\(/g)].length, 0, "no stream of its own: the shared one (stream.js)");
  assert.equal([...js.matchAll(/\bhelper(Stream|Connection)\(/g)].length, 1, "one event stream, the shared one");
  assert.equal(new Set([...js.matchAll(/"(pb-[a-z-]+)"/g)].map(([, k]) => k)).size, 1, "one storage key");
  assert.match(js, /"pb-panel"/);
  assert.doesNotMatch(js, /(^|[^.?])chrome\.storage/m, "every chrome.* access is guarded");
  assert.doesNotMatch(js, /kSheet/, "the sheet button is gone");
  // The Tools tab's sections (tools.js): no timer, no observer, no frame loop, no markup.
  assert.equal([...toolsJs.matchAll(/\bset(Interval|Timeout)\(/g)].length, 0, "tools.js runs no timer");
  assert.doesNotMatch(toolsJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(toolsJs, /MutationObserver|IntersectionObserver|ResizeObserver|PerformanceObserver|requestAnimationFrame/);
  assert.equal([...toolsJs.matchAll(/new EventSource\(|\bhelper(Stream|Connection)\(/g)].length, 0, "no stream of its own");
  assert.doesNotMatch(toolsJs, /chrome\.|localStorage|sessionStorage/, "stores nothing");
  assert.match(js, /import \{ toolsPanel \} from "\.\/tools\.js";/);
});

test("the dock's sheet: no blur, no spin, motion only on the Live dot, request cards and new activity", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(plain, /backdrop-filter/);
  assert.doesNotMatch(plain, /@keyframes turn\b/);
  assert.doesNotMatch(plain, /rotate\(360deg\)/);
  assert.doesNotMatch(plain, /outline:\s*none/);
  for (const [, sel, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\banimation\s*:/.test(body) || /animation:\s*none/.test(body)) continue;
    assert.match(sel, /\.live|\.join|\.activity li/, `${sel.trim()} animates`);
  }
  assert.match(plain, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition-duration: 1ms !important; \} \}/);
});

// The side panel as the extension shows it (chrome.storage, no window.pairbrowse, 360 px), its
// helper without the Tools routes (all 404) and with the goal log JOURNAL; the Share card's invite
// as the helper answers it: a refusal while no name is known, then a code.
const PANEL_PEOPLE = PEOPLE.map((p) => (p.who === "Alice · Codex" ? { ...p, color: "#9b7bfa" } : p));
const NO_TOOLS = { journal: JOURNAL, handoffs: null, downloads: null, recordings: null, diagnostics: null };
const INVITE = { invite: (body) => {
  const named = typeof body?.name === "string" && body.name;
  return named
    ? { status: 200, body: { ok: true, id: "abcd1234", share: "code", role: "drive", mode: "shared", code: "pb-join:FAKE", rights: "Shared browser: they can drive.", hint: "The person pastes it into their own PairBrowse." } }
    : { status: 409, body: { error: "Not yet: ask the user what name the people they invite should see.", needName: true } };
} };
const PANEL = { native: false, viewport: { width: 360, height: 900 }, fixtures: NO_TOOLS, replies: INVITE, timeout: 90_000 };
const streamOpen = async (helper) => { for (let i = 0; i < 50 && !helper.streams.size; i++) await sleep(50); };

describe("side panel: header, agent card, people, pause, requests and folding", () => pageTest("right", PANEL, async ({ page, helper, harness, inPage, until, errors }) => {
  const lv = helper;
  await until("the stream", () => document.body.dataset.s === "live");
  await streamOpen(helper);
  const t = Date.now();
  lv.push("status", { kind: "agent", text: "" });
  lv.push("session", { name: "Checkout test", where: "Local", temporary: false });
  lv.push("collaboration", { participants: [{ id: "a", label: "Claude" }], owner: { label: "You" }, active: null, guests: [] });
  lv.push("board", { people: PANEL_PEOPLE, messages: [{ from: "Sam", to: "all", text: "Take the cart", t }] });
  lv.push("activity", [{ t: t - 2000, text: "Opened **Cart**", who: "Alice · Codex", tab: "Cart" }, { t, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }]);
  lv.push("pause", { paused: false, can: true });
  await until("the board", () => document.getElementById("people").children.length > 0 && !document.getElementById("pause").hidden);
  // No rail in the side panel: neither the collapse nor the expand button.
  assert.deepEqual(await page.evaluate(() => ["dock-collapse", "dock-expand"].map((id) => { const b = document.getElementById(id); return [b.hidden, b.checkVisibility()]; })),
    [[true, false], [true, false]]);

  const view = () => page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    return {
      where: $("where").textContent, whereHidden: $("where").hidden, whereTitle: $("where").title,
      avatars: [...$("avatars").querySelectorAll(".avatar")].map((a) => ({ text: a.textContent, role: a.getAttribute("role"), label: a.getAttribute("aria-label"), bg: a.style.background })),
      name: $("agent-name").textContent, statusHidden: $("agent-status").hidden, status: $("agent-status-text").textContent,
      tab: $("agent-tab").textContent, tabHidden: $("agent-tab").hidden, nameTitle: $("agent-name").title, avatarBg: $("agent-avatar").style.background,
      driver: $("driver-text").textContent,
      people: [...$("people").children].map((li) => [...li.children].filter((c) => !c.classList.contains("avatar")).map((c) => c.textContent).join(" | ")),
      sessionHidden: $("session").hidden,
    };
  });
  const v = await view();
  assert.equal(v.whereHidden, false);
  assert.equal(v.where, "Local · Checkout test", "the session's name while no one is joined");
  assert.equal(v.whereTitle, "Local · Checkout test");
  assert.deepEqual(v.avatars.map((a) => a.text), ["C", "A", "S", "S", "+2"], "four initials, then +2 for six people");
  assert.deepEqual(v.avatars.map((a) => a.role), ["img", "img", "img", "img", "img"]);
  assert.deepEqual(v.avatars.map((a) => a.label), ["Claude", "Alice · Codex", "Sam · Claude Code", "Sam (by hand)", "2 more"]);
  assert.equal(v.avatars[0].bg, "rgb(233, 118, 63)", "in the board's color");
  assert.equal(v.avatars[3].bg, "", "no color given: the plain avatar");
  assert.equal(v.name, "Claude", "the newest action's agent");
  assert.equal(v.statusHidden, false);
  assert.equal(v.status, "Filling the shipping form", "its pairbrowse_status text, as it is");
  assert.equal(v.tabHidden, true, "#agent-tab stays (pinned id) but is never shown");
  assert.equal(v.tab, "");
  assert.equal(v.nameTitle, "In shop.example/checkout", "the tab the board says it is in, as the name's title");
  assert.equal(v.avatarBg, "rgb(233, 118, 63)");
  assert.equal(v.driver, "Working…", "B4's words; the name is beside it");
  assert.equal(await page.evaluate(() => document.getElementById("driver").dataset.state), "working");
  assert.equal(v.sessionHidden, false);
  assert.equal(v.people.length, 5, "everyone else, the active agent not repeated");
  assert.ok(!v.people.some((p) => /^Claude/.test(p)), "the active agent is on the card only");
  // The state in the left dock's words (words.js agentWords): Alice's agent is in this browser.
  assert.ok(v.people.some((p) => p.startsWith("Alice · Codex") && p.includes("Waiting for you")), "name, app, state in words");
  assert.ok(await page.evaluate(() => [...document.querySelectorAll("#people .st")].some((s) => s.title.includes("shop.example/cart"))), "the tab in the line's title");
  assert.ok(v.people.some((p) => p.startsWith("Sam · Claude Code") && p.includes("Done") && p.includes("Sam's browser")), "where");
  // The side panel has no left dock or strip: it keeps the people's rows (the plain-Chromium
  // guard of DESIGN.md Part G), the Live pill while the agent drives and Share in the session card.
  assert.ok(v.people.some((p) => p.startsWith("Sam (by hand)") && p.includes("Online")), "a person's row, Online");
  assert.equal(await page.evaluate(() => document.getElementById("status-live").checkVisibility()), true, "the Live pill while driving");
  assert.equal(await page.evaluate(() => document.getElementById("share-btn").checkVisibility()), true, "Share in the session card");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.host), "extension");
  assert.ok(v.people.some((p) => p.startsWith("Gemini · Gemini CLI") && p.includes("Checking prices")));
  assert.equal(await page.evaluate(() => document.querySelector("#people .app")?.textContent), " · Codex", "the app, apart from the name");

  const pause = await page.evaluate(() => ({ row: getComputedStyle(document.getElementById("pause")).gridRowStart, left: document.getElementById("pause").getBoundingClientRect().left, name: document.getElementById("agent-name").getBoundingClientRect().right }));
  assert.equal(pause.row, "1", "Pause on the name row");
  assert.ok(pause.left > pause.name, "right of the name");

  // A second action by the same agent: the people list is left as it is (same nodes).
  await inPage(() => { window.__people = [...document.getElementById("people").children]; });
  lv.push("activity", [{ t: t - 2000, text: "Opened **Cart**", who: "Alice · Codex", tab: "Cart" }, { t, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }, { t: t + 1, text: "Typed into **Name**", who: "Claude", tab: "Checkout" }]);
  await until("the new action", () => document.getElementById("activity").textContent.includes("Name"));
  assert.equal(await inPage(() => { const now = [...document.getElementById("people").children]; return now.length === window.__people.length && now.every((li, i) => li === window.__people[i]); }), true, "same agent: the list is not rebuilt");

  // A narrow panel (320px) with six people and a long session name: the state stays readable.
  await page.setViewportSize({ width: 320, height: 900 });
  lv.push("session", { name: "Checkout regression with a very long session name", where: "Local", temporary: false });
  await until("the long name", () => document.getElementById("where").title.includes("very long"));
  assert.ok(await page.evaluate(() => document.getElementById("where").textContent.includes("Checkout")), "the local pill shows the session name's first word");
  assert.ok(await page.evaluate(() => { const w = document.getElementById("where").getBoundingClientRect(); return w.right <= document.querySelector(".top").getBoundingClientRect().right + 0.5; }), "the pill stays inside the header");

  // Someone joined: the pill says so (dot plus the words).
  lv.push("collaboration", { participants: [{ id: "a", label: "Claude" }], owner: { label: "You" }, active: null, guests: [{ label: "Sam · Claude Code", role: "drive" }] });
  await until("the live pill", () => document.getElementById("where").textContent === "Live session");
  assert.ok(await page.evaluate(() => { const w = document.getElementById("where"); return w.scrollWidth <= w.clientWidth; }), "at 320px the live pill is whole");
  assert.ok(await page.evaluate(() => document.querySelector(".top").scrollWidth <= document.querySelector(".top").clientWidth), "the header does not overflow at 320px");
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await page.evaluate(() => document.querySelector("#where i")?.getAttribute("aria-hidden")), "true", "the dot is decoration");
  assert.equal(await page.evaluate(() => document.getElementById("collaboration").textContent), "1 connected · You has control");
  assert.equal((await view()).avatars.length, 5, "a guest already on the board is not counted twice");

  // Paused by a person: Resume, and a real click asks to resume.
  lv.push("pause", { paused: true, can: true, by: "Sam" });
  await until("paused", () => document.getElementById("pause-btn").textContent === "Resume");
  assert.equal(await page.evaluate(() => document.getElementById("pause-text").textContent), "Paused by Sam");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("pause-btn")).borderTopColor), "rgb(244, 180, 93)", "the warn edge");
  await page.click("#pause-btn");
  assert.deepEqual((await posted(lv, "pause"))[0]?.body, { paused: false });

  // A join request: a card with Allow and Deny; a synthetic click sends nothing, a real one does.
  lv.push("join", [{ id: "r1", name: "Sam", app: "Claude Code", role: "drive", state: "pending" }]);
  await until("the join card", () => !!document.querySelector("#joins .join"));
  assert.equal(await page.evaluate(() => document.querySelector("#joins .join strong").textContent), "Sam (Claude Code) wants to join (can drive)");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#joins .join button")].map((b) => b.textContent)), ["Allow", "Deny"]);
  assert.equal(await page.evaluate(() => document.querySelector("#joins").parentElement.firstElementChild.id), "joins", "requests first");
  await inPage(() => document.querySelector("#joins .join .primary").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await page.waitForTimeout(300);
  assert.equal(lv.posts.filter((p) => p.route === "approve").length, 0, "a synthetic click allows nothing");
  await page.click("#joins .join .primary");
  assert.deepEqual((await posted(lv, "approve"))[0]?.body, { id: "r1", allow: true });

  // Folding: Activity open, the rest folded; a click opens Session and is remembered.
  const fold = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("section.sec")].map((s) => [s.dataset.key, { expanded: s.querySelector(".disclose").getAttribute("aria-expanded"), hidden: s.querySelector(".body").hidden }])));
  let f = await fold();
  assert.deepEqual(f.activity, { expanded: "true", hidden: false });
  assert.deepEqual(f.session, { expanded: "false", hidden: true });
  assert.ok(await page.evaluate(() => document.getElementById("people").children.length > 0), "folded content stays in the page");
  await page.click("#session .disclose");
  f = await fold();
  assert.deepEqual(f.session, { expanded: "true", hidden: false });
  for (let i = 0; i < 40 && !(await inPage(() => localStorage.getItem("__store"))); i++) await page.waitForTimeout(50);
  assert.deepEqual(JSON.parse(await inPage(() => localStorage.getItem("__store"))), { "pb-panel": { collapsed: ["dev", "hosts", "details", "secrets"] } });
  // Keyboard: a disclosure takes focus and toggles with Enter (Remembered details is on the Tools tab).
  await page.click("#tab-tools");
  // Every Tools section in the side panel (no Settings page here): the profile sections stay and
  // the Settings row is the browser's only.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#pane-tools .scroll > section")].map((sec) => sec.id)),
    ["sec-handoffs", "sec-downloads", "sec-recordings", "dev", "hosts", "sec-details", "sec-secrets", "sec-settings-link", "sec-diag"]);
  assert.deepEqual(await page.evaluate(() => ["sec-details", "sec-secrets", "sec-settings-link"].map((id) => document.getElementById(id).checkVisibility())), [true, true, false]);
  lv.push("joinhost", { asks: [], hosts: [{ host: "tunnel.example.org", always: true }] });
  await until("Join addresses", () => document.getElementById("hosts").checkVisibility());
  await page.focus("#sec-details .disclose");
  await page.keyboard.press("Enter");
  assert.deepEqual((await fold()).details, { expanded: "true", hidden: false });
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "visible focus");

  assert.equal((await harness.live()).intervals, 0, "no interval while not recording");
  assert.deepEqual(errors, []);

  // The Tools tab over a helper without the Tools routes (all 404): Hand-offs and Downloads stay
  // hidden, Recordings keeps its Record button, Diagnostics says there are none; no error. (The
  // Tools tab is in front since the disclosure check above: its reads are answered.)
  await page.waitForTimeout(300);
  const tools = () => page.evaluate(() => Object.fromEntries(["sec-handoffs", "sec-downloads", "sec-recordings", "record-btn", "recordings", "sec-diag", "diag-none", "diag-prepare"].map((id) => [id, document.getElementById(id).checkVisibility()])));
  assert.deepEqual(await tools(), { "sec-handoffs": false, "sec-downloads": false, "sec-recordings": true, "record-btn": true, recordings: false, "sec-diag": true, "diag-none": false, "diag-prepare": false });
  await page.click("#sec-diag .disclose");
  await until("no diagnostics", () => document.getElementById("diag-none").checkVisibility());
  assert.equal(await page.evaluate(() => document.getElementById("diag-prepare").checkVisibility()), false, "nothing to prepare");
  assert.equal(await page.evaluate(() => document.getElementById("diag-msg").textContent), "", "a missing route is not an error");
  assert.deepEqual(errors, []);
  // Diagnostics is never stored as open.
  await page.waitForTimeout(200);
  assert.equal(JSON.parse(await inPage(() => localStorage.getItem("__store")))["pb-panel"].collapsed.includes("diagnostics"), false);

  // Reopened with Activity folded: as left.
  await inPage(() => localStorage.setItem("__store", JSON.stringify({ "pb-panel": { collapsed: ["activity", "bogus"] } })));
  await page.reload();
  await until("the stored folding", () => document.querySelector("#sec-activity .disclose").getAttribute("aria-expanded") === "false");
  f = await fold();
  assert.deepEqual(f.activity, { expanded: "false", hidden: true });
  assert.deepEqual(f.session, { expanded: "true", hidden: false });
  assert.deepEqual(f.secrets, { expanded: "true", hidden: false });
  assert.deepEqual(errors, []);
}));

// Without the extension's API (a plain page): defaults, no error.
describe("side panel without the extension's API: defaults", () => pageTest("right", { native: false, bridge: false, viewport: { width: 360, height: 900 } }, async ({ page, errors }) => {
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate((ids) => ids.every((id) => document.getElementById(id)), IDS));
  const f = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("section.sec")].map((s) => [s.dataset.key, s.querySelector(".body").hidden])));
  assert.deepEqual(f, { session: true, dev: true, hosts: true, activity: false, details: true, secrets: true, handoffs: false, downloads: false, recordings: false, diagnostics: true });
  // Nobody to connect to: No agent connected, where the card would be (no agent is named).
  assert.equal(await page.evaluate(() => document.getElementById("driver-text").textContent), "No agent connected");
  assert.deepEqual(await page.evaluate(() => [document.getElementById("agent-none-title").textContent, document.getElementById("agent-none").checkVisibility(), document.getElementById("agent").checkVisibility()]), ["No agent connected", true, false]);
}));

describe("side panel: Share by keyboard, and the Checklist reads the goal log at most every 5 s", () => pageTest("right", PANEL, async ({ page, helper, inPage, until, errors }) => {
  const lv = helper;
  const shots = process.env.PAIRBROWSE_TEST_SHOTS;
  await until("the stream", () => document.body.dataset.s === "live");
  await streamOpen(helper);
  // The Agent tab is in front: the goal log is read once when the stream opens.
  for (let i = 0; i < 60 && journalReads(lv) < 1; i++) await page.waitForTimeout(50);
  assert.equal(journalReads(lv), 1, "read once with the Agent tab in front");
  lv.push("session", { name: "Checkout test", where: "Local", temporary: false });
  lv.push("board", { people: [PANEL_PEOPLE[0]], messages: [] });
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("name") || document.activeElement?.tagName);

  // Keyboard: Tab to Share, Enter opens the card with focus on the first choice.
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 40 && (await active()) !== "share-btn"; i++) await page.keyboard.press("Tab");
  assert.equal(await active(), "share-btn", "Share is reachable with Tab");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), false);
  assert.equal(await page.getAttribute("#share-btn", "aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.value), "code", "focus on the first choice");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "visible focus on the radio");
  assert.equal(await page.evaluate(() => document.getElementById("share-result").hidden), true, "nothing more until a result");
  // The card opens above the session card, never over its own button.
  const at = await page.evaluate(() => ({ card: document.getElementById("share-card").getBoundingClientRect().bottom, btn: document.getElementById("share-btn").getBoundingClientRect().top }));
  assert.ok(at.card <= at.btn, `the card opens above the session card (${at.card} <= ${at.btn})`);

  // A synthetic click makes nothing; the first real Make asks for a first name.
  await inPage(() => document.getElementById("share-make").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await page.waitForTimeout(200);
  assert.equal(lv.posts.filter((p) => p.route === "invite").length, 0, "a synthetic click invites nobody");
  await page.click("#share-make");
  await until("the name field", () => !document.getElementById("share-name-row").hidden);
  assert.equal(await active(), "share-name", "the name field takes focus");
  assert.match(await page.evaluate(() => document.getElementById("share-msg").textContent), /^Not yet: /, "the helper's own words");
  await page.keyboard.type("Bob");
  await page.click("#share-make");
  await until("the code", () => document.getElementById("share-code").value === "pb-join:FAKE");
  assert.deepEqual(lv.posts.filter((p) => p.route === "invite").map((p) => p.body), [{ share: "code" }, { share: "code", name: "Bob" }]);
  assert.equal(await page.evaluate(() => document.getElementById("share-code").readOnly), true);
  assert.match(await page.evaluate(() => document.getElementById("share-rights").textContent), /Shared browser: they can drive\. The person pastes it/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("share-code")).fontFamily.includes("monospace")), true, "the code in mono");
  if (shots) await page.screenshot({ path: join(shots, "panel-share-card.png") });
  await page.click("#share-copy");
  for (let i = 0; i < 40 && (await inPage(() => window.__copied)) !== "pb-join:FAKE"; i++) await page.waitForTimeout(50);
  assert.equal(await inPage(() => window.__copied), "pb-join:FAKE", "the clipboard got the code");
  assert.equal(await page.evaluate(() => document.getElementById("share-msg").textContent), "Copied.");
  // Escape closes it, focus goes back to Share, and the code leaves the page.
  await page.focus("#share-copy");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), true);
  assert.equal(await active(), "share-btn", "focus back on Share");
  assert.equal(await page.getAttribute("#share-btn", "aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.getElementById("share-code").value), "", "the code is not kept in the page");
  // An outside click closes it too; the button toggles it.
  await page.click("#share-btn");
  assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), false);
  await page.click(".top h1"); // outside the card, on no control (the card now sits above the session card)
  assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), true, "outside click closes");
  await page.click("#share-btn");
  await page.click("#share-btn");
  assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), true, "the button closes it again");

  // A helper without the session route (404): Save goes away and the focus moves to Share
  // (the side panel's), never lost to the body.
  lv.push("session", { name: "Checkout test", where: "Local", temporary: false, canSave: true });
  await until("Save", () => document.getElementById("session-save").checkVisibility());
  lv.replies.session = () => ({ status: 404, body: { error: "Not found" } });
  await page.click("#session-save");
  await until("Save hidden", () => document.getElementById("session-save").hidden);
  assert.equal(await active(), "share-btn", "Save 404 moves focus to Share");
  delete lv.replies.session;

  // Checklist: open by default; an action reads it again (the last read was over 5 s ago),
  // rows in glyph and words.
  assert.equal(await page.getAttribute("#agent-more", "aria-expanded"), "true");
  await page.waitForTimeout(5200);
  const before = journalReads(lv);
  lv.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
  await until("the checklist", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4 && !!document.querySelector("#checklist-items li[data-state=current]"));
  for (let i = 0; i < 60 && journalReads(lv) < before + 1; i++) await page.waitForTimeout(50);
  assert.equal(journalReads(lv), before + 1, "an action reads once");
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#checklist-items li")].map((li) => ({ state: li.dataset.state, mark: li.querySelector(".mark").textContent, text: li.querySelector(".text").textContent })));
  const r = await rows();
  assert.deepEqual(r.map((x) => x.state), ["done", "current", "waiting", "pending"], "the newest done row is current while Claude drives");
  assert.deepEqual(r.map((x) => x.mark), ["✓", "◉", "●", "○"]);
  assert.match(r[0].text, /^Done: Sign up/);
  assert.match(r[1].text, /^Current: Details/);
  assert.equal(r[2].text, "Waiting for you: Enter the code");
  assert.equal(r[3].text, "Pending: VAT number");
  if (shots) await page.locator("#agent").screenshot({ path: join(shots, "panel-checklist.png") });
  // A burst of actions: one more read, five seconds after the last.
  const t = Date.now();
  for (let i = 0; i < 3; i++) { lv.push("activity", [{ t: t + i, text: `Act ${i}`, who: "Claude", tab: "Details" }]); await page.waitForTimeout(150); }
  await page.waitForTimeout(6000);
  assert.equal(journalReads(lv), before + 2, "a burst is one read");
  // Another tab in front: no read.
  await page.click("#tab-tools");
  lv.push("activity", [{ t: Date.now(), text: "Act 9", who: "Claude", tab: "Details" }]);
  await page.waitForTimeout(6000);
  assert.equal(journalReads(lv), before + 2, "nothing while Tools is in front");
  await page.click("#tab-agent");
  for (let i = 0; i < 60 && journalReads(lv) < before + 3; i++) await page.waitForTimeout(50);
  assert.equal(journalReads(lv), before + 3, "back on Agent: one read");
  // The chevron folds the steps and reads nothing.
  await page.click("#agent-more");
  assert.equal(await page.evaluate(() => document.getElementById("checklist").hidden), true);
  assert.equal(await page.getAttribute("#agent-more", "aria-expanded"), "false");
  await page.waitForTimeout(300);
  assert.equal(journalReads(lv), before + 3, "folding reads nothing");
  assert.deepEqual(errors, []);
}));

describe("side panel under reduced motion: no pulse, the chevron turns at once", () => pageTest("right", { native: false, bridge: false, viewport: { width: 360, height: 900 }, reducedMotion: "reduce" }, async ({ page, errors }) => {
  const s = await page.evaluate(() => ({
    pulse: getComputedStyle(document.querySelector("#status-live .live")).animationName,
    chevron: getComputedStyle(document.querySelector(".disclose"), "::before").transitionDuration,
  }));
  assert.equal(s.pulse, "none");
  assert.equal(s.chevron, "0.001s");
  assert.deepEqual(errors, []);
}));
describe("side panel with motion: the Live dot pulses", () => pageTest("right", { native: false, bridge: false, viewport: { width: 360, height: 900 } }, async ({ page }) => {
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#status-live .live")).animationName), "pulse", "the pulse is there when motion is allowed");
}));

test("no side panel in this browser (its own pages): notifications go to the system's at once, with no failure logged", async () => {
  const { createPanel } = await import("../scripts/daemon/panel.mjs");
  const logs = [], system = [];
  let asked = 0;
  const p = createPanel({ context: async () => { asked++; return null; }, liveViewUrl: async () => "", log: (...a) => logs.push(a.join(" ")), available: () => false, systemNotify: (say) => system.push(say) });
  p.notify("Sign in on shop.example");
  p.notifyJoin({ who: "Sam (Claude Code)", role: "drive", request: "r0a1b2c" });
  p.clearJoin("r0a1b2c");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(system, ["Sign in on shop.example", "Sam (Claude Code) wants to join (drive). Answer in PairBrowse's agent panel."]);
  assert.equal(asked, 0, "the browser isn't asked for a side panel");
  assert.ok(!logs.some((l) => /failed/.test(l)), logs.join("\n"));
  await assert.rejects(p.call(() => 1, null, 100), /no side panel/, "other callers still get an error");
});

describe("side panel: the card works on its own agent's actions only", () => pageTest("right", PANEL, async ({ page, helper, until, errors }) => {
  const lv = helper;
  await until("the stream", () => document.body.dataset.s === "live");
  await streamOpen(helper);
  const t = Date.now();
  // Claude idle on the board: the card reads the board's status as the left dock does (a board
  // "working" is "Working…" without any action).
  lv.push("board", { people: PANEL_PEOPLE.map((p) => (p.who === "Claude" ? { ...p, status: "idle", task: "" } : p)), messages: [] });
  const lines = [{ t: t - 60_000, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }];
  lv.push("activity", lines);
  await until("the card", () => document.getElementById("agent-name").textContent === "Claude");
  const driver = () => page.evaluate(() => document.getElementById("driver-text").textContent);
  assert.equal(await driver(), "Idle");
  lines.push({ t: Date.now(), text: "Clicked **Next**", who: "Alice", tab: "Checkout", from: "inv:alice" },
    { t: Date.now(), text: "Note: check the totals", who: "Bob", tab: "" },
    { t: Date.now(), text: "Opened **Docs**", who: "Sam · Claude Code", tab: "Docs", from: "joined" });
  lv.push("activity", lines);
  await until("the lines", () => document.getElementById("activity").children.length === 4);
  assert.equal(await driver(), "Idle", "listed, but not the card's agent's");
  assert.equal(await page.evaluate(() => document.getElementById("agent-name").textContent), "Claude");
  lv.push("activity", [...lines, { t: Date.now(), text: "Typed into **Name**", who: "Claude", tab: "Checkout" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  assert.deepEqual(errors, []);
}));
