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
  ctx.newCDPSession = async (page) => {
    const cdp = Object.assign(new EventEmitter(), { calls: [], detached: false, page });
    cdp.send = async (method) => { cdp.calls.push(method); await new Promise((r) => setTimeout(r, 5)); return { data: "" }; };
    cdp.detach = async () => { cdp.detached = true; };
    sessions.push(cdp);
    return cdp;
  };
  return { ctx, pages, sessions };
}

function request(port, method, path, { body, raw, host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers, ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString("utf8"), bytes }); });
    });
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
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
      assert.equal((await request(view.port, "GET", `/${k}/approvals.json`)).status, 403, "approvals are the owner's");
      assert.equal((await request(view.port, "POST", `/${k}/approve`, { body: { id: `ap-${"0".repeat(32)}`, answer: "allow" } })).status, 403, "and answering them");
      assert.equal((await request(view.port, "GET", `/${k}/journal.json`)).status, 403, "the goal log is the owner's");
      assert.equal((await request(view.port, "POST", `/${k}/invite`, { body: { share: "code" } })).status, 403, "inviting is the owner's");
      // The browser's own pages' routes: the owner's only.
      for (const [method, path, body] of [["GET", "layout.json"], ["POST", "layout", { left: "rail" }], ["GET", "tabs.json"], ["GET", "agent-tabs.json"], ["GET", "timeline.json"],
        ["GET", "timeline/0123456789ab.jpg"], ["DELETE", "timeline/0123456789ab"], ["POST", "timeline/note", { text: "x" }], ["POST", "timeline/0123456789ab/pin", { on: true }],
        ["GET", "config.json"], ["POST", "config", { browser: "chromium" }],
        ["POST", "session", { op: "rename", name: "x" }], ["POST", "session", { op: "save" }], ["GET", "outline.json"], ["POST", "timeline/0123456789ab/show", {}], ["POST", "pause", { paused: true, who: "X" }]]) {
        assert.equal((await request(view.port, method, `/${k}/${path}`, { body })).status, 403, `${method} /${path} is the owner's`);
      }
    }
    // The Tools tab's routes (the owner only): every one refused to guests, 404 with no tools given.
    const TOOL_ROUTES = [["GET", "downloads.json"], ["POST", "downloads/0123456789ab/open"], ["POST", "downloads/0123456789ab/reveal"], ["GET", "recordings.json"],
      ["POST", "recordings/0123456789ab/open"], ["POST", "recordings/0123456789ab/reveal"], ["DELETE", "recordings/0123456789ab"], ["GET", "handoffs.json"],
      ["POST", "handoffs/0123456789ab/show"], ["GET", "diagnostics.json"], ["POST", "diagnostics/report"]];
    for (const k of [w.key, d.key]) for (const [method, path] of TOOL_ROUTES) {
      assert.equal((await request(view.port, method, `/${k}/${path}`, { body: method === "POST" ? {} : undefined })).status, 403, `${method} /${path} is the owner's`);
    }
    for (const [method, path] of TOOL_ROUTES) {
      assert.equal((await request(view.port, method, `/${key}/${path}`, { body: method === "POST" ? {} : undefined })).status, 404, `no tools given: ${method} /${path}`);
    }
    for (const [method, path, body] of [["POST", "session", { op: "save" }], ["GET", "outline.json"], ["POST", "timeline/0123456789ab/show", {}]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`, { body })).status, 404, `nothing given: ${method} /${path}`);
    }
    for (const [method, path] of [["GET", "timeline.json"], ["GET", "timeline/0123456789ab.jpg"], ["DELETE", "timeline/0123456789ab"], ["POST", "timeline/note"]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`, { body: method === "POST" ? { text: "x" } : undefined })).status, 404, `no timeline given: ${method} /${path}`);
    }
    for (const [method, path] of [["GET", "config.json"], ["POST", "config"]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`, { body: method === "POST" ? { browser: "chromium" } : undefined })).status, 404, `no settings given: ${method} /${path}`);
    }
    assert.equal((await request(view.port, "GET", `/${key}/layout.json`)).status, 200);
    assert.equal((await request(view.port, "GET", `/${key}/journal.json`)).status, 404, "no journal given");
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: { share: "code" } })).status, 404, "no makeInvite given");
    assert.equal((await request(view.port, "GET", `/${key}/invite`)).status, 404, "GET invite isn't a route");
    for (const [method, path] of [["GET", "nope"], ["DELETE", ""], ["GET", "input"], ["PUT", "profile"], ["GET", "approve"]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`)).status, 404, `${method} /${path}`);
    }
    assert.equal((await request(view.port, "POST", `/${key}/approve`, { body: { id: "r1", allow: true } })).status, 404, "no such request");
    assert.equal((await request(view.port, "GET", `/${key}/approvals.json`)).status, 404, "no click approvals given: none pending");
    assert.equal((await request(view.port, "POST", `/${key}/approve`, { body: { id: `ap-${"0".repeat(32)}`, answer: "allow" } })).status, 404, "no click approvals given");
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
  // The stage toolbar on the sheet's compact sizes: 28 px controls on --r-2, the address in --fs-2.
  const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`)); assert.ok(m, sel); return m[1]; };
  for (const sel of [".nav", ".fit", ".url"]) {
    const r = rule(sel);
    assert.match(r, /height: 28px/, `${sel} is 28 px`);
    assert.doesNotMatch(r, /\b(30|32)px/, `${sel}: no 30/32 px`);
  }
  assert.match(rule(".url"), /border-radius: var\(--r-2\)/);
  assert.match(rule(".url"), /font-size: var\(--fs-2\)/);
  assert.match(rule(".mini"), /border-radius: var\(--r-2\)/);
  assert.match(rule(".toolbar"), /padding: 5px 8px/, "28 px controls in a 38 px toolbar");
  // The Workspace label on the tab labels' baseline (measured: 12 px label, 13 px tab labels): one shorthand, 7 px at the bottom.
  assert.match(rule(".side > header"), /padding: 0 6px 7px 14px/);
  assert.doesNotMatch(rule(".side > header"), /padding-bottom/, "no longhand the shorthand would override");
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

// ---- the browser's own pages: layout, page kinds, the tab strip's list, the timeline ----

// An event stream whose text is kept, until close().
function readStream(port, path) {
  return new Promise((resolve) => {
    let text = "";
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve({ text: () => text, close: () => req.destroy() }); });
    req.on("error", () => {});
  });
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));

test("layout is the owner's, validated, per session, broadcast to owner streams only", async () => {
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, layoutDefaults: { left: "rail", right: "open", strip: 88 } });
  const key = view.url.split("/").at(-2);
  view.setSession({ name: "default", where: "Local" });
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  const w = invites.create({ role: "watch", label: "W" });
  const guest = await readStream(view.port, `/${w.key}/events?panel=1`);
  try {
    let r = await request(view.port, "GET", `/${key}/layout.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { left: "rail", right: "open", strip: 88 });
    r = await request(view.port, "POST", `/${key}/layout`, { body: { left: "hidden" } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { left: "hidden", right: "open", strip: 88 }, "merged");
    for (const bad of [{ strip: 20 }, { strip: 88.5 }, { left: "big" }, []]) {
      r = await request(view.port, "POST", `/${key}/layout`, { body: bad });
      assert.equal(r.status, 409, JSON.stringify(bad));
      assert.ok(JSON.parse(r.text).error);
    }
    r = await request(view.port, "POST", `/${key}/layout`, { raw: "{" });
    assert.equal(r.status, 400, "a body that isn't JSON");
    assert.ok(JSON.parse(r.text).error);
    assert.deepEqual(view.layout(), { left: "hidden", right: "open", strip: 88 }, "a refused change changes nothing");
    await wait(50);
    const seen = eventsIn(owner.text(), "layout");
    assert.deepEqual(seen[0], { left: "rail", right: "open", strip: 88 }, "on open");
    assert.deepEqual(seen.at(-1), { left: "hidden", right: "open", strip: 88 }, "after the change");
    // The right dock's tab: relayed in the answer and its event, never kept.
    r = await request(view.port, "POST", `/${key}/layout`, { body: { right: "open", tab: "tools" } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { left: "hidden", right: "open", strip: 88, tab: "tools" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "hidden", right: "open", strip: 88 }, "layout.json never has it");
    assert.deepEqual(view.layout(), { left: "hidden", right: "open", strip: 88 });
    r = await request(view.port, "POST", `/${key}/layout`, { body: { tab: "nope" } });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /agent, page, pictures or tools/);
    r = await request(view.port, "POST", `/${key}/layout`, { body: { tab: "page" } });
    assert.equal(r.status, 200, "a tab alone changes nothing else");
    assert.deepEqual(JSON.parse(r.text), { left: "hidden", right: "open", strip: 88, tab: "page" });
    r = await request(view.port, "POST", `/${key}/layout`, { body: { left: "big", tab: "page" } });
    assert.equal(r.status, 409, "a bad layout with a good tab is still refused");
    await wait(50);
    assert.deepEqual(eventsIn(owner.text(), "layout").at(-1), { left: "hidden", right: "open", strip: 88, tab: "page" }, "the tab rides on its event");
    const late = await readStream(view.port, `/${key}/events?panel=1`);
    await wait(50);
    assert.deepEqual(eventsIn(late.text(), "layout")[0], { left: "hidden", right: "open", strip: 88 }, "never in the first event");
    late.close();
    assert.equal(eventsIn(guest.text(), "layout").length, 0, "a guest's stream never gets it");
    view.setSession({ name: "other", where: "Local" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "rail", right: "open", strip: 88 }, "another session starts from the defaults");
    view.setSession({ name: "default", where: "Local" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "hidden", right: "open", strip: 88 }, "and the first keeps its own");
    await wait(50);
    assert.equal(eventsIn(guest.text(), "layout").length, 0);
  } finally { owner.close(); guest.close(); view.close(); }
});

