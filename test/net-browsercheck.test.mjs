// The browser's side of the egress check (spec server-mode C6 (2), (3); net/browsercheck.mjs) with a
// stand-in browser: the check address read through the DevTools protocol's
// Network.loadNetworkResource in its own tab, base64 or not, then the WebRTC gathering; every
// browser call bounded, so a browser that never answers fails the check in time instead of
// holding the launch; the tab and its DevTools session closed whatever happened. A real browser
// through a stand-in proxy: test/integration/net-browsercheck.test.mjs.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInBrowser } from "../scripts/net/browsercheck.mjs";

const never = () => new Promise(() => {});
const TRACE = "fl=1\nip=203.0.113.10\nloc=US\n";

// A stand-in context: cdp answers by method (a function of params, or a value), gather the page's.
function fakeContext({ cdp = {}, gather = { complete: true, candidates: [], problem: "" }, newPage, newCDPSession } = {}) {
  const calls = [], closed = { page: 0, cdp: 0 };
  const page = {
    evaluate: async (fn, arg) => { calls.push(["evaluate", arg]); return typeof gather === "function" ? gather(arg) : gather; },
    close: async () => { closed.page++; },
  };
  const answers = {
    "Page.getFrameTree": { frameTree: { frame: { id: "F1" } } },
    "Network.loadNetworkResource": { resource: { success: true, httpStatusCode: 200, stream: "S1" } },
    "IO.read": (() => { let n = 0; return () => (n++ === 0 ? { data: Buffer.from(TRACE).toString("base64"), base64Encoded: true, eof: false } : { data: "", eof: true }); })(),
    "IO.close": {},
    ...cdp,
  };
  const session = {
    send: async (method, params) => { calls.push([method, params]); const a = answers[method]; return typeof a === "function" ? a(params) : a; },
    detach: async () => { closed.cdp++; },
  };
  return {
    calls, closed,
    newPage: newPage || (async () => page),
    newCDPSession: newCDPSession || (async () => session),
  };
}

test("reads the check address in its own tab, then gathers WebRTC candidates; closes the tab after", async () => {
  const ctx = fakeContext({ gather: { complete: true, candidates: ["candidate:1 1 udp 1 a.local 1 typ host"], problem: "" } });
  const r = await checkInBrowser(ctx, { checkUrl: "https://cloudflare.com/cdn-cgi/trace", stun: "stun:127.0.0.1:3478", gatherMs: 500 });
  assert.deepEqual(r, { browser: { ok: true, ip: "203.0.113.10", loc: "US" }, webrtc: { ok: true, candidates: ["candidate:1 1 udp 1 a.local 1 typ host"] } });
  const load = ctx.calls.find(([m]) => m === "Network.loadNetworkResource")[1];
  assert.deepEqual(load, { frameId: "F1", url: "https://cloudflare.com/cdn-cgi/trace", options: { disableCache: true, includeCredentials: false } });
  assert.ok(ctx.calls.some(([m, p]) => m === "IO.close" && p.handle === "S1"), "the stream is closed");
  assert.deepEqual(ctx.calls.find(([m]) => m === "evaluate")[1], { stun: "stun:127.0.0.1:3478", ms: 500, max: 64 });
  assert.deepEqual(ctx.closed, { page: 1, cdp: 1 });
});

test("a failed load, a status other than 200, a body without ip: the browser check fails, WebRTC still runs", async () => {
  for (const [resource, re] of [
    [{ success: false, netErrorName: "net::ERR_PROXY_CONNECTION_FAILED" }, /didn't load \(net::ERR_PROXY_CONNECTION_FAILED\)/],
    [{ success: true, httpStatusCode: 407, stream: "S1" }, /answered status 407/],
  ]) {
    const ctx = fakeContext({ cdp: { "Network.loadNetworkResource": { resource } } });
    const r = await checkInBrowser(ctx, { checkUrl: "https://x.test/t", gatherMs: 200 });
    assert.equal(r.browser.ok, false);
    assert.match(r.browser.problem, re);
    assert.equal(r.webrtc.ok, true);
    assert.equal(ctx.closed.page, 1);
  }
  const plain = fakeContext({ cdp: { "IO.read": { data: "loc=US\n", base64Encoded: false, eof: true } } });
  assert.match((await checkInBrowser(plain, { checkUrl: "https://x.test/t" })).browser.problem, /without an ip= line/);
  const huge = fakeContext({ cdp: { "IO.read": { data: "x".repeat(70_000), eof: false } } });
  assert.match((await checkInBrowser(huge, { checkUrl: "https://x.test/t" })).browser.problem, /more than a check needs/);
});

test("a browser that never answers fails the check within its bounds, never passes it", async () => {
  // The tab never opens: both parts fail, in time.
  let t0 = Date.now();
  const noTab = await checkInBrowser(fakeContext({ newPage: never }), { checkUrl: "https://x.test/t", timeoutMs: 200 });
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual([noTab.browser.ok, noTab.browser.timedOut, noTab.browser.step], [false, true, "tab"]);
  assert.equal(noTab.webrtc.ok, false);
  // The load never answers; the gathering never answers.
  t0 = Date.now();
  const ctx = fakeContext({ cdp: { "Network.loadNetworkResource": never }, gather: never });
  const hung = await checkInBrowser(ctx, { checkUrl: "https://x.test/t", timeoutMs: 200, gatherMs: 100 });
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  assert.deepEqual([hung.browser.ok, hung.browser.timedOut, hung.browser.step], [false, true, "load"]);
  assert.deepEqual([hung.webrtc.ok, hung.webrtc.timedOut], [false, true]);
  assert.deepEqual(ctx.closed, { page: 1, cdp: 1 }, "closed all the same");
  // A gathering that didn't complete in the page, or failed there.
  const slow = await checkInBrowser(fakeContext({ gather: { complete: false, candidates: ["candidate:x"], problem: "" } }), { checkUrl: "https://x.test/t", gatherMs: 300 });
  assert.deepEqual([slow.webrtc.ok, slow.webrtc.timedOut], [false, true]);
  assert.match(slow.webrtc.problem, /didn't finish within 300 ms/);
  const broken = await checkInBrowser(fakeContext({ gather: { complete: false, candidates: [], problem: "NotSupportedError" } }), { checkUrl: "https://x.test/t" });
  assert.match(broken.webrtc.problem, /gathering failed \(NotSupportedError\)/);
  // The DevTools session can't open: the tab still closes.
  const noCdp = fakeContext({ newCDPSession: async () => { throw new Error("no"); } });
  const r = await checkInBrowser(noCdp, { checkUrl: "https://x.test/t" });
  assert.deepEqual([r.browser.ok, r.browser.step], [false, "devtools"]);
  assert.equal(noCdp.closed.page, 1);
});
