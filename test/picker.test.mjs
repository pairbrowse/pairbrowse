// The session picker (ui/picker/: index.html, picker.css, picker.js): the browser's first tab when nobody chose a
// session. The markup keeps every id, text and the logo the helper and the integration tests
// rely on, the script keeps its one timer; with the runtime, the page is rendered as the
// extension serves it over a fake chrome.storage and a fake sessions.json, and checked for its
// rows, the "More sessions" disclosure, the join form and the address question, by keyboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ui = join(root, "ui");
const read = (name) => readFileSync(join(ui, name), "utf8");
const html = read("picker/index.html");
const js = read("picker/picker.js");
const css = read("picker/picker.css");
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript", svg: "image/svg+xml" };
const count = (text, word) => text.split(word).length - 1;

const IDS = ["sub", "choices", "sessions", "more", "more-btn", "more-label", "more-body", "filter", "more-list", "none",
  "fresh", "join", "join-form", "code", "join-name", "host-ask", "msg"];

test("the picker's markup keeps every id once, its texts and the sheet before its own", () => {
  for (const id of IDS) assert.equal(count(html, `id="${id}"`), 1, `#${id}`);
  for (const text of ["<title>Choose a session</title>", "Which session?", "Continue where you left off",
    "More sessions", "Find a session", "No session by that name.", "Start a fresh session", "Join a shared session", "pb-join:...",
    "Your name (the host sees it)", ">Join</button>", '<body data-s="connecting">', 'aria-controls="more-body"', 'aria-expanded="false"']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<p class="brand">PairBrowse<\/p>\s*<h1 id="title">Which session\?<\/h1>/, "the wordmark over the question");
  // The waiting line is the helper's to give (sessions.json picking): the page as served claims no wait.
  assert.match(html, /<p class="sub" id="sub"><\/p>/, "no wait claimed before the helper answers");
  assert.doesNotMatch(html, /Your agent waits/);
  assert.match(html, /class="host-ask card m-fold" id="host-ask" role="group" aria-label="This code's address" hidden/);
  const a = html.indexOf('<link rel="stylesheet" href="../tokens.css">'), b = html.indexOf('<link rel="stylesheet" href="picker.css">');
  assert.ok(a >= 0 && b > a, "tokens.css before picker.css");
});

test("the logo is untouched: the same img line and the same file", () => {
  assert.ok(html.includes('<img class="logo" src="../logo.svg" alt="" width="56" height="56">'));
  assert.equal(createHash("sha256").update(readFileSync(join(ui, "logo.svg"))).digest("hex"), "415a3f8e100338210d7ffc070dd1d7ced24297bb682af9a4153a9f49d1bffd8a");
});

