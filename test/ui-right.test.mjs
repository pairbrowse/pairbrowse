// The right dock (ui/right/) in the pages' harness: window.pairbrowse present (the browser
// build's host), the fake helper's routes and stream. Tabs, the agent card's states in words,
// pause, the Checklist with the task and the saved time, the Status box, the participant rows,
// the session card, Pictures (with and without the timeline, never while hidden), Tools, the
// rail and the hidden dock, the collapse and expand buttons, and the request count. The common
// checks stay in test/ui.test.mjs; the extension host (no shim) is covered by its own scenario
// here (native: false) and by test/right.test.mjs (fake chrome).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTest, runtime } from "./helpers/ui-page.mjs";
import { patchright } from "./live.mjs";
import { startFakeHelper } from "./helpers/fake-helper.mjs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    [["Agent", "true", 0], ["Page", "false", -1], ["Pictures", "false", -1], ["Tools", "false", -1]]);
  assert.equal(await inPage(() => document.querySelector(".tabs").getBoundingClientRect().height), 44);
  assert.equal(await inPage(() => document.querySelector(".tabs").getBoundingClientRect().top), 0, "the tab bar comes first");
  await page.click("#tab-tools");
  assert.deepEqual(await inPage(() => ["agent", "page", "pictures", "tools"].map((t) => document.getElementById(`pane-${t}`).checkVisibility())), [false, false, false, true]);
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("tab-tools")).boxShadow.includes("inset")), true, "the accent underline");
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
  assert.equal(collapse.w, 24);
  assert.equal(collapse.h, 24);
  assert.ok(Math.abs(collapse.right - (330 - 6)) <= 1, `right edge ${collapse.right}`);
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
  assert.equal(await inPage(visible, "#status-live"), true, "the Live pill while driving");
  assert.equal(await inPage(() => getComputedStyle(document.querySelector("#driver .dot")).backgroundColor), await inPage(token, "ok"));
  helper.push("status", { kind: "you", text: "Solve the CAPTCHA" });
  await until("your turn", () => document.getElementById("driver-text").textContent === "Waiting for you");
  assert.equal(await inPage(text, "turn-text"), "Solve the CAPTCHA", "the helper's own words");
  assert.equal(await inPage(() => document.body.dataset.turn), "true");
  assert.equal(await inPage(visible, "#turn"), true);
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("driver")).color), await inPage(token, "warn"));
  assert.equal(await inPage(visible, "#status-live"), false, "not driving while it waits for you");
  helper.push("status", { kind: "clear", text: "" });
  helper.push("pause", { paused: true, can: true, by: "Sam" });
  await until("paused", () => document.getElementById("driver-text").textContent === "Paused by Sam");
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("driver")).color), await inPage(token, "muted"), "paused in --muted, words and dot");
  assert.equal(await inPage(visible, "#turn"), false);
  await page.click("#agent-fold");
  assert.equal(await inPage(visible, "#agent-body"), false, "folded to one line");
  assert.equal(await page.getAttribute("#agent-fold", "aria-expanded"), "false");
  assert.equal(await page.getAttribute("#agent-fold", "aria-label"), "Expand the agent card");
  await page.click("#agent-fold");
  assert.equal(await inPage(visible, "#agent-body"), true);
  assert.deepEqual(errors, []);
}));