test("layoutDefaults given as a function is read live: a session that starts later starts from the new defaults", async () => {
  let defaults = { left: "rail", right: "open", strip: 88 };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", layoutDefaults: () => defaults });
  const key = view.url.split("/").at(-2);
  try {
    view.setSession({ name: "a", where: "Local" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "rail", right: "open", strip: 88 });
    defaults = { left: "hidden", right: "rail", strip: 120 };
    view.setSession({ name: "b", where: "Local" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "hidden", right: "rail", strip: 120 }, "the changed defaults");
    view.setSession({ name: "a", where: "Local" });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "hidden", right: "rail", strip: 120 }, "a session with no layout of its own follows them too");
    defaults = { strip: 9999 };
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/layout.json`)).text), { left: "open", right: "open", strip: 88 }, "an invalid default is the fallback");
  } finally { view.close(); }
});

test("the events stream records a page kind for the owner only", async () => {
  const invites = createInvites();
  const { ctx, sessions } = fakeTabs(1);
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", invites });
  const key = view.url.split("/").at(-2);
  try {
    const strip = await readStream(view.port, `/${key}/events?page=strip`);
    await wait(30);
    assert.deepEqual(view.pageClients(), { strip: 1 });
    assert.equal(sessions.length, 0, "a page stream starts no screencast");
    assert.equal(eventsIn(strip.text(), "frame").length, 0);
    assert.equal(eventsIn(strip.text(), "agent-tabs").length, 1, "the strip gets who holds which tab on open");
    strip.close();
    await wait(30);
    assert.deepEqual(view.pageClients(), {});
    // The timeline page and the docks: page streams too (no screencast, no frame), counted.
    const own = [];
    for (const kind of ["timeline", "left", "right"]) own.push(await readStream(view.port, `/${key}/events?page=${kind}`));
    await wait(50);
    assert.deepEqual(view.pageClients(), { timeline: 1, left: 1, right: 1 });
    assert.equal(sessions.length, 0, "none of them starts a screencast");
    for (const o of own) { assert.equal(eventsIn(o.text(), "frame").length, 0); o.close(); }
    await wait(30);
    assert.deepEqual(view.pageClients(), {});
    const nope = await readStream(view.port, `/${key}/events?page=nope&panel=1`);
    await wait(30);
    assert.deepEqual(view.pageClients(), {}, "an unknown kind is ignored");
    nope.close();
    const d = invites.create({ role: "drive", label: "D" });
    const guest = await readStream(view.port, `/${d.key}/events?page=strip`);
    for (let i = 0; i < 100 && !eventsIn(guest.text(), "tabs").length; i++) await wait(20);
    assert.deepEqual(view.pageClients(), {}, "a guest's flag counts for nothing");
    assert.ok(eventsIn(guest.text(), "tabs").length >= 1, "it is a guest's stream as before");
    assert.equal(eventsIn(guest.text(), "agent-tabs").length, 0);
    assert.equal(eventsIn(guest.text(), "layout").length, 0);
    guest.close();
  } finally { view.close(); }
});

test("tabs.json is the strip's list, masked; agent-tabs.json says who holds which", async () => {
  const invites = createInvites();
  const { ctx, pages } = fakeTabs(2);
  const frames = pages.map(() => ({}));
  pages.forEach((p, i) => { p.mainFrame = () => frames[i]; p.title = async () => `Tab ${i} hunter2`; p.isClosed = () => false; });
  const mask = (t) => t.replace(/hunter2/g, "••••");
  const view = await startLiveView({ getContext: async () => ({ ...ctx, on: () => {} }), currentUrl: async () => "about:blank#0", invites, mask,
    tabMeta: (p) => (p === pages[1] ? { agent: { label: "Ada", color: "#e9763f", until: 9, from: "x" }, person: "Bob" } : {}) });
  const key = view.url.split("/").at(-2);
  try {
    let r = await request(view.port, "GET", `/${key}/tabs.json`);
    assert.equal(r.status, 200);
    let tabs = JSON.parse(r.text);
    assert.equal(tabs.length, 2);
    for (const t of tabs) assert.match(t.id, /^[0-9a-f]{8}$/);
    assert.deepEqual(tabs.map((t) => t.title), ["Tab 0 ••••", "Tab 1 ••••"]);
    assert.deepEqual(tabs.map((t) => t.host), ["", ""]);
    assert.deepEqual(tabs.map((t) => t.active), [true, false]);
    assert.deepEqual(tabs.map((t) => t.loading), [false, false]);
    assert.deepEqual(tabs[1].agent, { label: "Ada", color: "#e9763f" }, "label and color only");
    assert.equal(tabs[1].person, "Bob");
    assert.equal(tabs[0].agent, null);
    assert.doesNotMatch(r.text, /hunter2/);
    assert.ok(!r.text.includes(key), "the key never rides in it");
    await wait(20);
    pages[1].emit("framenavigated", frames[1]);
    tabs = JSON.parse((await request(view.port, "GET", `/${key}/tabs.json`)).text);
    assert.equal(tabs[1].loading, true, "loading after a main-frame navigation");
    pages[1].emit("load");
    tabs = JSON.parse((await request(view.port, "GET", `/${key}/tabs.json`)).text);
    assert.equal(tabs[1].loading, false, "and done once it loaded");
    r = await request(view.port, "GET", `/${key}/agent-tabs.json`);
    assert.equal(r.status, 200);
    const held = JSON.parse(r.text);
    assert.deepEqual(held.map((t) => t.id), tabs.map((t) => t.id));
    assert.deepEqual(held.map((t) => t.agent), [null, { label: "Ada", color: "#e9763f" }]);
    assert.ok(!r.text.includes(key) && !/hunter2/.test(r.text));
  } finally { view.close(); }
});

test("POST tab order reaches the helper's arrange with the pages in that order; guests can't", async () => {
  const invites = createInvites();
  const { ctx, pages } = fakeTabs(3);
  pages.forEach((p) => { p.isClosed = () => false; });
  const calls = [];
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", invites, shared: { arrange: async (list) => { calls.push(list); } } });
  const key = view.url.split("/").at(-2);
  try {
    const ids = JSON.parse((await request(view.port, "GET", `/${key}/tabs.json`)).text).map((t) => t.id);
    assert.equal((await request(view.port, "POST", `/${key}/tab`, { body: { order: [...ids].reverse() } })).status, 204);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [...pages].reverse());
    await request(view.port, "POST", `/${key}/tab`, { body: { order: [ids[1], "ffffffff", ids[0]] } });
    assert.deepEqual(calls[1], [pages[1], pages[0]], "an unknown id is skipped");
    const d = invites.create({ role: "drive", label: "D" });
    assert.equal((await request(view.port, "POST", `/${d.key}/tab`, { body: { order: [] } })).status, 403, "moving tabs is the owner's");
    assert.equal(calls.length, 2);
    assert.equal((await request(view.port, "POST", `/${d.key}/tab`, { body: { i: 0 } })).status, 204, "a drive guest still switches tabs");
  } finally { view.close(); }
});

test("the timeline routes serve the owner the store and nobody else", async () => {
  const invites = createInvites();
  const card = { id: "0123456789ab", t: 1, caption: "Typed hunter2", step: null, who: "Ada", pinned: false, note: false };
  const calls = [];
  let fire = null;
  let noteCard = false;
  const timeline = {
    enabled: true,
    cards: () => [{ ...card, note: noteCard }],
    picture: (id) => (id === "0123456789ab" ? Buffer.from([0xff, 0xd8, 0xff]) : null),
    remove: async (id) => { calls.push(["remove", id]); return id === "0123456789ab"; },
    pin: async (id, on) => { calls.push(["pin", id, on]); return { ...card, pinned: on }; },
    note: async (text) => { calls.push(["note", text]); return { ...card, id: "ba9876543210", caption: text, note: true }; },
    onChange: (fn) => { fire = fn; return () => { fire = null; }; },
  };
  const mask = (t) => t.replace(/hunter2/g, "••••");
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, timeline, mask });
  const key = view.url.split("/").at(-2);
  const owner = await readStream(view.port, `/${key}/events?page=strip`);
  const d = invites.create({ role: "drive", label: "D" });
  const guest = await readStream(view.port, `/${d.key}/events`);
  try {
    let r = await request(view.port, "GET", `/${key}/timeline.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { cards: [{ ...card, caption: "Typed ••••" }] });
    r = await request(view.port, "GET", `/${key}/timeline/0123456789ab.jpg`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/jpeg");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(r.bytes, Buffer.from([0xff, 0xd8, 0xff]));
    for (const path of ["timeline/0123456789ab.jpg/x", "timeline/zz.jpg", "timeline/../index.json", "timeline/ffffffffffff.jpg", "timeline"]) {
      assert.equal((await request(view.port, "GET", `/${key}/${path}`)).status, 404, path);
    }
    assert.equal((await request(view.port, "DELETE", `/${key}/timeline/0123456789ab`)).status, 200);
    assert.deepEqual(calls.at(-1), ["remove", "0123456789ab"]);
    assert.equal((await request(view.port, "DELETE", `/${key}/timeline/0123456789ab`, { headers: { origin: "https://evil.example" } })).status, 403, "a cross-site DELETE is refused");
    assert.equal(calls.length, 1, "and reaches nothing");
    assert.equal((await request(view.port, "DELETE", `/${key}/timeline/zz`)).status, 404);
    r = await request(view.port, "POST", `/${key}/timeline/note`, { body: { text: "Check VAT" } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ["note", "Check VAT"]);
    r = await request(view.port, "POST", `/${key}/timeline/0123456789ab/pin`, { body: { on: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ["pin", "0123456789ab", true]);
    assert.equal((await request(view.port, "POST", `/${key}/timeline/0123456789ab/nope`, { body: {} })).status, 404);
    // Show: the Pictures tab shows that card; the owner's streams hear it with the card.
    const callsBeforeShow = calls.length;
    r = await request(view.port, "POST", `/${key}/timeline/0123456789ab/show`, { body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    assert.equal(calls.length, callsBeforeShow, "nothing kept or changed for it");
    assert.equal((await request(view.port, "POST", `/${key}/timeline/ffffffffffff/show`, { body: {} })).status, 404, "an unknown id");
    noteCard = true;
    r = await request(view.port, "POST", `/${key}/timeline/0123456789ab/show`, { body: {} });
    assert.equal(r.status, 409, "a note has no picture");
    assert.match(JSON.parse(r.text).error, /note/);
    noteCard = false;
    assert.equal((await request(view.port, "POST", `/${key}/timeline/0123456789ab/show`, { raw: "{" })).status, 400);
    await wait(50);
    const shown = eventsIn(owner.text(), "timeline").filter((e) => e.op === "show");
    assert.equal(shown.length, 1);
    assert.deepEqual(shown[0], { op: "show", id: "0123456789ab", card: { ...card, caption: "Typed ••••" } });
    assert.equal(eventsIn(guest.text(), "timeline").length, 0, "a guest's stream never hears it");
    const callsBefore = calls.length;
    assert.equal((await request(view.port, "POST", `/${key}/timeline/note`, { raw: "{" })).status, 400, "a note body that isn't JSON");
    assert.equal((await request(view.port, "POST", `/${key}/timeline/0123456789ab/pin`, { raw: "{" })).status, 400, "a pin body that isn't JSON");
    assert.equal(calls.length, callsBefore, "and reaches nothing");
    for (const k of [invites.create({ role: "watch", label: "W" }).key, d.key]) {
      for (const [method, path] of [["GET", "timeline.json"], ["GET", "timeline/0123456789ab.jpg"], ["DELETE", "timeline/0123456789ab"], ["POST", "timeline/note"], ["POST", "timeline/0123456789ab/pin"], ["POST", "timeline/0123456789ab/show"]]) {
        assert.equal((await request(view.port, method, `/${k}/${path}`, { body: method === "POST" ? { text: "x" } : undefined })).status, 403, `${method} /${path}`);
      }
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) for (const path of ["timeline.json", "timeline/0123456789ab.jpg", "layout.json", "tabs.json", "agent-tabs.json", "config.json", "downloads.json", "recordings.json", "handoffs.json", "diagnostics.json"]) {
      assert.notEqual((await request(view.guestPort, "GET", `/${k}/${path}`)).status, 200, `the join-code port never serves ${path}`);
    }
    const before = calls.length;
    assert.equal(before, 3);
    fire({ op: "add", card: { ...card, id: "aaaaaaaaaaaa" } });
    await wait(50);
    const got = eventsIn(owner.text(), "timeline").filter((e) => e.op !== "show");
    assert.equal(got.length, 1);
    assert.equal(got[0].card.caption, "Typed ••••", "masked on the way out");
    assert.equal(eventsIn(guest.text(), "timeline").length, 0, "a guest's stream never gets it");
    assert.ok(!guest.text().includes("Typed"));
  } finally { owner.close(); guest.close(); view.close(); }
  assert.equal(fire, null, "closing the live view lets go of the store");
});

test("timeline: false answers 404 with a clear body", async () => {
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", timeline: { enabled: false, onChange: () => () => {} } });
  const key = view.url.split("/").at(-2);
  try {
    for (const [method, path] of [["GET", "timeline.json"], ["GET", "timeline/0123456789ab.jpg"], ["DELETE", "timeline/0123456789ab"], ["POST", "timeline/note"], ["POST", "timeline/0123456789ab/pin"], ["POST", "timeline/0123456789ab/show"]]) {
      const r = await request(view.port, method, `/${key}/${path}`, { body: method === "POST" ? { text: "x" } : undefined });
      assert.equal(r.status, 404, `${method} /${path}`);
      assert.match(r.text, /timeline: false/);
    }
  } finally { view.close(); }
});

// ---- the browser's own pages (a native build's chrome://pairbrowse pages) ----

test("the browser's own pages' key: owner rights, never echoed, CORS for their origins alone", async () => {
  const picks = [];
  const picker = { state: () => ({ picking: true, sessions: [] }), pick: async (op) => { picks.push(op); return { text: "ok" }; }, open: async () => ({ text: "x" }) };
  const { ctx } = fakeTabs(1);
  const plainView = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", picker });
  const CHROME = ["chrome://pairbrowse", "chrome://pairbrowse.top-chrome"];
  const sessionOps = { state: () => ({ canRename: true, canSave: true, savedAt: "" }), rename: async (name) => ({ ok: true, name, from: "a", restarting: true }), save: async () => ({ ok: true, savedAt: "2026-10-11T10:00:00.000Z" }) };
  const outlines = { latest: () => null, get: () => null, onChange: () => () => {} };
  const timeline = { enabled: true, cards: () => [{ id: "0123456789ab", t: 1, caption: "c", step: null, who: "", pinned: false, note: false }], onChange: () => () => {} };
  let used = 0; // onPagesKey: the helper deletes the key file on the first one
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", picker, extraOrigins: [...CHROME, "chrome-extension://aaaa"], sessionOps, outlines, timeline, onPagesKey: () => used++ });
  try {
    assert.equal(used, 0, "nothing used the pages' key yet");
    for (const v of [plainView, view]) {
      assert.match(v.pagesKey, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!v.url.includes(v.pagesKey), "never in the owner's link");
    }
    // Without the chrome origins allowed (today's builds), their POST is refused.
    assert.equal((await request(plainView.port, "POST", `/${plainView.pagesKey}/pick`, { body: { action: "new" }, headers: { origin: "chrome://pairbrowse" } })).status, 403);
    const k = view.pagesKey;
    let r = await request(view.port, "GET", `/${k}/state.json`);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(k), "state.json never carries it");
    assert.equal(used, 1, "the first request with the pages' key is heard");
    const ownerKey = new URL(view.url).pathname.split("/")[1];
    assert.equal((await request(view.port, "GET", `/${ownerKey}/state.json`)).status, 200);
    assert.equal(used, 1, "the owner's key is not the pages' key");
    r = await request(view.port, "GET", `/${k}/sessions.json`, { headers: { origin: "chrome://pairbrowse" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse");
    r = await request(view.port, "POST", `/${k}/pick`, { body: { action: "new" }, headers: { origin: "chrome://pairbrowse" } });
    assert.equal(r.status, 200);
    assert.deepEqual(picks, [{ action: "new" }]);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse");
    assert.equal(r.headers.vary, "origin");
    r = await request(view.port, "OPTIONS", `/${k}/pick`, { headers: { origin: "chrome://pairbrowse.top-chrome" } });
    assert.equal(r.status, 204);
    assert.match(r.headers["access-control-allow-methods"], /POST/);
    assert.match(r.headers["access-control-allow-headers"], /content-type/);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse.top-chrome");
    // The newer routes take the pages' key as they take the owner's.
    const o = { headers: { origin: "chrome://pairbrowse" } };
    r = await request(view.port, "POST", `/${k}/session`, { body: { op: "save" }, ...o });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, savedAt: "2026-10-11T10:00:00.000Z" }]);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse");
    r = await request(view.port, "POST", `/${k}/session`, { body: { op: "rename", name: "b" }, ...o });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, name: "b", restarting: true }]);
    r = await request(view.port, "GET", `/${k}/outline.json`, o);
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { outline: null }]);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse");
    r = await request(view.port, "POST", `/${k}/timeline/0123456789ab/show`, { body: {}, ...o });
    assert.equal(r.status, 200);
    r = await request(view.port, "POST", `/${k}/layout`, { body: { tab: "pictures" }, ...o });
    assert.equal(JSON.parse(r.text).tab, "pictures");
    r = await request(view.port, "OPTIONS", `/${k}/session`, { headers: { origin: "chrome://pairbrowse.top-chrome" } });
    assert.equal(r.status, 204, "the preflight for POST session");
    assert.match(r.headers["access-control-allow-methods"], /POST/);
    assert.equal(r.headers["access-control-allow-origin"], "chrome://pairbrowse.top-chrome");
    r = await request(view.port, "POST", `/${k}/session`, { body: { op: "save" }, headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 403, "a web origin's POST is refused");
    r = await request(view.port, "OPTIONS", `/${k}/pick`, { headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 404);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    r = await request(view.port, "GET", `/${k}/state.json`, { headers: { origin: "https://evil.example" } });
    assert.equal(r.status, 200, "GETs never checked the origin");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "but no web origin may read the answer");
    r = await request(view.port, "GET", `/${k}/state.json`, { headers: { origin: "chrome-extension://aaaa" } });
    assert.equal(r.headers["access-control-allow-origin"], undefined, "CORS is for the browser's own pages only");
    const before = used;
    assert.equal((await request(view.port, "OPTIONS", `/${"x".repeat(43)}/pick`, { headers: { origin: "chrome://pairbrowse" } })).status, 404, "a wrong key: an unknown route");
    assert.equal((await request(view.port, "GET", `/${"x".repeat(43)}/state.json`)).status, 404);
    assert.equal(used, before, "a wrong key is not the pages' key");
    // Under another host name the pages' key is no key at all (as the owner's).
    assert.equal((await request(view.port, "GET", `/${k}/state.json`, { host: "evil.example" })).status, 403);
    assert.equal((await request(view.port, "GET", `/${k}/state.json`, { headers: { host: "evil.example" } })).status, 403);
    assert.equal(used, before, "nor under a foreign host");
    const stream = await readStream(view.port, `/${k}/events?page=picker`);
    for (let i = 0; i < 50 && !view.pageClients().picker; i++) await wait(20);
    assert.equal(view.pageClients().picker, 1);
    await wait(50);
    assert.ok(!stream.text().includes(k), "the event stream never carries it");
    stream.close();
    assert.notEqual((await request(view.guestPort, "GET", `/${k}/state.json`)).status, 200, "the join-code port never takes it");
    // Every request made with the pages' key under a loopback host on the owner's port, and no other.
    assert.equal(used, 15);
  } finally { plainView.close(); view.close(); }
});

