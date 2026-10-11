import { test } from "node:test";
import assert from "node:assert/strict";
import { hostOk, originOk, keyOk, addressToUrl } from "../scripts/liveview.mjs";
import { navigationProblem } from "../scripts/policy.mjs";

test("live view answers only to loopback addresses (any port, for SSH tunnels)", () => {
  assert.equal(hostOk("127.0.0.1:4000"), true);
  assert.equal(hostOk("localhost:5123"), true);
  assert.equal(hostOk("[::1]:4000"), true);
  assert.equal(hostOk("evil.example:4000"), false, "DNS rebinding");
  assert.equal(hostOk("127.0.0.1.evil.example:4000"), false);
  assert.equal(hostOk("localhost.evil.example"), false);
  assert.equal(hostOk(undefined), false);
});

test("input from other websites is refused", () => {
  assert.equal(originOk(undefined), true);
  assert.equal(originOk("http://127.0.0.1:4000"), true);
  assert.equal(originOk("http://localhost:5123"), true);
  assert.equal(originOk("https://evil.example"), false);
  assert.equal(originOk("http://localhost.evil.example"), false);
  assert.equal(originOk("null"), false);
});

test("the key must match exactly", () => {
  const key = "a".repeat(43);
  assert.equal(keyOk(key, key), true);
  assert.equal(keyOk(key.slice(1), key), false);
  assert.equal(keyOk("b".repeat(43), key), false);
  assert.equal(keyOk(undefined, key), false);
});

