// The right dock (ui/right/) in the pages' harness: window.pairbrowse present (the browser
// build's host), the fake helper's routes and stream. Tabs, the agent card's states in words,
// pause, the Checklist with the task and the saved time, the Status box, the participant rows,
// the session card, Pictures (with and without the timeline, never while hidden), Tools, the
// rail and the hidden dock, and the request count. The common checks stay in test/ui.test.mjs;
// the extension host (fake chrome, no shim) is test/right.test.mjs.
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";

const VIEWPORT = { width: 330, height: 936 };
const PEOPLE = [
  { who: "Claude", kind: "agent", color: "#e9763f", tab: "shop.example/checkout", task: "Filling the shipping form", status: "working", last: "Typed into Email" },
  { who: "Alice · Codex", kind: "agent", color: "#a78bfa", tab: "shop.example/cart", task: "", status: "you", last: "Clicked Cart" },
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
const posted = async (helper, route, n = 1) => { for (let i = 0; i < 40 && helper.posts.filter((p) => p.route === route).length < n; i++) await sleep(50); return helper.posts.filter((p) => p.route === route); };
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
  assert.equal(await inPage(visible, "#dock-expand"), false, "no sheet state in the mojom: no expand button");
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
  await until("paused", () => document.getElementById("driver-text").textContent === "Paused");
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
  assert.equal(await inPage(text, "pause-btn"), "Pause agents");
  const box = await inPage(() => { const b = document.getElementById("pause-btn"); const s = getComputedStyle(b); return { h: b.getBoundingClientRect().height, bg: s.backgroundColor, border: s.borderTopWidth }; });
  assert.equal(box.h, 32);
  assert.equal(box.bg, await inPage(token, "elevated"));
  assert.equal(box.border, "1px");
  await page.click("#pause-btn");
  assert.deepEqual((await posted(helper, "pause"))[0]?.body, { paused: true });
  helper.push("pause", { paused: true, can: true, by: "Sam" });
  await until("resume", () => document.getElementById("pause-btn").textContent === "Resume");
  assert.equal(await inPage(text, "pause-text"), "Paused by Sam");
  assert.deepEqual(errors, []);
}));

describe("checklist marks, task and saved", () => pageTest("right", opts({ journal: JOURNAL }), async ({ page, helper, inPage, until, errors }) => {
  helper.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
  await until("working", () => document.getElementById("driver-text").textContent === "Working…");
  assert.equal(await inPage(() => document.getElementById("task").hidden), true, "no task before the goal log is read");
  assert.equal(await inPage(() => document.getElementById("session-saved").hidden), true);
  await page.click("#agent-more");
  await until("the checklist", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
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
  const rows = await inPage(() => [...document.querySelectorAll("#people li")].map((li) => ({ h: li.getBoundingClientRect().height, text: li.textContent })));
  for (const r of rows) assert.ok(r.h >= 56, `${r.text}: ${r.h}px`);
  const alice = rows.findIndex((r) => r.text.includes("Alice"));
  assert.ok(alice >= 0 && rows[alice].text.includes("waiting for their person") && rows[alice].text.includes("shop.example/cart"), rows[alice]?.text);
  const sel = `#people li:nth-child(${alice + 1})`;
  assert.equal(await page.getAttribute(`${sel} .chev`, "aria-expanded"), "false");
  assert.equal(await inPage(visible, `${sel} .acts`), false);
  await page.click(`${sel} .chev`);
  assert.equal(await inPage(visible, `${sel} .acts`), true);
  assert.match(await inPage((s) => document.querySelector(s).textContent, `${sel} .acts`), /Clicked Cart/);
  assert.equal(await inPage(() => document.querySelectorAll(".pause-one").length), 0, "no per-agent pause from today's helper");
  helper.push("pause", { paused: false, can: true, perAgent: true });
  await until("per-agent pause", () => document.querySelectorAll(".pause-one").length === 4);
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

describe("session card", () => pageTest("right", opts({ session: { name: "Checkout test", where: "Local", temporary: false } }), async ({ page, helper, inPage, until, errors }) => {
  await until("the session name", () => document.getElementById("session-name").textContent === "Checkout test");
  assert.equal(await inPage(visible, "#session-line"), true);
  const card = await inPage(() => { const c = document.getElementById("session-card").getBoundingClientRect(); return { bottom: c.bottom, vh: innerHeight }; });
  assert.ok(Math.abs(card.bottom - card.vh) < 1, "pinned to the bottom, visible without scrolling");
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("switch-btn")).color), await inPage(token, "bad"));
  assert.equal(await inPage(() => document.querySelectorAll("#session-card .row3 button").length), 2, "Share and End session; no Save, no rename without a helper route");
  // The confirm sits in the card (a dock slot has no JavaScript dialogs): no dialog may open.
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  const picks = () => helper.posts.filter((p) => p.route === "picker").length;
  await page.click("#switch-btn");
  await until("the in-card confirm", () => !document.getElementById("end-confirm").hidden);
  assert.equal(await inPage(() => document.getElementById("switch-btn").getAttribute("aria-expanded")), "true");
  assert.equal(await inPage(() => document.activeElement?.id), "end-no", "focus moves to Keep, so a second Enter ends nothing");
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
  assert.deepEqual(errors, []);
}));

describe("rail and hidden", () => pageTest("right", opts(), async ({ page, helper, shim, inPage, until, errors }) => {
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  assert.equal(await inPage(visible, "#rail"), true);
  assert.equal(await inPage(visible, "main"), false);
  assert.equal(await inPage(() => document.getElementById("rail").getBoundingClientRect().width), 44);
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
