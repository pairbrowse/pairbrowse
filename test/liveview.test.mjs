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
    }
    for (const [method, path] of [["GET", "nope"], ["DELETE", ""], ["GET", "input"], ["PUT", "profile"], ["GET", "approve"]]) {
      assert.equal((await request(view.port, method, `/${key}/${path}`)).status, 404, `${method} /${path}`);
    }
    assert.equal((await request(view.port, "POST", `/${key}/approve`, { body: { id: "r1", allow: true } })).status, 404, "no such request");
  } finally { view.close(); }
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
    for (const name of ["liveview.js", "liveview.css", "common.js"]) {
      const r = await request(view.port, "GET", `/${key}/assets/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers["content-type"], name.endsWith(".css") ? /^text\/css/ : /^text\/javascript/);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    const w = invites.create({ role: "watch", label: "W" });
    assert.equal((await request(view.port, "GET", `/${w.key}/assets/liveview.js`)).status, 200, "an invite link loads the page's files too");
    for (const bad of ["assets/liveview.mjs", "assets/../liveview.mjs", "assets/%2e%2e/liveview.mjs", "assets/", "assets", "assets/common.js/x", "assets/constructor", "assets/__proto__"]) {
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