test("the picker script keeps its one timer and its words", () => {
  assert.equal(count(js, "setInterval("), 1, "one setInterval");
  assert.equal(count(js, "setTimeout("), 0);
  assert.equal(count(js, "requestAnimationFrame("), 0);
  assert.equal(count(js, "Observer"), 0);
  for (const text of ['"Allow once"', '"Always allow"', '"Cancel"', '"A join code starts with pb-join:"', "not a PairBrowse address. Join through it?",
    '"Your agent waits until you pick one."', "state.picking ? WAITS : SWITCH", 'noAgentLine("Your sessions")']) {
    assert.ok(js.includes(text), text);
  }
  assert.deepEqual([...js.matchAll(/fetch\(base \+ "([a-z.]+)"/g)].map((m) => m[1]).sort(), ["joinhost", "pick", "sessions.json"], "no new route");
});

test("the picker's sheet: tokens only, no own tokens, no blur, no keyframes", () => {
  assert.doesNotMatch(css, /:root/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "no literal hex");
  assert.doesNotMatch(css, /backdrop-filter|@keyframes|gradient\(/);
  assert.doesNotMatch(css, /font(-size)?:[^;]*\b1[123]px/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \* \{ transition: none !important; \} \}/);
  assert.match(css, /\.host-ask\.card \{[^}]*inset 3px 0 0 var\(--warn\)/, "the address question's warn edge");
});

// The helper's picker data: five sessions, most recently used first.
const STATE = {
  picking: true,
  sessions: [
    { name: "work", tabs: 3, sites: ["shop.example", "docs.example"], current: true,
      live: [{ who: "Sam", app: "Claude Code", kind: "guest" }],
      people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Sam", app: "Claude Code", kind: "guest" }] },
    { name: "shop", tabs: 1, sites: ["shop.example"],
      people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Claude", app: "Claude Code", kind: "agent" }, { who: "Alice", computer: "Linux", kind: "guest" }] },
    { name: "default", tabs: 0, sites: [], people: [] },
    { name: "travel", tabs: 2, sites: ["trips.example"], people: [] },
    { name: "research", tabs: 5, sites: ["papers.example"], people: [] },
  ],
};
const fakeChrome = `window.chrome = { storage: { session: { get: async () => ({ view: "http://pairbrowse.test/v/" }) }, onChanged: { addListener() {} } } };`;

// The picker's files served as the extension serves them, the extension's API before its script,
// and the live view's routes answered here (pick: the address question for any join).
async function openPicker(browser, { reducedMotion = "no-preference" } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, reducedMotion });
  const errors = [];
  const picks = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("http://pairbrowse.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "v/sessions.json") return route.fulfill({ contentType: "application/json", body: JSON.stringify(STATE) });
    if (name === "v/pick") { picks.push(JSON.parse(route.request().postData() || "{}")); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: true, hostAsk: { id: "a1", host: "share.example" } }) }); }
    if (name === "fake-chrome.js") return route.fulfill({ contentType: TYPES.js, body: fakeChrome });
    let body = readFileSync(join(ui, name));
    if (name === "picker/index.html") body = String(body).replace('<script type="module" src="picker.js">', '<script src="../fake-chrome.js"></script><script type="module" src="picker.js">');
    return route.fulfill({ contentType: TYPES[name.split(".").pop()], body });
  });
  await page.goto("http://pairbrowse.test/picker/index.html");
  for (let i = 0; i < 100 && (await page.evaluate(() => document.body.dataset.s)) !== "ready"; i++) await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => document.body.dataset.s), "ready", "the picker is ready");
  return { page, errors, picks };
}

