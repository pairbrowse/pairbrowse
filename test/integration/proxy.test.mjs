// A proxied session in a real helper and browser (spec server-mode Phase C), as an agent uses it.
// Here: the DNS leak test (C12), and the rechecks of a running session's exit (C8, at the end). The helper starts with PAIRBROWSE_TEST_NETLOG=1, so the browser
// writes its NetLog into the test home (daemon/browser/launch.mjs withNetLog), and an agent opens a
// page whose names are new for each run: its own, an image's, a dns-prefetch, a preconnect, a
// prefetch, a WebSocket and a STUN server's. In strict mode, through an http: or a socks5: proxy,
// the browser looks up no name itself but the proxy's and loopback (the NetLog's resolver events,
// test/helpers/netlog.mjs), while the page and its parts still load through the proxy. The same
// page with strict switched off shows the browser looking its names up itself: the test sees a leak
// when there is one. Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { session } from "../helpers/live.mjs";
import { text, until } from "../helpers/util.mjs";
import { helperHome, startHelper } from "../helpers/daemon.mjs";
import { httpProxy, socks5Proxy, traceServer, stunResponder } from "../helpers/proxies.mjs";
import { readNetLog, resolvedHosts, dnsLeaks } from "../helpers/netlog.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const skip = (!runtime || process.platform === "win32") && "set PAIRBROWSE_TEST_RUNTIME";
const EXIT = "203.0.113.10", MOVED = "203.0.113.11", OWN = "198.51.100.20";