describe("pause and resume", () => pageTest("right", opts({ pause: { paused: false, can: true } }), async ({ page, helper, inPage, until, errors }) => {
  await until("the pause row", () => !document.getElementById("pause").hidden);
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
  assert.equal(box.h, 32);
  assert.equal(box.bg, await inPage(token, "elevated"));
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

describe("checklist marks, task and saved", () => pageTest("right", opts({ journal: JOURNAL }), async ({ page, helper, inPage, until, errors }) => {
  // No task before the goal log is read: the served markup starts with it hidden, the steps open.
  assert.match(SERVED, /<div class="task" id="task" hidden>/, "no task before the goal log is read");
  assert.match(SERVED, /<small class="saved" id="session-saved" hidden>/, "no Saved line before the goal log is read");
  assert.match(SERVED, /<button class="more" id="agent-more"[^>]*aria-expanded="true"/);
  assert.equal(await inPage(visible, "#checklist"), true, "the checklist is open on load");
  helper.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  await until("the checklist, no click needed", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
  const rows = await inPage(() => [...document.querySelectorAll("#checklist-items li")].map((li) => {
    const m = getComputedStyle(li.querySelector(".mark"));
    const r = li.querySelector(".mark").getBoundingClientRect();
    return { state: li.dataset.state, h: li.getBoundingClientRect().height, w: r.width, mh: r.height, bg: m.backgroundColor, color: m.color, border: m.borderTopWidth, borderColor: m.borderTopColor };
  }));
  assert.deepEqual(rows.map((r) => r.state), ["done", "current", "waiting", "pending"]);
  for (const r of rows) { assert.ok(r.h >= 30, `${r.state}: ${r.h}px row`); assert.equal(r.w, 18); assert.equal(r.mh, 18); }
  assert.equal(rows[0].bg, await inPage(token, "ok"), "done: filled --ok");
  assert.equal(rows[0].color, "rgb(255, 255, 255)", "the white check");
  assert.equal(rows[1].border, "2px");
  assert.equal(rows[1].borderColor, await inPage(token, "accent"), "current: a 2 px --accent ring");
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
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("agent-status")).borderTopWidth), "1px");
  helper.push("board", { people: [{ ...PEOPLE[0], task: "" }], messages: [] });
  await until("no status", () => document.getElementById("agent-status-text").textContent === "No status from the agent yet.");
  assert.equal(await inPage(visible, "#agent-status"), true, "the box stays");
  assert.deepEqual(errors, []);
}));

describe("participants", () => pageTest("right", opts({ board: { people: PEOPLE, messages: [] }, activity: [{ t: Date.now(), text: "Typed into **Email**", who: "Claude", tab: "Checkout" }] }), async ({ page, helper, inPage, until, errors }) => {
  await until("the rows", () => document.querySelectorAll("#people li").length === 5);
  const rows = await inPage(() => [...document.querySelectorAll("#people li")].map((li) => {
    const line = (el) => ({ h: el.getBoundingClientRect().height, ws: getComputedStyle(el).whiteSpace });
    const st = li.querySelector(".st");
    return { h: li.getBoundingClientRect().height, text: li.textContent, name: line(li.querySelector(".name")), st: line(st), stText: st.textContent, first: getComputedStyle(st, "::first-letter").textTransform };
  }));
  for (const r of rows) {
    assert.ok(r.h >= 56, `${r.text}: ${r.h}px`);
    for (const k of ["name", "st"]) { assert.ok(r[k].h <= 18, `${r.text}: .${k} is one line (${r[k].h}px)`); assert.equal(r[k].ws, "nowrap"); }
  }
  const alice = rows.findIndex((r) => r.text.includes("Alice"));
  assert.ok(alice >= 0 && rows[alice].stText.includes("waiting for their person") && rows[alice].stText.includes("shop.example/cart"), rows[alice]?.stText);
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
  // From the keyboard: a trusted Enter pauses too (pausing is the safe direction).
  await page.focus(`${sel} .pause-one`);
  await page.keyboard.press("Enter");
  assert.deepEqual((await posted(helper, "pause", 2))[1]?.body, { paused: true, who: "Alice · Codex" }, "Enter on Pause this agent pauses it");
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
  assert.ok(card.vh - card.bottom >= 0 && card.vh - card.bottom <= 12, `a raised card just above the bottom (its 10 px margin): ${card.vh - card.bottom}`);
  const end = await inPage(() => { const s = getComputedStyle(document.getElementById("switch-btn")); return { color: s.color, bg: s.backgroundColor, shadow: s.boxShadow }; });
  assert.equal(end.color, await inPage(token, "bad"));
  assert.equal(end.bg, await inPage(token, "bad-soft", "backgroundColor"), "a red-tinted fill");
  assert.match(end.shadow, /rgba?\(239, 100, 104/, "a soft red halo");
  assert.equal(await inPage(() => [...document.querySelectorAll("#session-card .row3 button")].filter((b) => b.checkVisibility()).length), 2, "Share and End session; no Save, no rename without a helper route");
  assert.equal(await inPage(() => document.getElementById("session-save").hidden && document.getElementById("session-rename").hidden), true);
  // The confirm sits in the card (a dock slot has no JavaScript dialogs): no dialog may open.
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  const picks = () => helper.posts.filter((p) => p.route === "picker").length;
  await page.click("#switch-btn");
  await until("the in-card confirm", () => !document.getElementById("end-confirm").hidden);
  assert.equal(await inPage(() => document.getElementById("switch-btn").getAttribute("aria-expanded")), "true");
  assert.equal(await inPage(() => document.activeElement?.id), "end-no", "focus moves to Keep, so a second Enter ends nothing");
  const yes = await inPage(textContrast, "#end-yes");
  assert.ok(yes >= 4.5, `End session in the confirm keeps AA on its box: ${yes.toFixed(2)}:1`);
  await sleep(300);
  assert.equal(picks(), 0, "the first click only asks");
  await page.click("#end-no");
  await until("the confirm closes", () => document.getElementById("end-confirm").hidden);
  assert.equal(await inPage(() => document.activeElement?.id), "switch-btn", "Keep returns focus");
  await sleep(300);
  assert.equal(picks(), 0, "Keep ends nothing");
  await page.click("#switch-btn");
  await until("the confirm again", () => !document.getElementById("end-confirm").hidden);
  await page.keyboard.press("Escape");
  await until("Escape closes it", () => document.getElementById("end-confirm").hidden);
  assert.equal(picks(), 0, "Escape ends nothing");
  await page.click("#switch-btn");
  await until("the confirm once more", () => !document.getElementById("end-confirm").hidden);
  await inPage(() => document.getElementById("end-yes").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await sleep(300);
  assert.equal(picks(), 0, "a synthetic click ends nothing");
  await page.click("#end-yes");
  assert.equal((await posted(helper, "picker")).length, 1, "End session opens the picker");
  await until("the confirm closes after", () => document.getElementById("end-confirm").hidden);
  // From the keyboard: the focus lands on Keep; Shift+Tab reaches End session, and Enter there ends it.
  await page.click("#switch-btn");
  await until("the confirm by keyboard", () => !document.getElementById("end-confirm").hidden && document.activeElement?.id === "end-no");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await inPage(() => document.activeElement?.id), "end-yes", "Shift+Tab reaches End session");
  await page.keyboard.press("Enter");
  assert.equal((await posted(helper, "picker", 2)).length, 2, "Enter on End session opens the picker");
  await until("the confirm closes after Enter", () => document.getElementById("end-confirm").hidden);
  assert.equal(dialogs, 0, "no JavaScript dialog");
  await page.click("#share-btn");
  await until("the share card", () => !document.getElementById("share-card").hidden);
  const at = await inPage(() => ({ card: document.getElementById("share-card").getBoundingClientRect().bottom, btn: document.getElementById("share-btn").getBoundingClientRect().top }));
  assert.ok(at.card <= at.btn, "the card opens above the session card");
  assert.deepEqual(errors, []);
}));

describe("session card with the helper's routes", () => pageTest("right", opts({ session: { name: "Checkout test", where: "Local", canSave: true, canRename: true } }), async ({ page, helper, inPage, until, errors }) => {
  await until("Save and the pencil", () => document.getElementById("session-save").checkVisibility() && document.getElementById("session-rename").checkVisibility());
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
  assert.equal(await inPage(() => document.activeElement?.id), "share-btn", "focus moves to Share, not lost to the body");
  // The fold hides the buttons.
  await page.click("#session-fold");
  assert.equal(await inPage(visible, "#session-actions"), false);
  assert.equal(await page.getAttribute("#session-fold", "aria-expanded"), "false");
  await page.click("#session-fold");
  assert.equal(await inPage(visible, "#session-actions"), true);
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
  assert.equal(await inPage(text, "outline-empty"), "No outline yet.");
  assert.deepEqual(errors, []);
}));

describe("tools", () => pageTest("right", opts(), async ({ page, helper, inPage, until, errors }) => {
  await page.click("#tab-tools");
  assert.deepEqual(await inPage(() => ["sec-details", "sec-secrets", "dev", "hosts"].map((id) => document.getElementById(id).closest(".pane").id)), ["pane-tools", "pane-tools", "pane-tools", "pane-tools"]);
  helper.push("dev", { asks: [], shared: [{ port: 3000 }], open: [], joiners: 1 });
  await until("the dev section", () => !document.getElementById("dev").hidden);
  assert.match(await inPage(text, "devs"), /localhost:3000 · shared/);
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
  const secs = await inPage(() => [...document.querySelectorAll("#pane-tools section.sec")].map((sec) => {
    const b = sec.querySelector(".disclose");
    return { id: sec.id, head: [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""), expanded: b.getAttribute("aria-expanded") };
  }));
  assert.deepEqual(secs.map((x) => x.id), ["sec-handoffs", "sec-downloads", "sec-recordings", "dev", "hosts", "sec-details", "sec-secrets", "sec-diag"]);
  assert.deepEqual(secs.map((x) => x.head), ["Hand-offs", "Downloads", "Recordings", "Dev servers", "Join addresses", "Remembered details", "Passwords", "Diagnostics"]);
  assert.deepEqual(secs.map((x) => x.expanded), ["true", "true", "true", "false", "false", "false", "false", "false"]);
  await until("Hand-offs and Downloads shown", () => document.getElementById("sec-handoffs").checkVisibility() && document.getElementById("sec-downloads").checkVisibility());
  assert.equal(await inPage(text, "handoffs-empty"), "Nothing waiting for you.");
  assert.equal(await inPage(text, "downloads-empty"), "Nothing downloaded in this session.");
  await until("No recordings yet", () => document.getElementById("recordings-empty").checkVisibility());
  await page.click("#tab-agent");
  await page.click("#tab-tools");
  await sleep(300);
  for (const r of LIST_ROUTES) assert.equal(reads(helper, r), 1, `${r}: once per connection`);
  assert.equal(reads(helper, "diagnostics.json"), 0, "no diagnostics.json while folded");
  await page.click("#sec-diag .disclose");
  await waitFor("one diagnostics read", () => reads(helper, "diagnostics.json") === 1);
  await sleep(200);
  assert.equal(reads(helper, "diagnostics.json"), 1);
  await page.click("#tab-agent");
  await sleep(200);
  assert.equal(reads(helper, "diagnostics.json"), 1, "nothing while another tab is in front");
  await page.click("#tab-tools");
  await waitFor("again on a show while open", () => reads(helper, "diagnostics.json") === 2);
  await page.click("#sec-diag .disclose");
  await page.click("#tab-agent");
  await page.click("#tab-tools");
  await sleep(300);
  assert.equal(reads(helper, "diagnostics.json"), 2, "folded: not read on a show");
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
describe("diagnostics", () => pageTest("right", opts({ diagnostics: DIAG }), async ({ page, helper, inPage, until, errors }) => {
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

describe("diagnostics without the route", () => pageTest("right", opts({ diagnostics: null }), async ({ page, inPage, until, errors }) => {
  await page.click("#tab-tools");
  await page.click("#sec-diag .disclose");
  await until("none", () => document.getElementById("diag-none").checkVisibility());
  assert.equal(await inPage(text, "diag-none"), "This PairBrowse doesn't offer diagnostics yet.");
  assert.equal(await inPage(visible, "#diag-prepare"), false);
  assert.equal(await inPage(visible, "#diag"), false);
  assert.equal(await inPage(text, "diag-msg"), "");
  assert.deepEqual(errors, []);
}));

describe("diagnostics read fails", () => pageTest("right", opts({ diagnostics: "not an object" }), async ({ page, inPage, until, errors }) => {
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
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".rail-btn")].map((b) => b.getAttribute("aria-label"))), ["Agent", "Page", "Pictures", "Tools"]);
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
  assert.equal(await page.getAttribute("#agent-count", "aria-label"), "1 request");
  await page.click("#tab-agent");
  assert.equal(await inPage(visible, "#agent-count"), false, "hidden on the Agent tab");
  await inPage(() => document.querySelector("#joins .join .primary").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await sleep(300);
  assert.equal(helper.posts.filter((p) => p.route === "approve").length, 0, "a synthetic click allows nothing");
  await page.click("#joins .join .primary");
  assert.deepEqual((await posted(helper, "approve"))[0]?.body, { id: "r1", allow: true });
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
