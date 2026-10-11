// The side panel (scripts/browser/panel/panel.*): the agent panel. The markup keeps every id the
// scripts and the helper look up, the sections fold, the logo is untouched; with the runtime, the
// page is rendered as the extension serves it, fed by a fake owner event stream, and checked for
// what it shows, what a click sends and that a synthetic click sends nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inPage } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panel = join(root, "scripts", "browser", "panel");
const read = (name) => readFileSync(join(panel, name), "utf8");
const html = read("panel.html");
const js = read("panel.js");
const css = read("panel.css");
const sha = (p) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");

const IDS = ["where", "turn", "turn-text", "joins", "dev-asks", "host-asks", "driver", "driver-text", "pause", "pause-text", "pause-btn",
  "switch-btn", "record-btn", "record-note", "session", "people", "messages", "hosts", "host-list", "dev", "devs", "collaboration",
  "activity", "details", "add-detail", "secrets", "add-secret", "profile-msg", "avatars", "agent", "agent-name", "agent-avatar",
  "agent-status", "agent-status-text", "agent-tab", "share-btn", "share-card", "share-name", "share-make", "share-code", "share-copy",
  "share-msg", "agent-more", "checklist", "checklist-items"];
const KEYS = ["session", "dev", "hosts", "activity", "details", "secrets"];

test("the panel's markup keeps every id once, and each section folds with a named button", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  for (const id of IDS) assert.equal(ids.filter((x) => x === id).length, 1, `#${id} once`);
  assert.equal(new Set(ids).size, ids.length, "no id twice");
  for (const key of KEYS) {
    const sec = html.match(new RegExp(`<section class="sec"[^>]*data-key="${key}"[^>]*>\\s*<h2><button class="disclose" type="button" aria-expanded="(true|false)" aria-controls="([^"]+)">`));
    assert.ok(sec, `${key}: an h2 disclosure button`);
    assert.equal(sec[1], key === "activity" ? "true" : "false", `${key}: ${key === "activity" ? "open" : "folded"} by default`);
    const body = html.match(new RegExp(`<div class="body" id="${sec[2]}"( hidden)?>`));
    assert.ok(body, `${key}: its body #${sec[2]} exists`);
    assert.equal(!!body[1], key !== "activity", `${key}: body hidden matches aria-expanded`);
  }
  for (const id of ["joins", "dev-asks", "host-asks"]) assert.match(html, new RegExp(`id="${id}" role="region" aria-label="[^"]+" aria-live="assertive"`), id);
  const status = html.match(/<section class="status"[^>]*>\s*<div class="joins" id="joins"[^>]*><\/div>\s*<div class="joins" id="dev-asks"[^>]*><\/div>\s*<div class="joins" id="host-asks"/);
  assert.ok(status, "requests come first in the status section");
  for (const id of ["collaboration", "profile-msg"]) assert.match(html, new RegExp(`id="${id}" role="status" aria-live="polite"`), id);
  assert.match(html, /<link rel="stylesheet" href="tokens.css">\n<link rel="stylesheet" href="panel.css">/);
  assert.match(html, /<meta name="color-scheme" content="dark">/);
  for (const name of ["label", "value", "domains"]) assert.match(html, new RegExp(`name="${name}"`), name);
  // Share and the Checklist: buttons that say what they open and whether it is open.
  for (const [id, target] of [["share-btn", "share-card"], ["agent-more", "checklist"]]) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.match(tag, /aria-expanded="false"/, id);
    assert.match(tag, new RegExp(`aria-controls="${target}"`), id);
    assert.match(html, new RegExp(`id="${target}"[^>]*hidden`), `#${target} starts hidden`);
  }
  assert.match(html, /<div class="share-card" id="share-card" role="dialog" aria-labelledby="share-title" hidden>/);
  assert.deepEqual([...html.matchAll(/<input type="radio" name="share" value="(\w+)"/g)].map(([, v]) => v), ["code", "link"]);
  assert.match(html, /id="share-code" readonly aria-label="[^"]+"/);
  assert.match(html, /id="share-msg" role="status" aria-live="polite"/);
  assert.match(html, /<p class="sr" id="checklist-said" role="status" aria-live="polite"><\/p><ol id="checklist-items" aria-label="[^"]+">/);
  assert.match(html, /<header class="top">[\s\S]*id="where"[^>]*><\/span>\s*<button class="mini share-btn" id="share-btn"/, "Share comes after the session pill");
});

