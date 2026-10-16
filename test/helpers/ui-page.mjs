// The pages' harness, for test files: openPage renders one ui/<name>/index.html over a fake helper
// (fake-helper.mjs) and the ui server (ui-server.mjs); pageTest wraps it in a node:test test with
// a browser of its own. Without PAIRBROWSE_TEST_RUNTIME the test is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { patchright, inPage } from "./live.mjs";
import { startFakeHelper, merge } from "./fake-helper.mjs";
import { startUiServer, UI_ROOT } from "./ui-server.mjs";
import { defaultFixture } from "./pairbrowse-shim.mjs";

export const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

// The pages: every ui/<name>/ with an index.html, sorted.
export const pages = () => readdirSync(UI_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(UI_ROOT, d.name, "index.html")))
  .map((d) => d.name).sort();

// A wait of ms, for the tests that need one.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// host: serve the page as http://<host>/ instead of the ui server's own origin, for a page whose
// mode follows location.host (the approve page's bubble on pairbrowse.top-chrome). The browser
// must reach the ui server as its proxy: launch it with hostProxy(...).args, then pass the same
// proxy as `proxy` here (the ui server answers a proxied request by its path).
export async function openPage(browser, name, { helper, fixture = defaultFixture(), bridge = true, native = true, viewport = { width: 360, height: 900 }, reducedMotion = "no-preference", host = "", proxy = null } = {}) {
  const ui = await startUiServer({ helper, fixture, bridge, native });
  const origin = host ? `http://${host}` : ui.origin;
  proxy?.to(ui.origin);
  helper.setPageOrigin(origin);
  const page = await browser.newPage({ viewport, reducedMotion });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(host ? `${origin}/${name}/index.html` : ui.url(name), { waitUntil: "load" });
  // A page that says it connects (body[data-s]) gets up to 3 s to leave "connecting"; not a failure.
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate(() => document.body?.dataset.s);
    if (s === undefined || s !== "connecting") break;
    await sleep(50);
  }
  await sleep(300);
  const shim = (path, ...args) => inPage(page, ([p, a]) => {
    let target = window.__pairbrowse, owner = null;
    for (const k of p.split(".")) { owner = target; target = target[k]; }
    return typeof target === "function" ? target.apply(owner, a) : target;
  }, [path, args]);
  const harness = {
    log: () => inPage(page, () => window.__harness.log),
    live: () => inPage(page, () => window.__harness.live()),
    setHidden: (on) => inPage(page, (v) => window.__harness.setHidden(v), on),
    animations: () => inPage(page, () => window.__harness.animations()),
    hiddenFires: () => inPage(page, () => window.__harness.hiddenFires),
  };
  const until = async (what, fn, arg) => {
    for (let i = 0; i < 100; i++) { if (await inPage(page, fn, arg)) return; await page.waitForTimeout(50); }
    assert.fail(`timed out waiting for ${what}`);
  };
  // Every running animation and transition of the page (DESIGN.md Part I's motion) at its end, so
  // a measure after a click sees where things land, not a frame of the way there.
  const settle = () => inPage(page, () => {
    let timer = 0;
    return Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
      new Promise((r) => { timer = setTimeout(r, 1000); }),
    ]).then(() => { clearTimeout(timer); return true; });
  });
  return {
    page, ui, errors, harness, until, settle,
    inPage: (fn, arg) => inPage(page, fn, arg),
    shim: {
      calls: () => shim("calls"),
      fixture: () => shim("fixture"),
      call: shim,
      change: (partial) => shim("tabs.change", partial),
      createTab: (t) => shim("tabs.create", t),
      removeTab: (id) => shim("tabs.remove", id),
      moveTab: (id, index, window) => shim("tabs.move", id, index, window),
      activate: (id) => shim("tabs.activate", id),
      setWindow: (w) => shim("windows.set", w),
      focusWindow: (id) => shim("windows.focus", id),
      removeWindow: (id) => shim("windows.remove", id),
      layout: (partial) => shim("layout.set", partial),
      omnibox: (partial) => shim("omnibox.set", partial),
      setOwner: (id, agent, color) => shim("agent.setOwner", id, agent, color),
      clearOwner: (id) => shim("agent.clear", id),
      notificationAction: (id, button) => shim("agent.notificationAction", id, button),
      reply: (name, value) => shim("reply", name, value),
    },
    close: async () => { await page.close().catch(() => {}); await ui.close(); },
  };
}

// The ui server under another host name: a forward proxy on loopback that hands every request to
// the ui server set by to(origin). args: the browser's launch switches (loopback stays direct, so
// the helper is reached as usual; the host counts as a secure context, as chrome:// pages do, so
// Web Locks exist there: in the full engine, launch({ channel: "chromium" }); the headless
// shell ignores that switch).
export async function hostProxy(host) {
  let target = null;
  const server = http.createServer((req, res) => {
    if (!target) { res.writeHead(502); res.end(); return; }
    const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    args: [`--proxy-server=http://127.0.0.1:${port}`, `--unsafely-treat-insecure-origin-as-secure=http://${host}`],
    to: (origin) => { target = new URL(origin); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// pageTest(name, [opts], fn): opts { fixtures, replies, down (fake-helper), shim (over defaultFixture()),
// bridge, native (false: no window.pairbrowse, the served or extension host), viewport,
// reducedMotion, timeout }; fn gets { page, helper, ui, shim, harness, errors,
// until, inPage }.
export function pageTest(name, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const o = opts || {};
  test(`${name} page`, { skip: !runtime, timeout: o.timeout ?? 60_000 }, async () => {
    const browser = await patchright(runtime).chromium.launch();
    let helper = null, ctx = null;
    try {
      helper = await startFakeHelper({ pageOrigin: null, fixtures: o.fixtures, replies: o.replies, down: o.down });
      ctx = await openPage(browser, name, { helper, fixture: merge(defaultFixture(), o.shim || {}), bridge: o.bridge ?? true, native: o.native ?? true, viewport: o.viewport, reducedMotion: o.reducedMotion });
      await fn({ ...ctx, helper });
    } finally {
      await ctx?.close();
      await helper?.close();
      await browser.close();
    }
  });
}
