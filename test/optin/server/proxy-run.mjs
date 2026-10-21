// Proxies with a username and password on the native Linux build, the side that runs inside the
// A13 container (proxy-docker.test.mjs starts it there; spec server-mode C1, decision 9, step 49,
// engine patch 962). For an http: and a socks5: proxy that need a username and password (stubs
// from test/helpers/proxies.mjs, every connection sent to a local page server), a session in
// server mode on the helper's own virtual screen: the page loads through the proxy, which saw the
// right credentials (Basic on the request; RFC 1929 username/password on SOCKS5, the name sent as
// address type 3); the credentials reach no process's command line, no line of daemon.log and not
// the browser's NetLog; the auth file the helper wrote is gone once the browser is up; in strict
// mode the browser looks up no name itself (the NetLog's resolver events). Prints "RESULT <json>".
//
// /runtime: the pinned runtime; /cache: the pinned Linux build and engine pack (native-cache.mjs),
// installed first by native-linux.mjs.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { session } from "../../helpers/live.mjs";
import { sleep, text, until } from "../../helpers/util.mjs";
import { browserPid, logText, processes, sandboxOf, serverHome, signalHelper, startServerHelper } from "../../helpers/server.mjs";
import { httpProxy, socks5Proxy, traceServer, stunResponder } from "../../helpers/proxies.mjs";
import { readNetLog, resolvedHosts, dnsLeaks } from "../../helpers/netlog.mjs";
import { installNativeLinux } from "./native-linux.mjs";
import { MEASURING_BUSY } from "../../../scripts/daemon/browser/graphics.mjs";
import { GRAPHICS_STOP_MS, GRAPHICS_TIMEOUT_MS } from "../../../scripts/native/check.mjs";

const RUNTIME = "/runtime";
const EXIT = "203.0.113.10", OWN = "198.51.100.20";
const USER = `proxy-user-${randomBytes(3).toString("hex")}`, PASS = `proxy-pass-${randomBytes(6).toString("hex")}`;
const BASE64 = Buffer.from(`${USER}:${PASS}`).toString("base64");
const credentialIn = (s) => [PASS, BASE64].filter((v) => String(s).includes(v));
const result = { uid: userInfo().uid, user: USER.length, cases: {} };

// A page server behind every proxy: the check address answers as the proxy's exit, "/" the page.
async function siteServer(html) {
  const asked = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://any").pathname;
    asked.push(`${req.headers.host}${path}`);
    if (path === "/cdn-cgi/trace") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`ip=${EXIT}\nloc=US\n`); }
    res.writeHead(200, { "content-type": path === "/" ? "text/html" : "text/plain", "cache-control": "no-store" });
    res.end(path === "/" ? html : "ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, asked, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
// The page's names, new for each run.
function leakPage() {
  const id = randomBytes(4).toString("hex");
  const names = { page: `page-${id}.test`, img: `img-${id}.test`, prefetchDns: `dp-${id}.test`, ws: `ws-${id}.test` };
  const html = `<!doctype html><title>Proxy test</title><link rel="dns-prefetch" href="//${names.prefetchDns}"><img src="http://${names.img}/a.png" alt=""><p id="done">loaded</p><script>try { new WebSocket("ws://${names.ws}/"); } catch (e) {}</script>`;
  return { names, html };
}

const stubs = [];
const helpers = [];
const sockets = [];
try {
  const native = await installNativeLinux();
  result.native = native.version;
  for (const scheme of ["http", "socks5"]) {
    const out = result.cases[scheme] = {};
    const { names, html } = leakPage();
    const site = await siteServer(html);
    const direct = await traceServer({ ip: OWN, loc: "DE" });
    const stun = await stunResponder({ mapped: OWN });
    const auth = { username: USER, password: PASS };
    const proxy = scheme === "socks5" ? await socks5Proxy({ upstream: site.port, auth }) : await httpProxy({ upstream: site.port, auth });
    stubs.push(site, direct, stun, proxy);
    const network = { proxies: { stub: { server: `${scheme}://127.0.0.1:${proxy.port}`, auth: true } }, default: "stub", strict: true };
    const home = serverHome(RUNTIME, { prefix: `pb-proxyauth-${scheme}-`, executablePath: native.exe, config: { browserEngine: "pairbrowse", sessionPicker: false, network } });
    cpSync(native.engine, join(home, "engine"), { recursive: true });
    writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_PROXY_STUB_USERNAME=${USER}\nPAIRBROWSE_PROXY_STUB_PASSWORD=${PASS}\n`, { mode: 0o600 });
    const env = {
      PAIRBROWSE_TEST_NETLOG: "1",
      PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: `http://trace-${randomBytes(3).toString("hex")}.test/cdn-cgi/trace`, directUrl: `http://127.0.0.1:${direct.port}/cdn-cgi/trace`, stun: `stun:127.0.0.1:${stun.port}`, ms: 20_000 }),
    };
    const h = await startServerHelper(home, { env, ms: 180_000 });
    helpers.push(h.daemon);
    const s = await session(h.socketPath, scheme.slice(0, 1));
    sockets.push(s);
    const tool = async (name, args = {}, ms = 180_000) => {
      const deadline = Date.now() + GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS + 120_000;
      for (;;) {
        const r = await s.tool(name, args, ms);
        if (!text(r).includes(MEASURING_BUSY) || Date.now() > deadline) return r;
        await sleep(3000);
      }
    };
    const nav = await tool("browser_navigate", { url: `http://${names.page}/` });
    out.navigate = text(nav).slice(0, 600);
    out.navigateError = !!nav.result?.isError;
    try { await until("the page's image through the proxy", () => site.asked.some((a) => a.startsWith(`${names.img}/`)), 30_000, 200); } catch {}
    await sleep(3000);
    out.asked = site.asked.slice(0, 20);
    out.names = names;
    out.proxyLog = proxy.log.slice(0, 12).map((l) => ({ ...l, authorization: l.authorization ? "(sent)" : l.authorization }));
    out.authorized = proxy.log.filter((l) => l.authorized).length;
    out.commandLines = credentialIn(processes().map((p) => p.cmd).join("\n"));
    const runDir = join(home, "run");
    out.authFiles = (existsSync(runDir) ? readdirSync(runDir) : []).filter((f) => f.startsWith("proxy-auth-"));
    out.launchLine = (logText(home).match(/launch: network "stub" \([^)]*\)/) || [null])[0];
    out.status = text(await tool("pairbrowse_status", { kind: "claude", text: "Checking" })).slice(0, 1500);
    const pid = browserPid(h.daemon.pid);
    out.sandbox = pid ? sandboxOf(pid) : null;
    s.sock.destroy();
    out.stopped = await signalHelper(h.daemon, "SIGTERM");
    out.logCredentials = credentialIn(logText(home));
    const file = join(home, "netlog.json");
    out.netlog = existsSync(file);
    if (out.netlog) {
      const raw = readFileSync(file, "utf8");
      out.netlogCredentials = credentialIn(raw);
      const netlog = readNetLog(file);
      out.resolved = resolvedHosts(netlog).slice(0, 20);
      out.leaks = dnsLeaks(netlog, { proxyHost: "127.0.0.1" });
    }
    out.log = logText(home).split("\n").filter((l) => /network|proxy|launch:|refus/i.test(l)).slice(-15);
  }
} catch (e) {
  result.error = String(e?.stack || e);
} finally {
  for (const s of sockets) s.sock.destroy();
  for (const d of helpers) await signalHelper(d, "SIGTERM").catch(() => {});
  for (const s of stubs) await s.close().catch(() => {});
}
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