test("the logo is untouched: the same img line and the same files", () => {
  assert.ok(html.includes('    <img src="logo.svg" alt="" width="22" height="22">\n'), "the header's logo line");
  assert.equal(sha("scripts/browser/panel/logo.svg"), "415a3f8e100338210d7ffc070dd1d7ced24297bb682af9a4153a9f49d1bffd8a");
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
  assert.equal([...js.matchAll(/new EventSource\(/g)].length, 1, "one event stream");
  assert.equal(new Set([...js.matchAll(/"(pb-[a-z-]+)"/g)].map(([, k]) => k)).size, 1, "one storage key");
  assert.match(js, /"pb-panel"/);
  assert.doesNotMatch(js, /(^|[^.?])chrome\.storage/m, "every chrome.* access is guarded");
});

test("the panel's sheet: no blur, no spin, motion only on the turn card, request cards and new activity", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(plain, /backdrop-filter/);
  assert.doesNotMatch(plain, /@keyframes turn\b/);
  assert.doesNotMatch(plain, /rotate\(360deg\)/);
  assert.doesNotMatch(plain, /outline:\s*none/);
  for (const [, sel, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\banimation\s*:/.test(body) || /animation:\s*none/.test(body)) continue;
    assert.match(sel, /\.turn|\.join|\.activity li/, `${sel.trim()} animates`);
  }
  assert.match(plain, /@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition-duration: 1ms !important; \} \}/);
});

// --- Rendered, with a fake owner event stream (live view server) and a fake extension API. ---

const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml" };

