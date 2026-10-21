// The browser's side of the egress check (spec server-mode C6 (2), (3); net/browsercheck.mjs) in a
// real browser started through a stand-in proxy, as a proxied session starts: the check address
// is read through the proxy (its log shows the request, the trace echo the proxy's exit), and with
// strict mode's WebRTC switch the gathering shows no address; the same gathering without it shows
// the STUN responder's mapped address as a leak, which proves the WebRTC check sees one. A proxy
// that is down fails the check rather than passing it. Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { checkInBrowser } from "../../scripts/net/browsercheck.mjs";
import { webrtcVerdict, egressVerdict } from "../../scripts/net/verdict.mjs";
import { probeEgress } from "../../scripts/net/probe.mjs";
import { resolverRule, launchPart, networkFor, DRIVER_LOOPBACK } from "../../scripts/net/config.mjs";
import { traceServer, httpProxy, stunResponder, closedPort } from "../helpers/proxies.mjs";
import { nativeExe } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const EXIT = "203.0.113.10", MAPPED = "198.51.100.7";
const CHECK = "http://trace.test/cdn-cgi/trace";
// A strict session's switches exactly as a launch of the browser under test gets them (launchPart):
// the open build's browser ignores STRICT_WEBRTC alone and gathers srflx candidates (this file's
// first run showed it, spec server-mode step 28), so launchPart adds the spelling it reads; the
// native build (PAIRBROWSE_TEST_EXECUTABLE, helpers/daemon.mjs nativeExe) gets STRICT_WEBRTC only.
const STRICT = launchPart(networkFor({ network: { proxies: { stub: { server: "http://127.0.0.1:3128" } }, default: "stub" } }, "check"), { native: !!nativeExe }).args;

const stubs = [];
after(async () => { for (const s of stubs) await s.close(); });

// A browser through `proxyPort` with the launch's switches, closed after fn.
async function withBrowser(proxyPort, args, fn) {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch({ headless: true, ...(nativeExe ? { executablePath: nativeExe } : {}), proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: DRIVER_LOOPBACK.join(",") }, args });
  try { return await fn(await browser.newContext()); } finally { await browser.close(); }
}

test("the browser check reads the exit through the proxy; strict WebRTC shows no address, without it a leak shows", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 120_000 }, async () => {
  const trace = await traceServer({ ip: EXIT, loc: "US" });
  const proxy = await httpProxy({ upstream: trace.port });
  const stun = await stunResponder({ mapped: MAPPED });
  stubs.push(trace, proxy, stun);
  const opts = { checkUrl: CHECK, stun: `stun:127.0.0.1:${stun.port}`, timeoutMs: 10_000, gatherMs: 4000 };

  const strict = await withBrowser(proxy.port, STRICT, async (ctx) => {
    const r = await checkInBrowser(ctx, opts);
    assert.equal(ctx.pages().length, 0, "the check tab is closed after");
    return r;
  });
  assert.deepEqual(strict.browser, { ok: true, ip: EXIT, loc: "US" });
  assert.ok(proxy.log.some((l) => l.method === "GET" && l.target === CHECK), `the check went through the proxy: ${JSON.stringify(proxy.log)}`);
  assert.ok(trace.state.hosts.includes("trace.test"), "the proxy looked the name up, not the browser");
  assert.equal(strict.webrtc.ok, true, JSON.stringify(strict.webrtc));
  const helper = await probeEgress({ proxy: { scheme: "http", host: "127.0.0.1", port: proxy.port }, checkUrl: CHECK });
  assert.equal(egressVerdict({ helper, browser: strict.browser }).verdict, "ok");
  assert.equal(webrtcVerdict(strict.webrtc, { egress: EXIT }).verdict, "ok", JSON.stringify(strict.webrtc));

  // The same check without the WebRTC switch: the gathering reaches the STUN responder, and its
  // mapped address (standing in for this computer's own) is a leak. The native build denies
  // non-proxied UDP even with no switch (its own default), so there the leak needs the policy
  // turned back to the engine's default, which the helper never passes (native-engine.mjs).
  const loose = await withBrowser(proxy.port, [resolverRule("127.0.0.1"), ...(nativeExe ? ["--webrtc-ip-handling-policy=default"] : [])], (ctx) => checkInBrowser(ctx, opts));
  assert.equal(loose.browser.ok, true);
  assert.equal(loose.webrtc.ok, true, JSON.stringify(loose.webrtc));
  assert.ok(stun.state.requests > 0, "the gathering asked the STUN responder");
  const leak = webrtcVerdict(loose.webrtc, { egress: EXIT });
  assert.equal(leak.verdict, "leak", JSON.stringify(loose.webrtc));
  assert.ok(loose.webrtc.candidates.some((c) => c.includes(MAPPED)), "the srflx candidate carries the mapped address");
  assert.doesNotMatch(JSON.stringify(leak), new RegExp(MAPPED.replaceAll(".", "\\.")), "the verdict keeps no address");
});

test("a proxy that is down fails the browser check, never passes it", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 60_000 }, async () => {
  const port = await closedPort();
  const r = await withBrowser(port, STRICT, (ctx) => checkInBrowser(ctx, { checkUrl: CHECK, timeoutMs: 8000, gatherMs: 3000 }));
  assert.equal(r.browser.ok, false);
  assert.match(r.browser.problem, /didn't load \(net::ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL|ERR_PROXY/);
  assert.equal(egressVerdict({ helper: { ok: true, ip: EXIT }, browser: r.browser }).verdict, "failed");
});