// A page server standing behind every proxy (the stubs send each connection here, whatever name
// they were asked for): the check address answers as the proxy's exit, every other path the page.
async function siteServer(page) {
  const asked = [];
  const server = createServer((req, res) => {
    // An HTTP proxy passes a plain http: request on as it came: its target in absolute form.
    const path = new URL(req.url, "http://any").pathname;
    asked.push(`${req.headers.host}${path}`);
    if (path === "/cdn-cgi/trace") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`ip=${EXIT}\nloc=US\n`);
    }
    res.writeHead(200, { "content-type": path === "/" ? "text/html" : "text/plain", "cache-control": "no-store" });
    res.end(path === "/" ? page : "ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, asked, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// The page's names, new for each run so no cache or earlier run answers for them.
function leakPage() {
  const id = randomBytes(4).toString("hex");
  const n = (part) => `${part}-${id}.test`;
  const names = { page: n("page"), img: n("img"), prefetchDns: n("dp"), preconnect: n("pc"), prefetch: n("pf"), ws: n("ws"), stun: n("stun") };
  const html = `<!doctype html><title>Leak test</title>
<link rel="dns-prefetch" href="//${names.prefetchDns}">
<link rel="preconnect" href="http://${names.preconnect}">
<link rel="prefetch" href="http://${names.prefetch}/next">
<img src="http://${names.img}/a.png" alt="">
<p id="done">loaded</p>
<script>
try { new WebSocket("ws://${names.ws}/"); } catch (e) {}
try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${names.stun}:3478" }] });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
} catch (e) {}
</script>`;
  return { id, names, html };
}

const stubs = [];
after(async () => { for (const s of stubs) await s.close().catch(() => {}); });

// One helper with a session on `proxy` (its config.json `network` entry, strict or not), an agent
// that opens the leak page, then the helper stopped (the browser closes and ends its NetLog).
// Returns { hosts, leaks, names, site, log } (log: daemon.log, for messages).
async function browseThrough({ scheme, strict }) {
  const { names, html } = leakPage();
  const site = await siteServer(html);
  const direct = await traceServer({ ip: OWN, loc: "DE" });
  const stun = await stunResponder({ mapped: OWN });
  const proxy = scheme === "socks5" ? await socks5Proxy({ upstream: site.port }) : await httpProxy({ upstream: site.port });
  stubs.push(site, direct, stun, proxy);
  const network = { proxies: { stub: { server: `${scheme}://127.0.0.1:${proxy.port}` } }, default: "stub", strict };
  const home = helperHome(runtime, { prefix: "pb-proxy-", config: { sessionPicker: false, network } });
  const env = {
    PAIRBROWSE_TEST_NETLOG: "1",
    PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: `http://trace-${randomBytes(3).toString("hex")}.test/cdn-cgi/trace`, directUrl: `http://127.0.0.1:${direct.port}/cdn-cgi/trace`, stun: `stun:127.0.0.1:${stun.port}`, ms: 15_000 }),
  };
  const daemonLog = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
  const h = await startHelper(home, { env });
  // The NetLog is complete once the browser has closed, so it is read after the helper stops; the
  // home (profile, NetLog) goes either way.
  try {
    try {
      const a = await session(h.socketPath, "p");
      try {
        const nav = await a.tool("browser_navigate", { url: `http://${names.page}/` }, 120_000);
        assert.ok(!nav.result?.isError, `the page opens through the proxy: ${text(nav).slice(0, 400)}\n${daemonLog().slice(-2000)}`);
        // The page's parts asked for through the proxy (the image, the WebSocket's tunnel).
        await until("the page's image through the proxy", () => site.asked.some((s) => s.startsWith(`${names.img}/`)), 20_000, 200);
        await new Promise((r) => setTimeout(r, 3000)); // the prefetches and the WebRTC gathering
      } finally {
        a.sock.destroy();
      }
    } finally {
      await h.stop();
    }
    const file = join(home, "netlog.json");
    assert.ok(existsSync(file), `the browser wrote its NetLog: ${daemonLog().slice(-1500)}`);
    const netlog = readNetLog(file);
    return { hosts: resolvedHosts(netlog), leaks: dnsLeaks(netlog, { proxyHost: "127.0.0.1" }), names, site, proxy, log: daemonLog() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

for (const scheme of ["http", "socks5"]) {
  test(`strict, through a ${scheme}: proxy: the page loads and the browser looks up no name itself (NetLog)`, { skip, timeout: 240_000 }, async () => {
    const r = await browseThrough({ scheme, strict: true });
    assert.ok(r.site.asked.includes(`${r.names.page}/`), `the page came through the proxy: ${JSON.stringify(r.site.asked)}`);
    if (scheme === "socks5") assert.ok(r.proxy.log.some((l) => l.atyp === 3 && l.host === r.names.page), "the name went to the SOCKS5 proxy as a name");
    else assert.ok(r.proxy.log.some((l) => l.target === `http://${r.names.page}/`), "the name went to the HTTP proxy");
    assert.ok(r.hosts.length > 0, "the NetLog has the resolver's events (the reader sees them)");
    assert.deepEqual(r.leaks, [], `no lookup outside the proxy: ${JSON.stringify(r.hosts)}`);
    assert.match(r.log, /network "stub" \(default, strict\)/, "the session ran strict");
  });
}

test("without strict the same page shows the browser's own lookups: the leak test sees a leak", { skip, timeout: 240_000 }, async () => {
  const r = await browseThrough({ scheme: "http", strict: false });
  assert.ok(r.site.asked.includes(`${r.names.page}/`), "the page still came through the proxy");
  assert.ok(r.leaks.length > 0, `local lookups: ${JSON.stringify(r.hosts)}`);
  const own = Object.values(r.names).filter((n) => r.leaks.includes(n));
  assert.ok(own.length > 0, `the page's own names among them: ${JSON.stringify(r.leaks)}`);
});

// The rechecks (C8), live: a helper with RECHECK_MS set reads the exit through the proxy again
// every 1.5 s. The proxy sends every connection to a trace echo whose answer the test changes, and
// hand-off messages go to a webhook here (Away on, as a person on a desktop would turn it on), so
// the test sees what the person is told and how often.

// The first SSE event called name on the live view's stream (the bars' and side panel's state).
async function sseEvent(url, name, ms = 15_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      for (const block of buf.split("\n\n").slice(0, -1)) {
        const m = block.match(/^event: (\S+)\ndata: ([\s\S]*)$/m);
        if (m && m[1] === name) return JSON.parse(m[2]);
      }
      buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    }
  } catch { /* timed out */ } finally { clearTimeout(timer); ac.abort(); }
  return null;
}

// A helper whose session runs through a stub http: proxy, its browser up, an agent connected and
// the live view's address known. Returns { trace, proxy, hooks, a, live, log, done }.
async function recheckedSession() {
  const trace = await traceServer({ ip: EXIT, loc: "US" });
  const direct = await traceServer({ ip: OWN, loc: "DE" });
  const stun = await stunResponder({ mapped: OWN });
  const proxy = await httpProxy({ upstream: trace.port });
  const hooks = [];
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { try { hooks.push(JSON.parse(body)); } catch { hooks.push({ unreadable: body }); } res.writeHead(204); res.end(); });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const hookStub = { close: () => new Promise((r) => { hook.closeAllConnections?.(); hook.close(() => r()); }) };
  stubs.push(trace, direct, stun, proxy, hookStub);
  const network = { proxies: { stub: { server: `http://127.0.0.1:${proxy.port}` } }, default: "stub" };
  const handoff = { enabled: true, away: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] };
  const home = helperHome(runtime, { prefix: "pb-recheck-", config: { sessionPicker: false, network, handoff } });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=http://127.0.0.1:${hook.address().port}/hook\n`, { mode: 0o600 });
  const env = {
    PAIRBROWSE_TEST_RECHECK_MS: "1500",
    PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: `http://trace-${randomBytes(3).toString("hex")}.test/cdn-cgi/trace`, directUrl: `http://127.0.0.1:${direct.port}/cdn-cgi/trace`, stun: `stun:127.0.0.1:${stun.port}`, ms: 5000 }),
  };
  const log = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
  const h = await startHelper(home, { env });
  let a = null;
  const done = async () => { a?.sock.destroy(); await h.stop(); rmSync(home, { recursive: true, force: true }); };
  try {
    a = await session(h.socketPath, "r");
    const nav = await a.tool("browser_navigate", { url: `http://page-${randomBytes(3).toString("hex")}.test/` }, 120_000);
    assert.ok(!nav.result?.isError, `the page opens through the proxy: ${text(nav).slice(0, 400)}\n${log().slice(-2000)}`);
    const live = text(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
    assert.ok(live, "the live view's address");
    return { trace, proxy, hooks, a, live, log, done };
  } catch (e) { await done(); throw e; }
}