test("the browser's own pages are never tabs on the live view, nor on its stage", async () => {
  const { ctx, pages, sessions } = fakeTabs(4);
  const own = { 1: "chrome://pairbrowse/picker", 2: "chrome://pairbrowse.top-chrome/strip" };
  const frames = pages.map(() => ({}));
  pages.forEach((p, i) => { if (own[i]) p.url = () => own[i]; p.mainFrame = () => frames[i]; p.isClosed = () => false; });
  let current = "about:blank#0";
  const view = await startLiveView({ getContext: async () => ({ ...ctx, on: () => {} }), currentUrl: async () => current });
  const key = view.url.split("/").at(-2);
  try {
    const state = JSON.parse((await request(view.port, "GET", `/${key}/state.json`)).text);
    assert.deepEqual(state.tabs.map((t) => t.i), [0, 3], "the others keep their numbers");
    const strip = JSON.parse((await request(view.port, "GET", `/${key}/tabs.json`)).text);
    assert.deepEqual(strip.map((t) => t.i), [0, 3]);
    const held = JSON.parse((await request(view.port, "GET", `/${key}/agent-tabs.json`)).text);
    assert.deepEqual(held.map((t) => t.i), [0, 3]);
    assert.deepEqual(held.map((t) => t.id), strip.map((t) => t.id));
    assert.equal((await request(view.port, "POST", `/${key}/tab`, { body: { i: 1 } })).status, 204);
    await wait(30);
    assert.equal(sessions.length, 0, "clicking one shows nothing");
    // Agents' current tab is the browser's own page: the stage shows a web page instead.
    current = "chrome://pairbrowse/picker";
    const viewer = await openStream(view.port, `/${key}/events`);
    await wait(1700);
    const following = JSON.parse((await request(view.port, "GET", `/${key}/state.json`)).text);
    viewer.close();
    assert.ok(sessions.length >= 1, "the stage shows a tab");
    for (const s of sessions) assert.ok(!own[pages.indexOf(s.page)], "never one of the browser's own pages");
    assert.ok(!following.tabs.some((t) => t.claude === true), "no web tab is marked as Claude's when Claude is on the browser's own page");
  } finally { view.close(); }
});