test("the address bar turns what you type into a web address or a search", () => {
  assert.equal(addressToUrl("google.com"), "https://google.com");
  assert.equal(addressToUrl("example.com:8443/flow"), "https://example.com:8443/flow");
  assert.equal(addressToUrl("localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(addressToUrl("https://a.example/b"), "https://a.example/b");
  assert.equal(addressToUrl("how to cook"), "https://www.google.com/search?q=how%20to%20cook");
  assert.equal(addressToUrl("  "), null);
});

test("the address bar can't open non-web URLs", () => {
  for (const t of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x"]) {
    assert.ok(navigationProblem(addressToUrl(t)), t);
  }
});

test("the side panel is allowed by its real origin, never by a null one", async () => {
  const { extensionOrigin } = await import("../scripts/browser.mjs");
  assert.equal(extensionOrigin("chrome-extension://jofgidmeddealedcllcjaclhacednkod/background.js"), "chrome-extension://jofgidmeddealedcllcjaclhacednkod");
  assert.equal(originOk("null"), false, "sandboxed frames and data: pages send Origin: null");
});

// ---- the live view server, with fake tabs (no browser) ----
import http from "node:http";
import { EventEmitter } from "node:events";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";

// Tabs whose CDP sessions count what they're asked, so leaks show.
function fakeTabs(n = 1) {
  const sessions = [];
  const ctx = { pages: () => pages, newPage: async () => { throw new Error("no new tabs here"); } };
  const pages = Array.from({ length: n }, (_, i) => Object.assign(new EventEmitter(), {
    url: () => `about:blank#${i}`, title: async () => `Tab ${i}`, context: () => ctx, bringToFront: async () => {}, evaluate: async () => null,
  }));
  ctx.newCDPSession = async () => {
    const cdp = Object.assign(new EventEmitter(), { calls: [], detached: false });
    cdp.send = async (method) => { cdp.calls.push(method); await new Promise((r) => setTimeout(r, 5)); return { data: "" }; };
    cdp.detach = async () => { cdp.detached = true; };
    sessions.push(cdp);
    return cdp;
  };
  return { ctx, pages, sessions };
}

function request(port, method, path, { body, host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// An event stream that stays open until close(); resolves once the server answered.
function openStream(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => { res.resume(); resolve({ close: () => req.destroy() }); });
    req.on("error", () => {});
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("every route needs its right; routes that aren't listed are refused", async () => {
  const invites = createInvites();
  const profile = { get: () => ({ details: [], secrets: [] }) };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, profile });
  const key = view.url.split("/").at(-2);
  try {
    const w = invites.create({ role: "watch", label: "W" });
    const d = invites.create({ role: "drive", label: "D" });
    for (const k of [w.key, d.key]) {
      assert.equal((await request(view.port, "GET", `/${k}/joins.json`)).status, 403, "join requests are the owner's");
      assert.equal((await request(view.port, "POST", `/${k}/approve`, { body: { id: "r1", allow: true } })).status, 403);
      assert.equal((await request(view.port, "GET", `/${k}/journal.json`)).status, 403, "the goal log is the owner's");
      assert.equal((await request(view.port, "POST", `/${k}/invite`, { body: { share: "code" } })).status, 403, "inviting is the owner's");
    }
    assert.equal((await request(view.port, "GET", `/${key}/journal.json`)).status, 404, "no journal given");
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: { share: "code" } })).status, 404, "no makeInvite given");
    assert.equal((await request(view.port, "GET", `/${key}/invite`)).status, 404, "GET invite isn't a route");
    for (const [method, path] of [["GET", "nope"], ["DELETE", ""], ["GET", "input"], ["PUT", "profile"], ["GET", "approve"]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`)).status, 404, `${method} /${path}`);
    }
    assert.equal((await request(view.port, "POST", `/${key}/approve`, { body: { id: "r1", allow: true } })).status, 404, "no such request");
  } finally { view.close(); }
});

test("the timeline route serves the owner the goal log and nobody else", async () => {
  const invites = createInvites();
  const run = { name: "r", status: "in progress", done: ["a.example <https://a.example/>: Typed into Email"], yourTurn: [], left: ["VAT number"], updatedAt: "2026-10-11T10:00:00.000Z" };
  let give = run;
  let calls = 0;
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, journal: () => { calls++; return give; } });
  const key = view.url.split("/").at(-2);
  try {
    const r = await request(view.port, "GET", `/${key}/journal.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^application\/json/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(JSON.parse(r.text), run);
    for (const role of ["watch", "drive"]) {
      const i = invites.create({ role, label: role });
      assert.equal((await request(view.port, "GET", `/${i.key}/journal.json`)).status, 403, role);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    assert.notEqual((await request(view.guestPort, "GET", `/${c.key}/journal.json`)).status, 200, "the join-code port never serves it");
    assert.notEqual((await request(view.guestPort, "GET", `/${key}/journal.json`)).status, 200, "not even with the owner's key");
    assert.equal(calls, 1, "read only when the owner asks");
    give = null;
    const none = await request(view.port, "GET", `/${key}/journal.json`);
    assert.equal(none.status, 200);
    assert.equal(none.text, "null");
    const state = JSON.parse((await request(view.port, "GET", `/${key}/state.json`)).text);
    assert.equal("journal" in state, false, "state.json stays without the goal log");
  } finally { view.close(); }
});

test("the invite route makes the owner's invite through the helper's own path and never shows the key elsewhere", async () => {
  const invites = createInvites();
  const SECRET = "pb-join:FAKEKEY0123456789abcdef";
  const calls = [];
  let answer = { ok: true, id: "abcd1234", label: "Guest", role: "drive", share: "code", mode: "shared", expiresAt: 1, code: SECRET, rights: "Shared browser.", hint: "The person pastes it." };
  const logs = [];
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, log: (l) => logs.push(l), makeInvite: async (op) => { calls.push(op); return answer; } });
  const key = view.url.split("/").at(-2);
  const events = [];
  const stream = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: view.port, path: `/${key}/events?panel=1` }, (res) => { res.on("data", (d) => events.push(String(d))); resolve({ close: () => req.destroy() }); });
    req.on("error", () => {});
  });
  try {
    const r = await request(view.port, "POST", `/${key}/invite`, { body: { share: "code", name: "Bob", extra: "dropped" } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), answer, "the helper's answer, as it is");
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["hours", "label", "name", "role", "share"], "only the invite's own fields reach the helper");
    assert.equal(calls[0].share, "code"); assert.equal(calls[0].name, "Bob");
    for (const role of ["watch", "drive"]) {
      const i = invites.create({ role, label: role });
      assert.equal((await request(view.port, "POST", `/${i.key}/invite`, { body: { share: "code" } })).status, 403, role);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    assert.notEqual((await request(view.guestPort, "POST", `/${c.key}/invite`, { body: { share: "code" } })).status, 200, "the join-code port never serves it");
    assert.notEqual((await request(view.guestPort, "POST", `/${key}/invite`, { body: { share: "code" } })).status, 200, "not even with the owner's key");
    assert.equal(calls.length, 1, "refused requests never reach the helper");
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: [] })).status, 409, "a body that isn't an object");
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: null })).status, 409);
    answer = { error: "Not yet: ask the user what name the people they invite should see.", needName: true };
    const no = await request(view.port, "POST", `/${key}/invite`, { body: { share: "code" } });
    assert.equal(no.status, 409);
    assert.equal(JSON.parse(no.text).needName, true);
    const state = await request(view.port, "GET", `/${key}/state.json`);
    const parsed = JSON.parse(state.text);
    for (const k of ["invite", "code", "link"]) assert.equal(k in parsed, false, k);
    assert.equal(state.text.includes(SECRET), false);
    await wait(100);
    assert.ok(events.join("").length > 0, "the stream was open");
    assert.equal(events.join("").includes(SECRET), false, "never in the event stream");
    assert.equal(logs.some((l) => String(l).includes(SECRET)), false, "never in the log");
  } finally { stream.close(); view.close(); }
});