test("rechecks: an egress change pauses agents and notifies once; a person's Resume lets them go", { skip, timeout: 240_000 }, async () => {
  const s = await recheckedSession();
  try {
    await new Promise((r) => setTimeout(r, 2500)); // at least one recheck that passes first
    assert.equal(s.hooks.length, 0, "nothing said while the exit holds");
    assert.equal((await sseEvent(`${s.live}events?panel=1`, "pause"))?.paused, false);
    s.trace.set({ ip: MOVED });
    await until("the network message", () => s.hooks.length > 0, 20_000, 200);
    const shown = await sseEvent(`${s.live}events?panel=1`, "pause");
    assert.deepEqual([shown?.paused, shown?.by], [true, "Proxy check"], "the bars show the agents paused by the proxy check");
    await new Promise((r) => setTimeout(r, 4000)); // more rechecks on the moved exit: no new change
    assert.equal(s.hooks.length, 1, `one message per change: ${JSON.stringify(s.hooks)}`);
    const [m] = s.hooks;
    assert.deepEqual({ event: m.event, network: m.network, change: m.change, paused: m.paused }, { event: "pairbrowse.network", network: "stub", change: "changed", paused: true });
    for (const ip of [EXIT, MOVED, OWN]) assert.ok(!JSON.stringify(m).includes(ip), "no address in the message");
    assert.equal((s.log().match(/exit address changed at its recheck; agents paused/g) || []).length, 1, "acted on once");
    // The next rechecks pass on the new exit (it is the baseline now), so status says when it last
    // checked; the agents stay held until a person resumes them.
    assert.match(text(await s.a.tool("pairbrowse_status", { kind: "claude", text: "Checking" })), /network "stub" \(strict\)/);
    assert.equal((await sseEvent(`${s.live}events?panel=1`, "pause"))?.paused, true, "still held");
    // A browser action waits until a person resumes, and then hears why it waited.
    const t = Date.now();
    const waits = s.a.tool("browser_press_key", { key: "Shift" }, 90_000);
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok((await fetch(`${s.live}pause`, { method: "POST", body: JSON.stringify({ paused: false }) })).ok);
    const r = text(await waits);
    assert.ok(Date.now() - t >= 2500, "the agent waited");
    assert.match(r, /paused by Proxy check, then resumed by/, r);
    assert.equal((await sseEvent(`${s.live}events?panel=1`, "pause"))?.paused, false);
  } finally { await s.done(); }
});

test("rechecks: proxy killed mid-session: agents paused, told once, nothing sent around it", { skip, timeout: 240_000 }, async () => {
  const s = await recheckedSession();
  try {
    const asked = s.trace.state.hosts.length;
    await s.proxy.close();
    await until("the network message", () => s.hooks.length > 0, 30_000, 200);
    const shown = await sseEvent(`${s.live}events?panel=1`, "pause");
    assert.deepEqual([shown?.paused, shown?.by], [true, "Proxy check"]);
    await new Promise((r) => setTimeout(r, 4000)); // more failing rechecks: the same run, said once
    assert.equal(s.hooks.length, 1, `one message per run of failures: ${JSON.stringify(s.hooks)}`);
    assert.deepEqual({ event: s.hooks[0].event, change: s.hooks[0].change, paused: s.hooks[0].paused }, { event: "pairbrowse.network", change: "failed", paused: true });
    assert.match(s.log(), /network: "stub" failed its recheck; agents paused/);
    const status = text(await s.a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.match(status, /network "stub" \(strict\) failed its recheck at \d\d:\d\d UTC: .*Agents were paused for it until a person resumes them\./, status);
    // The proxy down: nothing reached the exit's server without it (the stub was its only way there).
    assert.equal(s.trace.state.hosts.length, asked, "no request went around the proxy");
  } finally { await s.done(); }
});