test("a joiner's picture page in a build with its own pages is a tab on the live view: shown, and a click reaches it", async () => {
  const { ctx, pages, sessions } = fakeTabs(3);
  // A native joiner's picture of the host's tab (the extension's screen.html elsewhere), beside
  // another of the browser's own pages, which stays out.
  const own = { 1: "chrome://pairbrowse/screen/#0a1b2c3d", 2: "chrome://pairbrowse/picker" };
  pages.forEach((p, i) => { if (own[i]) p.url = () => own[i]; p.mainFrame = () => ({}); p.isClosed = () => false; });
  const view = await startLiveView({ getContext: async () => ({ ...ctx, on: () => {} }), currentUrl: async () => "about:blank#0" });
  const key = view.url.split("/").at(-2);
  try {
    const state = JSON.parse((await request(view.port, "GET", `/${key}/state.json`)).text);
    assert.deepEqual(state.tabs.map((t) => t.i), [0, 1], "the picture page is listed; the picker is not");
    assert.equal((await request(view.port, "POST", `/${key}/tab`, { body: { i: 1 } })).status, 204);
    await wait(60);
    const onPicture = sessions.filter((s) => s.page === pages[1]);
    assert.equal(onPicture.length, 1, "clicking it shows it");
    const p = { x: 40, y: 30 };
    assert.equal((await request(view.port, "POST", `/${key}/input`, { body: [{ type: "mouse", action: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 }, { type: "mouse", action: "mouseReleased", ...p, button: "left", clickCount: 1 }] })).status, 204);
    assert.equal(onPicture[0].calls.filter((m) => m === "Input.dispatchMouseEvent").length, 2, "the click goes into the picture page");
    assert.equal((await request(view.port, "POST", `/${key}/tab`, { body: { i: 2 } })).status, 204);
    await wait(30);
    assert.ok(!sessions.some((s) => s.page === pages[2]), "the browser's other pages are never shown");
  } finally { view.close(); }
});