test("the viewer runs only its own files, served from a fixed list behind the key", async () => {
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites });
  const key = view.url.split("/").at(-2);
  try {
    const page = await request(view.port, "GET", `/${key}/`);
    const csp = page.headers["content-security-policy"];
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(page.text, /<script>|<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i, "no inline code or styles");
    for (const name of ["liveview.js", "liveview.css", "tokens.css", "common.js"]) {
      const r = await request(view.port, "GET", `/${key}/assets/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers["content-type"], name.endsWith(".css") ? /^text\/css/ : /^text\/javascript/);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    const w = invites.create({ role: "watch", label: "W" });
    assert.equal((await request(view.port, "GET", `/${w.key}/assets/liveview.js`)).status, 200, "an invite link loads the page's files too");
    for (const bad of ["assets/liveview.mjs", "assets/../liveview.mjs", "assets/%2e%2e/liveview.mjs", "assets/", "assets", "assets/common.js/x", "assets/tokens.css/x", "assets/constructor", "assets/__proto__"]) {
      assert.equal((await request(view.port, "GET", `/${key}/${bad}`)).status, 404, bad);
    }
    assert.equal((await request(view.port, "GET", `/${"0".repeat(43)}/assets/liveview.js`)).status, 404, "wrong key");
    assert.equal((await request(view.port, "GET", `/${key}/assets/liveview.js`, { host: "evil.example" })).status, 403, "DNS rebinding");
    const bare = await request(view.port, "GET", `/${key}`);
    assert.equal(bare.status, 308, "the page's files load relative to /<key>/");
    assert.equal(bare.headers.location, `/${key}/`);
    // The joiner port (the sharing tunnel's) never serves the page or its files.
    const c = invites.create({ role: "watch", label: "C", share: "code" });
    for (const path of [`/${c.key}/assets/liveview.js`, `/${c.key}/`]) assert.notEqual((await request(view.guestPort, "GET", path)).status, 200, path);
  } finally { view.close(); }
});

test("a failing browser doesn't crash the follow tick", async () => {
  const logs = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  let calls = 0;
  const view = await startLiveView({ getContext: async () => { if (++calls > 1) throw new Error("browser gone"); return { pages: () => [] }; }, currentUrl: async () => "about:blank", log: (...a) => logs.push(a.join(" ")) });
  const key = view.url.split("/").at(-2);
  // A viewer (its stream gets nothing: the browser is gone), so the tick runs.
  const req = http.get({ host: "127.0.0.1", port: view.port, path: `/${key}/events` }, (res) => res.resume());
  req.on("error", () => {});
  try {
    await wait(1800); // one tick
    assert.deepEqual(unhandled, []);
    assert.ok(logs.some((l) => /browser gone/.test(l)), logs.join("\n"));
  } finally {
    req.destroy();
    view.close();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("showing a tab: one CDP session at a time, each tab wired once, all released on close", async () => {
  const { ctx, pages, sessions } = fakeTabs(2);
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => pages[0].url() });
  const key = view.url.split("/").at(-2);
  const tab = (i) => request(view.port, "POST", `/${key}/tab`, { body: { i } });
  const stream = await Promise.all([openStream(view.port, `/${key}/events`), tab(0), tab(0)]).then(([s]) => s);
  try {
    assert.equal(sessions.length, 1, "the follow and two clicks on the same tab share one session");
    await tab(1); await tab(0); await tab(1);
    assert.equal(sessions.filter((s) => !s.detached).length, 1, "every tab switched away from is released");
    for (const p of pages) assert.equal(p.listenerCount("close"), 1, "close is watched once per tab");
  } finally {
    stream.close();
    view.close();
  }
  // Released as the close runs its course (later on a busy computer): wait for it, not a fixed time.
  const last = sessions.at(-1);
  for (let i = 0; i < 100 && !last.detached; i++) await wait(50);
  assert.ok(last.detached, "close releases the shown tab");
  assert.ok(last.calls.includes("Page.stopScreencast"));
  assert.ok(last.calls.includes("Emulation.clearDeviceMetricsOverride"));
});

// ---- the page's markup and script, read as files (no browser) ----
import { readFileSync } from "node:fs";
const pageFile = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
const count = (text, needle) => text.split(needle).length - 1;

test("the live view keeps every control's id once, and the workspace column's are named", () => {
  const html = pageFile("liveview.html");
  const ids = ["tabs", "newtab", "state", "back", "forward", "reload", "url", "url-input", "where", "collaboration-status", "overview-btn", "overview", "profile-btn", "fit", "turn", "joins", "drawer", "drawer-close", "details", "add-detail", "secrets", "add-secret", "profile-msg", "stage", "frame", "screen", "skeleton", "hint", "driver", "who-filter", "activity",
    "side", "side-btn", "side-collapse", "side-rail", "side-body", "side-tabs", "side-agents", "side-guests", "side-session", "timeline-btn", "drawer-tab-profile", "drawer-tab-timeline", "profile-body", "timeline-body", "journal-refresh", "journal-done", "journal-turn", "journal-left", "journal-msg", "share-btn", "share-card", "share-name", "share-make", "share-code", "share-copy", "share-msg"];
  for (const id of ids) assert.equal(count(html, `id="${id}"`), 1, id);
  for (const s of ["tabs", "agents", "guests", "session"]) {
    const tag = html.match(new RegExp(`<button[^>]*id="side-h-${s}"[^>]*>`))?.[0];
    assert.ok(tag, s);
    assert.match(tag, /aria-expanded="(true|false)"/);
    const target = tag.match(/aria-controls="([^"]+)"/)?.[1];
    assert.equal(count(html, `id="${target}"`), 1, `${s} controls an element there`);
    assert.match(html, new RegExp(`id="rail-${s}"[^>]*>[\\s\\S]*?<span class="sr">[^<]+</span>`), `rail-${s} has a name`);
  }
  const share = html.match(/<button[^>]*id="share-btn"[^>]*>/)[0];
  assert.match(share, /aria-expanded="false"/);
  assert.match(share, /aria-controls="share-card"/);
  assert.match(html, /<div class="share-card" id="share-card" role="dialog" aria-labelledby="share-title" hidden>/);
  for (const id of ["side-btn", "timeline-btn", "side-collapse", "share-btn"]) assert.match(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))[0], /aria-label="[^"]+"/, id);
  assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son[a-z]+=/i);
});

test("the live view adds no timer, observer or poll; storage keys and the journal fetch are single", () => {
  const js = pageFile("liveview.js");
  assert.equal(count(js, "setInterval("), 1, "the countdown tick only");
  assert.equal(count(js, "new ResizeObserver("), 1);
  assert.equal(count(js, "requestAnimationFrame("), 1, "the input batch only");
  for (const x of ["MutationObserver", "IntersectionObserver"]) assert.equal(count(js, x), 0, x);
  assert.equal(count(js, 'localStorage.getItem("pb-view")'), 1);
  assert.equal(count(js, 'localStorage.getItem("pb-fit")'), 1);
  assert.equal(count(js, 'fetch(base + "journal.json"'), 1);
  const css = pageFile("liveview.css");
  assert.doesNotMatch(css, /backdrop-filter|blur\(/);
  assert.deepEqual(css.match(/font-size:\s*[\d.]+px/g), ["font-size: 15px"], "type sizes come from --fs-* (the overlay heading aside)");
  assert.equal(count(css, "infinite"), 3, "pulse x2 and the skeleton's sheen, nothing new");
});

// ---- the workspace column and the Timeline, rendered (headless Patchright, the real server) ----
import { patchright } from "./live.mjs";
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME?.replace(/^~/, process.env.HOME);

test("the workspace column draws only what is seen; the Timeline reads the log on open and Refresh", { skip: !runtime }, async () => {
  const { ctx, pages } = fakeTabs(3);
  const invites = createInvites();
  let calls = 0;
  const journal = () => { calls++; return { name: "shop.example 2026-10-11 10:00", status: "in progress", done: ["Sign up <https://shop.example/signup>: Filled **Email**; Clicked **Continue**"], yourTurn: ["Enter the code"], left: ["VAT number"], updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }; };
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, journal });
  const { chromium } = patchright(runtime);
  const browser = await chromium.launch();
  const watcher = invites.create({ role: "watch", label: "Wendy" });
  const guestStream = await openStream(view.port, `/${watcher.key}/events`);
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(view.url);
    await page.waitForFunction(() => document.querySelectorAll("#side-tabs li").length === 3);
    view.setBoard({ people: [{ who: "Ada · Claude Code", kind: "agent", color: "#e9763f", status: "working", tab: "shop.example/signup", task: "Signing up" }, { who: "Bo · Codex", kind: "agent", color: "", status: "you", tab: "" }], messages: [] });
    view.setCollaboration({ participants: [{ id: "a", label: "Ada · Claude Code" }, { id: "c", label: "Cy" }], owner: null, active: null, humanUntil: 0 });
    view.setSession({ name: "client-x", where: "Local" });
    await page.waitForFunction(() => document.querySelectorAll("#side-agents li").length === 3 && /client-x/.test(document.querySelector("#side-session").textContent));
    const agents = await page.locator("#side-agents").innerText();
    assert.match(agents, /Ada/); assert.match(agents, /Claude Code/); assert.match(agents, /working/); assert.match(agents, /waiting for their person/); assert.match(agents, /Cy/);
    assert.match(await page.locator("#side-guests").innerText(), /Wendy[\s\S]*\(watching\)/);
    // Rail, remembered across a reload; a rail button opens its section with focus on it.
    await page.click("#side-collapse");
    assert.equal(await page.getAttribute("#side", "data-state"), "rail");
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("pb-view"))).sidebar, "rail");
    await page.reload();
    await page.waitForSelector('#side[data-state="rail"]');
    await page.waitForFunction(() => document.querySelector("#side-n-tabs").textContent === "3");
    await page.click("#rail-agents");
    assert.equal(await page.getAttribute("#side", "data-state"), "open");
    assert.equal(await page.getAttribute("#side-h-agents", "aria-expanded"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "side-h-agents");
    // Hidden: a new tab changes nothing inside; shown again, it is drawn at once.
    await page.click("#side-btn");
    assert.equal(await page.getAttribute("#side", "data-state"), "hidden");
    assert.equal(await page.getAttribute("#side-btn", "aria-expanded"), "false");
    pages.push(Object.assign(new EventEmitter(), { url: () => "about:blank#3", title: async () => "Tab 3", context: () => ctx, bringToFront: async () => {}, evaluate: async () => null }));
    await view.refreshTabs();
    await page.waitForFunction(() => document.querySelectorAll("#tabs .tab").length === 4);
    assert.equal(await page.evaluate(() => document.querySelector("#side-tabs").childElementCount), 3);
    await page.click("#side-btn");
    assert.equal(await page.evaluate(() => document.querySelector("#side-tabs").childElementCount), 4);
    // Folded: not redrawn on the next tabs event.
    await page.click("#side-h-tabs");
    assert.equal(await page.isHidden("#side-tabs"), true);
    await page.evaluate(() => { window.__marker = document.querySelector("#side-tabs li"); });
    await view.refreshTabs();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.querySelector("#side-tabs li") === window.__marker), true);
    // The Timeline: fetched on open and on Refresh only.
    assert.equal(calls, 0);
    await page.click("#timeline-btn");
    await page.waitForFunction(() => document.querySelectorAll("#journal-done li").length === 1);
    assert.equal(calls, 1);
    assert.equal(await page.getAttribute("#drawer-tab-timeline", "aria-selected"), "true");
    const done = await page.locator("#journal-done").innerText();
    assert.match(done, /Sign up/); assert.match(done, /Clicked Continue/);
    assert.match(await page.locator("#journal-meta").innerText(), /Saved 5 min ago/);
    await page.waitForTimeout(2500);
    assert.equal(calls, 1, "never polled");
    await page.click("#journal-refresh");
    await page.waitForFunction(() => !document.querySelector("#journal-msg").textContent);
    for (let i = 0; i < 20 && calls < 2; i++) await wait(50);
    assert.equal(calls, 2);
    await page.click("#drawer-tab-profile");
    assert.equal(await page.isVisible("#profile-body"), true);
    assert.equal(await page.isHidden("#timeline-body"), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.getAttribute("#drawer", "data-open"), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "profile-btn", "focus goes back to the button");
    // Keyboard: Tab from the column's top reaches the column button, with a visible ring.
    await page.click(".side > header h2");
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => document.activeElement?.id === "side-btn"); }
    assert.ok(reached, "Tab reaches the column button");
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
    // Share (the owner only): the button opens the card with focus on the first choice; Escape
    // closes it and gives focus back.
    assert.equal(await page.isVisible("#share-btn"), true, "the owner has Share");
    await page.click("#share-btn");
    assert.equal(await page.isVisible("#share-card"), true);
    assert.equal(await page.evaluate(() => document.activeElement.value), "code");
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#share-card"), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "share-btn");
    // A watch link keeps the column button (Cmd/Ctrl+B hides the column there too, so it must come back).
    const watchPage = await context.newPage();
    watchPage.on("pageerror", (e) => errors.push(e.message));
    await watchPage.goto(`http://127.0.0.1:${view.port}/${watcher.key}/`);
    await watchPage.waitForSelector('body[data-role="watch"]');
    assert.equal(await watchPage.evaluate(() => getComputedStyle(document.getElementById("share-btn")).display), "none", "no Share on an invite link");
    await watchPage.waitForSelector("#side-btn", { state: "visible" });
    assert.notEqual(await watchPage.evaluate(() => getComputedStyle(document.getElementById("side-btn")).display), "none");
    await watchPage.waitForSelector('#side:not([data-state="hidden"])');
    await watchPage.click(".side > header h2");
    await watchPage.keyboard.press("Control+b");
    assert.equal(await watchPage.getAttribute("#side", "data-state"), "hidden");
    await watchPage.click("#side-btn");
    assert.notEqual(await watchPage.getAttribute("#side", "data-state"), "hidden");
    await watchPage.close();
    // Reduced motion: the column's width change runs without a transition.
    const calm = await browser.newContext({ viewport: { width: 1100, height: 720 }, reducedMotion: "reduce" });
    const still = await calm.newPage();
    await still.goto(view.url);
    assert.equal(await still.evaluate(() => getComputedStyle(document.querySelector("#side")).transitionDuration), "0.001s");
    await calm.close();
    // Narrow: the open column lies over the toolbar; Escape inside it folds it to the rail.
    const narrow = await browser.newContext({ viewport: { width: 420, height: 720 } });
    const small = await narrow.newPage();
    await small.goto(view.url);
    await small.waitForSelector('#side[data-state="open"]');
    await small.focus("#side-h-tabs");
    await small.keyboard.press("Escape");
    await small.waitForSelector('#side[data-state="rail"]');
    assert.equal(await small.evaluate(() => document.activeElement.id), "side-collapse");
    await narrow.close();
    assert.deepEqual(errors, []);
  } finally {
    guestStream.close();
    await browser.close();
    view.close();
  }
});

test("ago: minutes while fresh, the date once older than an hour (a run saved yesterday never reads as today)", async () => {
  const { ago } = await import("../scripts/browser/panel/common.js");
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(ago(new Date(now - 10_000).toISOString(), now), "just now");
  assert.equal(ago(new Date(now - 5 * 60_000).toISOString(), now), "5 min ago");
  const day = new Date(now - 86_400_000);
  assert.ok(ago(day.toISOString(), now).includes(day.toLocaleDateString([], { dateStyle: "short" })));
  assert.equal(ago("not a date", now), "");
});