const sidebar = (() => {
  const hex = read("tokens.css").match(/--sidebar:\s*#([0-9a-fA-F]{6})/)[1];
  return `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
})();

test("the picker over five sessions: three rows with avatars, the disclosure, the join form and the address question, by keyboard", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const { page, errors, picks } = await openPicker(browser);
    const rows = await page.evaluate(() => [...document.querySelectorAll("#sessions > li")].map((li) => {
      const a = li.querySelector(".choice > .avatar");
      return {
        name: li.querySelector(".name")?.textContent, meta: li.querySelector("small")?.textContent,
        avatar: a && { role: a.getAttribute("role"), label: a.getAttribute("aria-label"), text: a.textContent, plain: a.classList.contains("plain"), size: a.getBoundingClientRect().width },
        badges: [...li.querySelectorAll("strong em")].map((e) => e.textContent), live: li.querySelector("em.live")?.dataset.live,
        chips: [...li.querySelectorAll(".chip")].map((c) => c.title),
      };
    }));
    assert.equal(rows.length, 3, "three rows at once");
    assert.deepEqual(rows.map((r) => r.name), ["work", "shop", "Default"]);
    for (const r of rows) { assert.equal(r.avatar?.role, "img", `${r.name}: an avatar`); assert.equal(r.avatar.size, 24); assert.ok(r.meta); }
    assert.deepEqual(rows[0].badges, ["Last used", "Live · 1 other"]);
    assert.equal(rows[0].live, "true");
    assert.equal(rows[0].meta, "3 tabs · shop.example, docs.example");
    assert.deepEqual({ label: rows[0].avatar.label, text: rows[0].avatar.text, plain: rows[0].avatar.plain }, { label: "Sam", text: "S", plain: false }, "who is in it now");
    assert.match(rows[0].chips[0], /in this session now$/);
    assert.equal(rows[0].chips.length, 2, "Sam once, live");
    assert.deepEqual({ label: rows[1].avatar.label, plain: rows[1].avatar.plain }, { label: "You", plain: false }, "who used it last");
    assert.deepEqual({ label: rows[2].avatar.label, text: rows[2].avatar.text, plain: rows[2].avatar.plain }, { label: "Default", text: "D", plain: true }, "nobody used it: its own initial");
    assert.equal(rows[2].meta, "No saved tabs");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("em.live")).boxShadow), "none", "no halo");
    assert.deepEqual(await page.evaluate(() => ({ hidden: document.getElementById("more").hidden, label: document.getElementById("more-label").textContent })), { hidden: false, label: "More sessions (2)" });
    const main = await page.evaluate(() => { const r = document.querySelector("main").getBoundingClientRect(); return { bg: getComputedStyle(document.querySelector("main")).backgroundColor, width: r.width, logo: document.querySelector(".logo").getBoundingClientRect().width }; });
    assert.equal(main.bg, sidebar, "the card is the sheet's --sidebar");
    assert.ok(main.width <= 480, `the card is at most 480 px (${main.width})`);
    assert.equal(main.logo, 56);

    // Keyboard: the rows first, in order.
    const focused = () => page.evaluate(() => { const a = document.activeElement; return a?.id || a?.closest("li")?.dataset.name || a?.tagName; });
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "work", "Tab lands on the first row");
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "shop");
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "default");
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "more-btn");
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "solid", "a visible focus ring");
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => ({ expanded: document.getElementById("more-btn").getAttribute("aria-expanded"), label: document.getElementById("more-label").textContent, top: document.getElementById("sessions").hidden })),
      { expanded: "true", label: "Fewer sessions", top: true });
    assert.equal(await focused(), "filter");
    await page.keyboard.type("sho");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#more-list > li")].filter((li) => !li.hidden).map((li) => li.dataset.name)), ["shop"]);
    await page.keyboard.type("zz");
    assert.equal(await page.evaluate(() => document.getElementById("none").hidden), false, "No session by that name.");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    // On to the join row: Enter opens it and the code field takes the focus.
    for (let i = 0; i < 12 && (await focused()) !== "SUMMARY"; i++) await page.keyboard.press("Tab");
    assert.equal(await focused(), "SUMMARY", "the join row by keyboard");
    await page.keyboard.press("Enter");
    for (let i = 0; i < 40 && (await focused()) !== "code"; i++) await page.waitForTimeout(25);
    assert.equal(await focused(), "code", "focus in the code field");
    await page.keyboard.type("x");
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => ({ text: document.getElementById("msg").textContent, kind: document.getElementById("msg").dataset.kind })), { text: "A join code starts with pb-join:", kind: "error" });
    assert.equal(picks.length, 0, "nothing sent for a bad code");

    // A code that leads elsewhere: the address question as a card, Allow once focused.
    await page.fill("#code", "pb-join:https://share.example/abc");
    await page.click("#join-form .primary");
    for (let i = 0; i < 60 && (await page.evaluate(() => document.getElementById("host-ask").hidden)); i++) await page.waitForTimeout(50);
    const ask = await page.evaluate(() => {
      const box = document.getElementById("host-ask"), s = getComputedStyle(box);
      return { shown: !box.hidden, text: box.querySelector("strong").textContent, buttons: [...box.querySelectorAll("button")].map((b) => `${b.textContent}:${b.className}`), focus: document.activeElement.textContent, shadow: s.boxShadow };
    });
    assert.deepEqual(picks, [{ action: "join", code: "pb-join:https://share.example/abc", joinName: "" }]);
    assert.equal(ask.shown, true);
    assert.equal(ask.text, "This code leads to share.example, not a PairBrowse address. Join through it?");
    assert.deepEqual(ask.buttons, ["Allow once:primary", "Always allow:secondary", "Cancel:secondary"]);
    assert.equal(ask.focus, "Allow once");
    assert.match(ask.shadow, /rgb\(244, 180, 93\)/, "the warn edge");
    assert.deepEqual(errors, []);
    await page.close();

    // Reduced motion: no transition runs.
    const calm = await openPicker(browser, { reducedMotion: "reduce" });
    assert.equal(await calm.page.evaluate(() => getComputedStyle(document.querySelector(".choice")).transitionDuration), "0s");
    assert.deepEqual(calm.errors, []);
  } finally {
    await browser.close();
  }
});