test("click approvals: owner-only list and answers, events to owner streams only", async () => {
  const invites = createInvites();
  const listeners = new Set();
  const items = new Map();
  const answers = [];
  const ID = `ap-${"a".repeat(32)}`, ID2 = `ap-${"b".repeat(32)}`;
  const item = (id) => ({ id, agent: { label: "Alice · Codex", color: "#20c997" }, kind: "click", target: "Place order", reason: '"Pay: Place order" pays: a final action (pay)', tab: { id: 0, host: "shop.example" }, at: 1 });
  const clickApprovals = {
    pending: () => [...items.values()],
    answer: (id, a, from) => { if (!items.has(id)) return false; items.delete(id); answers.push([id, a, from]); for (const fn of listeners) fn({ op: "withdraw", item: { id } }); return true; },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const add = (id) => { items.set(id, item(id)); for (const fn of listeners) fn({ op: "add", item: item(id) }); };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, clickApprovals });
  const key = view.url.split("/").at(-2);
  const w = invites.create({ role: "watch", label: "W" });
  const d = invites.create({ role: "drive", label: "D" });
  const owner = await readStream(view.port, `/${key}/events?page=right`);
  const guest = await readStream(view.port, `/${d.key}/events?panel=1`);
  try {
    let r = await request(view.port, "GET", `/${key}/approvals.json`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { pending: [] });
    view.setDriving(true);
    await wait(50);
    assert.deepEqual(eventsIn(owner.text(), "driving"), [], "driving only while something is pending");
    add(ID);
    await wait(50);
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/approvals.json`)).text), { pending: [item(ID)] });
    assert.deepEqual(eventsIn(owner.text(), "approval"), [{ op: "add", item: item(ID) }]);
    assert.deepEqual(eventsIn(owner.text(), "driving"), [{ on: true }], "said once when the first approval came");
    view.setDriving(false);
    await wait(50);
    assert.deepEqual(eventsIn(owner.text(), "driving"), [{ on: true }, { on: false }]);
    // A new owner stream, while one waits, hears the driving state at once.
    const late = await readStream(view.port, `/${key}/events?page=strip`);
    await wait(50);
    assert.deepEqual(eventsIn(late.text(), "driving"), [{ on: false }]);
    late.close();

    for (const k of [w.key, d.key]) {
      assert.equal((await request(view.port, "GET", `/${k}/approvals.json`)).status, 403);
      assert.equal((await request(view.port, "POST", `/${k}/approve`, { body: { id: ID, answer: "allow" } })).status, 403);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) {
      assert.notEqual((await request(view.guestPort, "GET", `/${k}/approvals.json`)).status, 200, "the join-code port never serves it");
      assert.notEqual((await request(view.guestPort, "POST", `/${k}/approve`, { body: { id: ID, answer: "allow" } })).status, 200, "nor answers");
    }
    for (const bad of [{ id: ID, answer: "maybe" }, { id: "r1", answer: "allow" }, { id: `ap-${"A".repeat(32)}`, answer: "deny" }, { id: 5, answer: "allow" }]) {
      r = await request(view.port, "POST", `/${key}/approve`, { body: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.ok(JSON.parse(r.text).error);
    }
    assert.equal(items.size, 1, "nothing answered by a bad body or a guest");
    r = await request(view.port, "POST", `/${key}/approve`, { body: { id: ID, answer: "allow" } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true });
    r = await request(view.port, "POST", `/${key}/approve`, { body: { id: ID, answer: "allow" } });
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.text), { ok: false });
    // The browser's own pages' key answers like the owner's.
    add(ID2);
    r = await request(view.port, "POST", `/${view.pagesKey}/approve`, { body: { id: ID2, answer: "deny" } });
    assert.equal(r.status, 200);
    assert.deepEqual(answers, [[ID, "allow", "the live view"], [ID2, "deny", "the live view"]]);
    // A join answer still goes the join way.
    assert.equal((await request(view.port, "POST", `/${key}/approve`, { body: { id: "r1", allow: true } })).status, 404, "no such request");
    await wait(50);
    assert.deepEqual(eventsIn(owner.text(), "approval").map((e) => e.op), ["add", "withdraw", "add", "withdraw"]);
    assert.deepEqual(eventsIn(owner.text(), "approval")[1], { op: "withdraw", item: { id: ID } });
    assert.deepEqual(eventsIn(guest.text(), "approval"), [], "an invite link's stream gets none");
    assert.deepEqual(eventsIn(guest.text(), "driving"), []);
    assert.equal(view.guestViewers(), 1, "the invite link's viewer counts");
  } finally { owner.close(); guest.close(); view.close(); }
  assert.equal(listeners.size, 0, "unsubscribed on close");
});

test("the pause route: the owner pauses and resumes one agent by name, a drive guest pauses everyone, guests never see who is paused on their own", async () => {
  const invites = createInvites();
  const calls = [];
  let answer = { ok: true };
  const agents = [{ who: "Claude ab12", by: "Bob", at: 1 }];
  const state = { paused: false, by: "", at: 0, resumedBy: "", can: true, perAgent: true, agents };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites,
    onPause: (...args) => { calls.push(args); return answer; }, pauseState: () => state });
  const key = view.url.split("/").at(-2);
  const d = invites.create({ role: "drive", label: "D" });
  const w = invites.create({ role: "watch", label: "W" });
  const read = (k) => new Promise((resolve) => {
    let text = "";
    const req = http.get({ host: "127.0.0.1", port: view.port, path: `/${k}/events?panel=1` }, (res) => { res.setEncoding("utf8"); res.on("data", (c) => (text += c)); resolve({ text: () => text, close: () => req.destroy() }); });
    req.on("error", () => {});
  });
  const pauses = (text) => text.split("\n\n").filter((b) => b.startsWith("event: pause\n")).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
  const owner = await read(key), driver = await read(d.key), watcher = await read(w.key);
  try {
    let r = await request(view.port, "POST", `/${key}/pause`, { body: { paused: true, who: "Claude ab12" } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true }]);
    assert.deepEqual(calls.at(-1), [true, null, "Claude ab12"]);
    r = await request(view.port, "POST", `/${key}/pause`, { body: { paused: false, who: "Claude ab12" } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), [false, null, "Claude ab12"], "resumed by name");
    const n = calls.length;
    for (const who of ["", "  ", 5, null, "x".repeat(81)]) {
      r = await request(view.port, "POST", `/${key}/pause`, { body: { paused: true, who } });
      assert.equal(r.status, 409, JSON.stringify(who));
      assert.match(JSON.parse(r.text).error, /agent's name/);
    }
    assert.equal(calls.length, n, "a bad name never reaches the helper");
    answer = { problem: "No agent named \"Ghost\" works in this browser." };
    r = await request(view.port, "POST", `/${key}/pause`, { body: { paused: true, who: "Ghost" } });
    assert.deepEqual([r.status, JSON.parse(r.text).problem], [409, answer.problem]);
    answer = { ok: true };
    // A drive guest's plain pause still works, under the guest's name; with `who` it's refused.
    r = await request(view.port, "POST", `/${d.key}/pause`, { body: { paused: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), [true, "D"]);
    assert.equal((await request(view.port, "POST", `/${d.key}/pause`, { body: { paused: true, who: "Claude ab12" } })).status, 403);
    assert.equal((await request(view.port, "POST", `/${w.key}/pause`, { body: { paused: true } })).status, 403, "a watcher can't pause");
    r = await request(view.port, "POST", `/${key}/pause`, { body: { paused: false } });
    assert.deepEqual(calls.at(-1), [false, null], "the owner's plain Resume");
    // The pause event: the owner's carries perAgent and the agents; guests' the old shape.
    view.setPause();
    await wait(50);
    const own = pauses(owner.text());
    assert.equal(own.length, 2, "on connecting and on the change");
    for (const e of own) { assert.equal(e.perAgent, true); assert.deepEqual(e.agents, agents); }
    for (const s of [driver, watcher]) {
      const got = pauses(s.text());
      assert.equal(got.length, 2);
      for (const e of got) assert.deepEqual(Object.keys(e).sort(), ["at", "by", "can", "paused", "resumedBy"]);
    }
  } finally { owner.close(); driver.close(); watcher.close(); view.close(); }
});

// ---- a person's own tab (a file opened from Downloads): its picture never reaches guests ----
test("a person's tab's picture never reaches guests: not in flight after a switch, not kept after it closes", async () => {
  const { ctx, pages, sessions } = fakeTabs(3);
  const person = new Set([pages[1], pages[2]]);
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, tools: { personTab: (p) => person.has(p) } });
  const key = view.url.split("/").at(-2);
  const w = invites.create({ role: "watch", label: "W" });
  const tab = (i) => request(view.port, "POST", `/${key}/tab`, { body: { i } });
  const sessionOf = (page) => sessions.filter((s) => s.page === page).at(-1);
  const frame = (cdp, img) => cdp.emit("Page.screencastFrame", { data: img, metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1 });
  const frames = (s) => eventsIn(s.text(), "frame").map((f) => f.img);
  const owner = await readStream(view.port, `/${key}/events`);
  const guest = await readStream(view.port, `/${w.key}/events`);
  const streams = [owner, guest];
  try {
    for (let i = 0; i < 100 && !sessionOf(pages[0]); i++) await wait(20);
    // The owner shows a person's tab: the owner sees it, the guest doesn't.
    await tab(1);
    const personCdp = sessionOf(pages[1]);
    frame(personCdp, "PERSON-1");
    await wait(50);
    assert.ok(frames(owner).includes("PERSON-1"), "the owner sees their own tab");
    assert.deepEqual(frames(guest), [], "never to the guest");
    // Switched to a web tab: a frame still in flight from the person's tab is dropped for everyone.
    await tab(0);
    frame(personCdp, "PERSON-LATE");
    await wait(50);
    assert.ok(!owner.text().includes("PERSON-LATE") && !guest.text().includes("PERSON-LATE"), "a released session's frame is dropped");
    // A guest connecting now (the web tab hasn't drawn yet): no frame of the person's tab.
    const early = await readStream(view.port, `/${w.key}/events`);
    streams.push(early);
    await wait(50);
    assert.deepEqual(frames(early), [], "the last picture went with the switch");
    // The other person's tab, shown, then closed while on screen: its picture goes with it.
    await tab(2);
    frame(sessionOf(pages[2]), "PERSON-2");
    await wait(50);
    const closing = pages[2];
    pages.splice(2, 1);
    closing.emit("close");
    person.delete(closing); // the helper forgets it as it closes (its set is a WeakSet)
    const late = await readStream(view.port, `/${w.key}/events`);
    streams.push(late);
    await wait(80);
    assert.deepEqual(frames(late), [], "a guest connecting right after the close gets no frame until the web tab draws");
    for (let i = 0; i < 100 && (!sessionOf(pages[0]) || sessionOf(pages[0]).detached); i++) await wait(20); // the follow back to the web tab
    frame(sessionOf(pages[0]), "WEB-1");
    await wait(50);
    for (const s of [guest, early, late]) {
      assert.ok(!/PERSON/.test(s.text()), "no person's frame, ever");
      assert.equal(frames(s)[0], "WEB-1", "the web tab's first frame is the first a guest gets");
    }
  } finally {
    for (const s of streams) s.close();
    view.close();
  }
});

test("a person's tab never crosses to joiners, even at a web address; screen requests for it are refused", async () => {
  const { ctx, pages } = fakeTabs(2);
  pages[0].url = () => "https://shop.example/";
  pages[1].url = () => "https://docs.example/from-a-pdf-link"; // the person's tab, gone on to a web page
  pages.forEach((p) => { p.isClosed = () => false; });
  const person = new Set([pages[1]]);
  const invites = createInvites();
  const requests = [];
  const screens = { offer: async () => ({ sdp: "x" }), frames: async () => {}, input: async () => {}, stop: async () => {}, answer: async () => true };
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, screens, onJoinRequest: (e) => requests.push(e), tools: { personTab: (p) => person.has(p) } });
  const code = invites.create({ role: "drive", label: "D", share: "code", mode: "shared" });
  const headers = { "x-pairbrowse-joiner": "a".repeat(32), "x-pairbrowse-name": "Dee", "x-pairbrowse-app": "Claude Code" };
  try {
    assert.equal((await request(view.guestPort, "GET", `/${code.key}/tabs`, { headers })).status, 403, "waiting for the host");
    view.approvals.approve(requests[0].id);
    const r = await request(view.guestPort, "GET", `/${code.key}/tabs`, { headers });
    assert.equal(r.status, 200, r.text);
    const tabs = JSON.parse(r.text).tabs;
    assert.ok(tabs.some((t) => /shop\.example/.test(t.url)), "the web tab crosses");
    assert.ok(!r.text.includes("docs.example"), "the person's tab doesn't");
    // Its id, as an owner's strip would know it: screening into it is refused.
    const strip = JSON.parse((await request(view.port, "GET", `/${view.url.split("/").at(-2)}/tabs.json`)).text);
    const id = strip.find((t) => t.personal)?.id;
    assert.ok(id, "the owner's strip lists it, personal");
    for (const op of ["want", "frames", "input"]) {
      const s = await request(view.guestPort, "POST", `/${code.key}/screen`, { headers, body: { op, id, on: true, events: [] } });
      assert.equal(s.status, 400, op);
      assert.equal(JSON.parse(s.text).error, "That tab isn't shared.", op);
    }
  } finally { view.close(); }
});

test("POST tab-order and POST capture/reply: the owner's and the pages' key only, checked, never on the join-code port", async () => {
  const invites = createInvites();
  const { ctx } = fakeTabs(1);
  const replies = [];
  const capture = { reply: (b) => { if (!b || typeof b.n !== "number") return false; replies.push(b); return true; } };
  const logs = [];
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", invites, capture, log: (...a) => logs.push(a.join(" ")) });
  const key = view.url.split("/").at(-2);
  const T = "0123456789abcdef0123456789ABCDEF";
  const order = { tabs: [{ target: T, window: 1, index: 0, active: true }], focused: 1, last: 1 };
  try {
    assert.equal(view.stripTabs(), null, "nothing reported yet");
    for (const k of [key, view.pagesKey]) {
      assert.equal((await request(view.port, "POST", `/${k}/tab-order`, { body: order })).status, 204);
      assert.equal((await request(view.port, "POST", `/${k}/capture/reply`, { body: { n: 1, value: true } })).status, 204);
    }
    assert.deepEqual(view.stripTabs(), { tabs: [{ target: T.toUpperCase(), window: 1, index: 0, active: true }], focused: 1, last: 1 });
    assert.equal(replies.length, 2);
    assert.equal((await request(view.port, "POST", `/${key}/tab-order`, { body: { tabs: [{ target: "nope", window: 1, index: 0, active: true }], focused: 1, last: 1 } })).status, 400);
    assert.equal((await request(view.port, "POST", `/${key}/tab-order`, { raw: "{" })).status, 400);
    assert.equal((await request(view.port, "POST", `/${key}/tab-order`, { raw: JSON.stringify({ tabs: [], focused: 1, last: 1, pad: "x".repeat(70_000) }) })).status, 413, "at most 64 KB");
    assert.equal((await request(view.port, "POST", `/${key}/capture/reply`, { body: { n: "x" } })).status, 400);
    assert.equal((await request(view.port, "POST", `/${key}/capture/other`, { body: { n: 1 } })).status, 404);
    for (const role of ["drive", "watch"]) {
      const i = invites.create({ role, label: role });
      assert.equal((await request(view.port, "POST", `/${i.key}/tab-order`, { body: order })).status, 403, role);
      assert.equal((await request(view.port, "POST", `/${i.key}/capture/reply`, { body: { n: 2, value: true } })).status, 403, role);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code", mode: "shared" });
    for (const k of [c.key, key]) {
      assert.notEqual((await request(view.guestPort, "POST", `/${k}/tab-order`, { body: order })).status, 204, "the join-code port never serves it");
      assert.notEqual((await request(view.guestPort, "POST", `/${k}/capture/reply`, { body: { n: 3, value: true } })).status, 204);
    }
    assert.equal(replies.length, 2, "no reply came in by a guest");
  } finally { view.close(); }
});

test("the capture and tab-order events reach the browser's own pages only, never the live view, a viewer or a guest", async () => {
  const invites = createInvites();
  const { ctx } = fakeTabs(1);
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => "about:blank#0", invites });
  const key = view.url.split("/").at(-2);
  const streams = [];
  try {
    const page = await readStream(view.port, `/${key}/events?panel=1&page=capture`); streams.push(page);
    const strip = await readStream(view.port, `/${key}/events?page=strip`); streams.push(strip);
    const panel = await readStream(view.port, `/${key}/events?panel=1`); streams.push(panel);
    const viewer = await readStream(view.port, `/${key}/events`); streams.push(viewer);
    const w = invites.create({ role: "watch", label: "W" });
    const guest = await readStream(view.port, `/${w.key}/events?page=capture`); streams.push(guest);
    await wait(50);
    view.sendToPages("capture", { n: 1, to: "share", op: "offer" });
    view.sendToPages("tab-order", { op: "arrange", targets: ["A"] });
    view.sendToPages("activity", []); // not a pages-only event: refused
    await wait(80);
    for (const s of [page, strip]) assert.equal(eventsIn(s.text(), "tab-order").length, 1, "tab-order: every page stream");
    assert.equal(eventsIn(page.text(), "capture").length, 1, "capture: the capture page's stream");
    assert.equal(eventsIn(strip.text(), "capture").length, 0, "capture: never another page's stream");
    for (const s of [panel, viewer, guest]) {
      assert.equal(eventsIn(s.text(), "capture").length, 0);
      assert.equal(eventsIn(s.text(), "tab-order").length, 0);
    }
  } finally { for (const s of streams) s.close(); view.close(); }
});

test("a screen want while nothing here captures a tab: the slower route at once, nothing offered, nothing logged", async () => {
  const { ctx, pages } = fakeTabs(1);
  pages[0].url = () => "https://shop.example/";
  pages.forEach((p) => { p.isClosed = () => false; });
  const invites = createInvites();
  const requests = [];
  const logs = [];
  let offered = 0;
  const screens = { available: () => false, offer: async () => { offered++; throw new Error("no"); }, frames: async () => {}, input: async () => {}, stop: async () => {}, answer: async () => true, stopAll: async () => {} };
  const view = await startLiveView({ getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, screens, onJoinRequest: (e) => requests.push(e), log: (...a) => logs.push(a.join(" ")) });
  const code = invites.create({ role: "drive", label: "D", share: "code", mode: "shared" });
  const headers = { "x-pairbrowse-joiner": "b".repeat(32), "x-pairbrowse-name": "Dee", "x-pairbrowse-app": "Claude Code" };
  try {
    await request(view.guestPort, "GET", `/${code.key}/tabs`, { headers });
    view.approvals.approve(requests[0].id);
    const tabs = JSON.parse((await request(view.guestPort, "GET", `/${code.key}/tabs`, { headers })).text).tabs;
    const s = await request(view.guestPort, "POST", `/${code.key}/screen`, { headers, body: { op: "want", id: tabs[0].id } });
    assert.equal(s.status, 400);
    const body = JSON.parse(s.text);
    assert.equal(body.route, "frames");
    assert.match(body.error, /join channel/);
    assert.equal(offered, 0);
    assert.ok(!logs.some((l) => /liveview guest|shared screen/.test(l)), logs.join("\n"));
  } finally { view.close(); }
});