// The live view's side: events?panel=1 as an event stream the test pushes into, profile.json,
// and the POST routes the panel calls, recorded.
const JOURNAL = { name: "shop.example 2026-10-11 10:00", status: "in progress", done: ["Sign up <https://shop.example/signup>: Filled **Email**", "Details <https://shop.example/details>: Filled **Name**"], yourTurn: ["Enter the code"], left: ["VAT number"], updatedAt: "2026-10-11T10:00:00.000Z" };
async function fakeLiveView() {
  const streams = new Set();
  const posts = [];
  const counts = { journal: 0 };
  const server = createServer((req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/k/events") {
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": hi\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (path === "/k/journal.json") { counts.journal++; res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify(JOURNAL)); }
    if (path === "/k/profile.json") { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify({ details: [], secrets: [] })); }
    if (req.method === "POST" && path.startsWith("/k/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body || "null"); } catch {}
        posts.push({ route: path.slice(3), body: parsed });
        // The Share card's invite: the helper's refusal while no name is known, then a code.
        if (path === "/k/invite") {
          const named = typeof parsed?.name === "string" && parsed.name;
          res.writeHead(named ? 200 : 409, { ...cors, "content-type": "application/json" });
          return res.end(JSON.stringify(named ? { ok: true, id: "abcd1234", share: "code", role: "drive", mode: "shared", code: "pb-join:FAKE", rights: "Shared browser: they can drive.", hint: "The person pastes it into their own PairBrowse." } : { error: "Not yet: ask the user what name the people they invite should see.", needName: true }));
        }
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end("{}");
      });
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/k/`;
  const push = (event, data) => { for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const close = () => { for (const res of streams) res.destroy(); server.close(); };
  return { base, posts, push, close, streams, counts };
}

// chrome.storage as the side panel has it: session holds the live view address; local is kept
// in the page's localStorage so it survives a reload. Counts setInterval calls.
const fakeChrome = (base) => `(() => {
  const si = window.setInterval; window.__intervals = 0;
  window.setInterval = (...a) => { window.__intervals++; return si(...a); };
  const load = () => { try { return JSON.parse(localStorage.getItem("__store") || "{}"); } catch { return {}; } };
  window.chrome = { storage: {
    session: { get: async () => ({ view: ${JSON.stringify(base)} }) },
    local: {
      get: async (k) => { const s = load(); return k in s ? { [k]: s[k] } : {}; },
      set: async (o) => { localStorage.setItem("__store", JSON.stringify({ ...load(), ...o })); },
    },
    onChanged: { addListener() {} },
  } };
  window.__copied = null;
  try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); } catch {}
})();`;

// The panel's files are served by page.route as the extension serves them. With a live view
// address, on that address's origin (Chromium keeps a page on another origin from reaching a
// loopback server), its /k/ routes left to the fake server.
async function openPanel(browser, { base = null, reducedMotion = "no-preference" } = {}) {
  const page = await browser.newPage({ viewport: { width: 360, height: 900 }, reducedMotion });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const origin = base ? new URL(base).origin : "http://pairbrowse.test";
  await page.route((url) => url.origin === origin && !url.pathname.startsWith("/k/"), (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "fake-chrome.js") return route.fulfill({ contentType: TYPES.js, body: fakeChrome(base) });
    let body = readFileSync(join(panel, name));
    // The extension's API before the panel's script, as the side panel has it.
    if (name === "panel.html" && base) body = String(body).replace('<script type="module" src="panel.js">', '<script src="fake-chrome.js"></script><script type="module" src="panel.js">');
    return route.fulfill({ contentType: TYPES[name.split(".").pop()], body });
  });
  await page.goto(`${origin}/panel.html`);
  return { page, errors };
}

const until = async (page, what, fn, arg) => {
  for (let i = 0; i < 100; i++) { if (await page.evaluate(fn, arg)) return; await page.waitForTimeout(50); }
  assert.fail(`timed out waiting for ${what}`);
};

const PEOPLE = [
  { who: "Claude", kind: "agent", color: "#e9763f", tab: "shop.example/checkout", task: "Filling the shipping form", status: "working", last: "Typed into Email" },
  { who: "Alice · Codex", kind: "agent", color: "#a78bfa", tab: "shop.example/cart", task: "", status: "you", last: "Clicked Cart" },
  { who: "Sam · Claude Code", kind: "agent", color: "#22d3ee", where: "Sam", tab: "docs.example", task: "", status: "done", last: "Read the docs" },
  { who: "Sam (by hand)", kind: "person", color: "", where: "Sam", status: "idle" },
  { who: "Gemini · Gemini CLI", kind: "agent", color: "#20c997", tab: "shop.example/prices", task: "Checking prices", status: "working" },
  { who: "Bob · Codex", kind: "agent", color: "nope", tab: "bob.example", status: "idle", last: "Opened a tab" },
];

test("the panel, fed by the owner stream: header, agent card, people, pause, requests and folding", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  const lv = await fakeLiveView();
  try {
    const { page, errors } = await openPanel(browser, { base: lv.base });
    await until(page, "the stream", () => document.body.dataset.s === "live");
    for (let i = 0; i < 50 && !lv.streams.size; i++) await page.waitForTimeout(50);
    const t = Date.now();
    lv.push("status", { kind: "agent", text: "" });
    lv.push("session", { name: "Checkout test", where: "Local", temporary: false });
    lv.push("collaboration", { participants: [{ id: "a", label: "Claude" }], owner: { label: "You" }, active: null, guests: [] });
    lv.push("board", { people: PEOPLE, messages: [{ from: "Sam", to: "all", text: "Take the cart", t }] });
    lv.push("activity", [{ t: t - 2000, text: "Opened **Cart**", who: "Alice · Codex", tab: "Cart" }, { t, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }]);
    lv.push("pause", { paused: false, can: true });
    await until(page, "the board", () => document.getElementById("people").children.length > 0 && !document.getElementById("pause").hidden);

    const view = () => page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return {
        where: $("where").textContent, whereHidden: $("where").hidden, whereTitle: $("where").title,
        avatars: [...$("avatars").querySelectorAll(".avatar")].map((a) => ({ text: a.textContent, role: a.getAttribute("role"), label: a.getAttribute("aria-label"), bg: a.style.background })),
        name: $("agent-name").textContent, statusHidden: $("agent-status").hidden, status: $("agent-status-text").textContent,
        tab: $("agent-tab").textContent, tabHidden: $("agent-tab").hidden, avatarBg: $("agent-avatar").style.background,
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
    assert.equal(v.tabHidden, false);
    assert.equal(v.tab, "In shop.example/checkout", "the tab the board says it is in");
    assert.equal(v.avatarBg, "rgb(233, 118, 63)");
    assert.equal(v.driver, "Claude is driving");
    assert.equal(v.sessionHidden, false);
    assert.equal(v.people.length, 5, "everyone else, the active agent not repeated");
    assert.ok(!v.people.some((p) => /^Claude/.test(p)), "the active agent is on the card only");
    assert.ok(v.people.some((p) => p.startsWith("Alice · Codex") && p.includes("waiting for their person") && p.includes("shop.example/cart")), "name, app, state in words, tab");
    assert.ok(v.people.some((p) => p.startsWith("Sam · Claude Code") && p.includes("done") && p.includes("Sam's browser")), "where");
    assert.ok(v.people.some((p) => p.startsWith("Gemini · Gemini CLI") && p.includes("Checking prices")));
    assert.equal(await page.evaluate(() => document.querySelector("#people .app")?.textContent), " · Codex", "the app, apart from the name");

    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("pause")).gridColumnStart), "1", "the pause block spans the card");

    // A second action by the same agent: the people list is left as it is (same nodes).
    await inPage(page, () => { window.__people = [...document.getElementById("people").children]; });
    lv.push("activity", [{ t: t - 2000, text: "Opened **Cart**", who: "Alice · Codex", tab: "Cart" }, { t, text: "Typed into **Email**", who: "Claude", tab: "Checkout" }, { t: t + 1, text: "Typed into **Name**", who: "Claude", tab: "Checkout" }]);
    await until(page, "the new action", () => document.getElementById("activity").textContent.includes("Name"));
    assert.equal(await inPage(page, () => { const now = [...document.getElementById("people").children]; return now.length === window.__people.length && now.every((li, i) => li === window.__people[i]); }), true, "same agent: the list is not rebuilt");

    // A narrow panel (320px) with six people and a long session name: the state stays readable.
    await page.setViewportSize({ width: 320, height: 900 });
    lv.push("session", { name: "Checkout regression with a very long session name", where: "Local", temporary: false });
    await until(page, "the long name", () => document.getElementById("where").title.includes("very long"));
    assert.ok(await page.evaluate(() => document.getElementById("where").textContent.includes("Checkout")), "the local pill shows the session name's first word");
    assert.ok(await page.evaluate(() => { const w = document.getElementById("where").getBoundingClientRect(); return w.right <= document.querySelector(".top").getBoundingClientRect().right + 0.5; }), "the pill stays inside the header");

    // Someone joined: the pill says so (dot plus the words).
    lv.push("collaboration", { participants: [{ id: "a", label: "Claude" }], owner: { label: "You" }, active: null, guests: [{ label: "Sam · Claude Code", role: "drive" }] });
    await until(page, "the live pill", () => document.getElementById("where").textContent === "Live session");
    assert.ok(await page.evaluate(() => { const w = document.getElementById("where"); return w.scrollWidth <= w.clientWidth; }), "at 320px the live pill is whole");
    assert.ok(await page.evaluate(() => document.querySelector(".top").scrollWidth <= document.querySelector(".top").clientWidth), "the header does not overflow at 320px");
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.evaluate(() => document.querySelector("#where i")?.getAttribute("aria-hidden")), "true", "the dot is decoration");
    assert.equal(await page.evaluate(() => document.getElementById("collaboration").textContent), "1 connected · You has control");
    assert.equal((await view()).avatars.length, 5, "a guest already on the board is not counted twice");

    // Paused by a person: Resume, and a real click asks to resume.
    lv.push("pause", { paused: true, can: true, by: "Sam" });
    await until(page, "paused", () => document.getElementById("pause-btn").textContent === "Resume");
    assert.equal(await page.evaluate(() => document.getElementById("pause-text").textContent), "Paused by Sam");
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("pause")).boxShadow.includes("inset")), true, "the warn edge");
    await page.click("#pause-btn");
    for (let i = 0; i < 40 && !lv.posts.some((p) => p.route === "pause"); i++) await page.waitForTimeout(50);
    assert.deepEqual(lv.posts.find((p) => p.route === "pause")?.body, { paused: false });

    // A join request: a card with Allow and Deny; a synthetic click sends nothing, a real one does.
    lv.push("join", [{ id: "r1", name: "Sam", app: "Claude Code", role: "drive", state: "pending" }]);
    await until(page, "the join card", () => !!document.querySelector("#joins .join"));
    assert.equal(await page.evaluate(() => document.querySelector("#joins .join strong").textContent), "Sam (Claude Code) wants to join (can drive)");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#joins .join button")].map((b) => b.textContent)), ["Allow", "Deny"]);
    assert.equal(await page.evaluate(() => document.querySelector("#joins").parentElement.firstElementChild.id), "joins", "requests first");
    await inPage(page, () => document.querySelector("#joins .join .primary").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await page.waitForTimeout(300);
    assert.equal(lv.posts.filter((p) => p.route === "approve").length, 0, "a synthetic click allows nothing");
    await page.click("#joins .join .primary");
    for (let i = 0; i < 40 && !lv.posts.some((p) => p.route === "approve"); i++) await page.waitForTimeout(50);
    assert.deepEqual(lv.posts.find((p) => p.route === "approve")?.body, { id: "r1", allow: true });

    // Folding: Activity open, the rest folded; a click opens Session and is remembered.
    const fold = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("section.sec")].map((s) => [s.dataset.key, { expanded: s.querySelector(".disclose").getAttribute("aria-expanded"), hidden: s.querySelector(".body").hidden }])));
    let f = await fold();
    assert.deepEqual(f.activity, { expanded: "true", hidden: false });
    assert.deepEqual(f.session, { expanded: "false", hidden: true });
    assert.ok(await page.evaluate(() => document.getElementById("people").children.length > 0), "folded content stays in the page");
    await page.click("#session .disclose");
    f = await fold();
    assert.deepEqual(f.session, { expanded: "true", hidden: false });
    for (let i = 0; i < 40 && !(await inPage(page, () => localStorage.getItem("__store"))); i++) await page.waitForTimeout(50);
    assert.deepEqual(JSON.parse(await inPage(page, () => localStorage.getItem("__store"))), { "pb-panel": { collapsed: ["dev", "hosts", "details", "secrets"] } });
    // Keyboard: a disclosure takes focus and toggles with Enter.
    await page.focus("#sec-details .disclose");
    await page.keyboard.press("Enter");
    assert.deepEqual((await fold()).details, { expanded: "true", hidden: false });
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "visible focus");

    assert.equal(await inPage(page, () => window.__intervals), 0, "no interval while not recording");
    assert.deepEqual(errors, []);

    // Reopened with Activity folded: as left.
    await inPage(page, () => localStorage.setItem("__store", JSON.stringify({ "pb-panel": { collapsed: ["activity", "bogus"] } })));
    await page.reload();
    await until(page, "the stored folding", () => document.querySelector("#sec-activity .disclose").getAttribute("aria-expanded") === "false");
    f = await fold();
    assert.deepEqual(f.activity, { expanded: "false", hidden: true });
    assert.deepEqual(f.session, { expanded: "true", hidden: false });
    assert.deepEqual(f.secrets, { expanded: "true", hidden: false });
    assert.deepEqual(errors, []);
    await page.close();

    // Without the extension's API (a plain page): defaults, no error.
    const plain = await openPanel(browser);
    await plain.page.waitForTimeout(300);
    assert.deepEqual(plain.errors, []);
    assert.ok(await plain.page.evaluate((ids) => ids.every((id) => document.getElementById(id)), IDS));
    f = await plain.page.evaluate(() => Object.fromEntries([...document.querySelectorAll("section.sec")].map((s) => [s.dataset.key, s.querySelector(".body").hidden])));
    assert.deepEqual(f, { session: true, dev: true, hosts: true, activity: false, details: true, secrets: true });
    assert.equal(await plain.page.evaluate(() => document.getElementById("driver-text").textContent), "Waiting for PairBrowse");
    await plain.page.close();
  } finally {
    lv.close();
    await browser.close();
  }
});

test("Share makes an invite from the panel by keyboard, and the Checklist reads the goal log at most every 5 s", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  const lv = await fakeLiveView();
  const shots = process.env.PAIRBROWSE_TEST_SHOTS;
  try {
    const { page, errors } = await openPanel(browser, { base: lv.base });
    await until(page, "the stream", () => document.body.dataset.s === "live");
    for (let i = 0; i < 50 && !lv.streams.size; i++) await page.waitForTimeout(50);
    lv.push("session", { name: "Checkout test", where: "Local", temporary: false });
    lv.push("board", { people: [PEOPLE[0]], messages: [] });
    const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("name") || document.activeElement?.tagName);

    // Keyboard: Tab to Share, Enter opens the card with focus on the first choice.
    await page.evaluate(() => document.body.focus());
    for (let i = 0; i < 10 && (await active()) !== "share-btn"; i++) await page.keyboard.press("Tab");
    assert.equal(await active(), "share-btn", "Share is reachable with Tab");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), false);
    assert.equal(await page.getAttribute("#share-btn", "aria-expanded"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.value), "code", "focus on the first choice");
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "visible focus on the radio");
    assert.equal(await page.evaluate(() => document.getElementById("share-result").hidden), true, "nothing more until a result");

    // A synthetic click makes nothing; the first real Make asks for a first name.
    await inPage(page, () => document.getElementById("share-make").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await page.waitForTimeout(200);
    assert.equal(lv.posts.filter((p) => p.route === "invite").length, 0, "a synthetic click invites nobody");
    await page.click("#share-make");
    await until(page, "the name field", () => !document.getElementById("share-name-row").hidden);
    assert.equal(await active(), "share-name", "the name field takes focus");
    assert.match(await page.evaluate(() => document.getElementById("share-msg").textContent), /^Not yet: /, "the helper's own words");
    await page.keyboard.type("Bob");
    await page.click("#share-make");
    await until(page, "the code", () => document.getElementById("share-code").value === "pb-join:FAKE");
    assert.deepEqual(lv.posts.filter((p) => p.route === "invite").map((p) => p.body), [{ share: "code" }, { share: "code", name: "Bob" }]);
    assert.equal(await page.evaluate(() => document.getElementById("share-code").readOnly), true);
    assert.match(await page.evaluate(() => document.getElementById("share-rights").textContent), /Shared browser: they can drive\. The person pastes it/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("share-code")).fontFamily.includes("monospace")), true, "the code in mono");
    if (shots) await page.screenshot({ path: join(shots, "panel-share-card.png") });
    await page.click("#share-copy");
    for (let i = 0; i < 40 && (await inPage(page, () => window.__copied)) !== "pb-join:FAKE"; i++) await page.waitForTimeout(50);
    assert.equal(await inPage(page, () => window.__copied), "pb-join:FAKE", "the clipboard got the code");
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
    await page.mouse.click(180, 700);
    assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), true, "outside click closes");
    await page.click("#share-btn");
    await page.click("#share-btn");
    assert.equal(await page.evaluate(() => document.getElementById("share-card").hidden), true, "the button closes it again");

    // Checklist: folded, nothing read; opened, one read, rows in glyph and words.
    lv.push("activity", [{ t: Date.now(), text: "Filled **Name**", who: "Claude", tab: "Details" }]);
    await page.waitForTimeout(300);
    assert.equal(lv.counts.journal, 0, "nothing read while folded");
    assert.equal(await page.getAttribute("#agent-more", "aria-expanded"), "false");
    await page.click("#agent-more");
    await until(page, "the checklist", () => document.querySelectorAll("#checklist-items li[data-state]").length === 4);
    assert.equal(lv.counts.journal, 1, "read once when opened");
    assert.equal(await page.getAttribute("#agent-more", "aria-expanded"), "true");
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
    assert.equal(lv.counts.journal, 2, "a burst is one read");
    // Folded: no read, no pending timer.
    await page.click("#agent-more");
    lv.push("activity", [{ t: Date.now(), text: "Act 9", who: "Claude", tab: "Details" }]);
    await page.waitForTimeout(6000);
    assert.equal(lv.counts.journal, 2, "nothing while folded");
    assert.equal(await page.evaluate(() => document.getElementById("checklist").hidden), true);
    assert.deepEqual(errors, []);
  } finally {
    lv.close();
    await browser.close();
  }
});

test("reduced motion: no pulse, no card drop, the chevron turns at once", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openPanel(browser, { reducedMotion: "reduce" });
    const s = await page.evaluate(() => ({
      pulse: getComputedStyle(document.querySelector(".turn i")).animationName,
      chevron: getComputedStyle(document.querySelector(".disclose"), "::before").transitionDuration,
    }));
    assert.equal(s.pulse, "none");
    assert.equal(s.chevron, "0.001s");
    assert.deepEqual(errors, []);
    const moving = await (await openPanel(browser)).page.evaluate(() => getComputedStyle(document.querySelector(".turn i")).animationName);
    assert.equal(moving, "pulse", "the pulse is there when motion is allowed");
  } finally {
    await browser.close();
  }
});
