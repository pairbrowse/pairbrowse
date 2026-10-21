// Server mode end to end, the side that runs inside the A13 container (end-to-end.test.mjs starts
// it there; spec server-mode sections 3 and 14): every phase in one session on the native Linux
// build with its sandbox on. It prints what it saw as one line "RESULT <json>" for the test to
// judge, and exits 0 unless the run itself could not start.
//
//   1  server mode with server.keepAlive on its own Xvfb (virtualScreen's size)
//   2  a PairBrowse profile export imported and an HTTP and a SOCKS5 proxy added through the
//      owner's routes (as Settings does), the HTTP one assigned to the session
//   3  the launch: the exit check through the proxy, DNS strict, graphics measured as software,
//      the profile's time zone and languages against the exit's (made up) country, diagnostics
//   4  a local challenge page handed to the person: webhook message, preview GET, Take over on a
//      390x844 touch viewer (its own requests), typing, Done; the waiting agent goes on in the same
//      tab with the same cookies
//   5  the browser killed, then the Xvfb: the same profile and proxy (checked again before the
//      tabs load), the tabs back, and the open hand-off reissued with the same deadline
//   6  card fields: the agent's typing refused, the person's typing in the hand-off, and nothing
//      card-shaped in a log, audit line, message or agent result
//
// /runtime: the pinned runtime; /engine: the engine pack; /cache: the pinned Linux build's archive.
// Homes are made under the container's temp folder. Every page is local and every proxy a stub.
import "../../helpers/home.mjs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { session } from "../../helpers/live.mjs";
import { sleep, text, until } from "../../helpers/util.mjs";
import { httpProxy, socks5Proxy, stunResponder, traceServer } from "../../helpers/proxies.mjs";
import { browserPid, logCount, logText, pidAlive, sandboxOf, screenRecord, serverHome, signalHelper, startServerHelper } from "../../helpers/server.mjs";
import { NATIVE } from "../../../scripts/native-pack.mjs";
import { exportProfile } from "../../../scripts/profiles/export.mjs";
import { profileDefaults } from "../../../scripts/profiles/schema.mjs";
import { MEASURING_BUSY } from "../../../scripts/daemon/browser/graphics.mjs";

const RUNTIME = "/runtime", ENGINE = "/engine", CACHE = "/cache";
const SHOP = "http://shop.pbtest.example";
const EXIT = "203.0.113.10", OWN = "198.51.100.20", EXIT_COUNTRY = "US";
// The card the person types (a test number: Luhn-valid, Visa prefix).
export const CARD = "4242424242424242";
const result = { uid: userInfo().uid, steps: {} };
const step = (n) => (result.steps[n] ||= {});
let at = "setup";

// --- The site, behind every proxy -------------------------------------------------------------

const ABS = (x, y, w, h) => `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box`;
const REPORT = `<script>const ev=(k,v="")=>fetch("/ev?"+new URLSearchParams({k,v:String(v)}),{cache:"no-store"});</script>`;
// Where the person taps, in page pixels.
export const AT = { answer: [150, 100], verify: [120, 165], card: [170, 100] };
const luhn = `const luhn=(d)=>{let s=0;for(let i=0;i<d.length;i++){let n=+d[d.length-1-i];if(i%2){n*=2;if(n>9)n-=9;}s+=n;}return d.length>0&&s%10===0;};`;
const PAGES = {
  "/login": () => `<!doctype html><title>Signed in</title><h1>Signed in as Ada</h1>`,
  // The challenge fixture: the site's own check, which only a person completes here.
  "/challenge": (c) => `<!doctype html><title>Check</title><body style="margin:0">${REPORT}
<h1 style="${ABS(20, 0, 600, 60)};margin:0;font-size:20px">Verify you are human</h1>
<form method="post" action="/challenge"><input id="answer" name="answer" aria-label="Answer" autocomplete="off" style="${ABS(20, 80, 300, 40)}">
<button id="verify" style="${ABS(20, 140, 200, 50)}">Verify</button></form>
<p style="${ABS(20, 220, 600, 40)}">cookies: ${c || "(none)"}</p>
<script>document.getElementById("answer").addEventListener("input",(e)=>ev("answer",e.target.value.length));ev("challenge","loaded");</script>`,
  "/cleared": (c) => `<!doctype html><title>Checked</title>${REPORT}<h1>Check passed</h1><p>cookies: ${c || "(none)"}</p><script>ev("cleared","loaded");</script>`,
  // A card form: what it holds is reported only as its length and whether it is a valid number.
  "/pay": () => `<!doctype html><title>Pay</title><body style="margin:0">${REPORT}
<h1 style="${ABS(20, 0, 600, 60)};margin:0;font-size:20px">Payment</h1>
<input id="cc" name="cardnumber" autocomplete="cc-number" inputmode="numeric" aria-label="Card number" style="${ABS(20, 80, 320, 40)}">
<input id="nm" name="ccname" autocomplete="cc-name" aria-label="Name on card" style="${ABS(20, 140, 320, 40)}">
<script>${luhn}const cc=document.getElementById("cc");cc.addEventListener("input",()=>{const d=cc.value.replace(/\\D/g,"");ev("card",d.length+":"+(luhn(d)?"ok":"no"));});ev("pay","loaded");</script>`,
  "/two": (c) => `<!doctype html><title>Two</title><h1>Second tab</h1><p>cookies: ${c || "(none)"}</p>`,
};

async function startSite() {
  const reports = [];
  const asked = [];
  const server = http.createServer((req, res) => {
    // An HTTP proxy passes a plain http: request on in absolute form.
    const url = new URL(req.url, "http://any");
    const host = String(req.headers.host || "").split(":")[0];
    asked.push(`${host}${url.pathname}`);
    const cookie = req.headers.cookie || "";
    if (url.pathname === "/cdn-cgi/trace") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`ip=${EXIT}\nloc=${EXIT_COUNTRY}\n`); }
    if (url.pathname === "/ev") {
      reports.push({ host, k: url.searchParams.get("k"), v: url.searchParams.get("v") });
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/challenge") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const ok = (new URLSearchParams(body).get("answer") || "").trim() === "blue";
        res.writeHead(303, { ...(ok ? { "set-cookie": "cleared=yes; Path=/; Max-Age=86400" } : {}), location: ok ? "/cleared" : "/challenge" });
        res.end();
      });
      return;
    }
    const headers = { "content-type": "text/html", "cache-control": "no-store" };
    if (url.pathname === "/login") headers["set-cookie"] = "sid=ada; Path=/; Max-Age=86400; HttpOnly";
    const page = PAGES[url.pathname];
    res.writeHead(page ? 200 : 404, headers);
    res.end(page ? page(cookie) : "not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, reports, asked,
    last: (k) => reports.filter((r) => r.k === k).at(-1)?.v ?? null,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

// The person's channel: a loopback webhook keeping every message, and every body as it came.
async function startWebhook() {
  const got = [], raw = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { raw.push(body); try { got.push(JSON.parse(body)); } catch { got.push({ unreadable: body }); } res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, raw, close: () => server.close() };
}
const turnsFrom = (hook, event) => hook.got.filter((m) => m.event === `pairbrowse.${event}`);

// --- The person's side: what the phone viewer (scripts/liveview-turn.js) sends ---------------

function request(link, method, path = "", body, headers = {}) {
  const u = new URL(path, link);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
function stream(viewUrl) {
  const u = new URL("events", viewUrl);
  return new Promise((resolve, reject) => {
    let t = "";
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      resolve({ status: res.statusCode, events: (name) => t.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))), close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}
// A phone at 390x844: its user agent and touch, as the landing page and viewer are asked for.
const PHONE = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" };
// The landing page twice (a link preview, then the person), the tap on Take over, the viewer's
// page and stream. input(events): one batch as the viewer sends it (run and seq, so a batch sent
// again after a dropped connection is not applied twice).
async function takeOver(link) {
  const previews = [];
  for (let i = 0; i < 2; i++) { const r = await request(link, "GET", "", undefined, PHONE); previews.push({ status: r.status, takeOver: /Take over/.test(r.text) }); }
  const r = await request(link, "POST", "redeem", {}, PHONE);
  if (r.status !== 200) throw new Error(`Take over: ${r.status} ${r.text}`);
  const view = new URL(JSON.parse(r.text).view, link).href;
  const again = (await request(link, "POST", "redeem", {}, PHONE)).status;
  const page = await request(view, "GET", "", undefined, PHONE);
  const s = await stream(view);
  await until("the hand-off's tab on screen", () => s.events("turn").at(-1)?.state === "on", 30_000, 100);
  const run = randomBytes(8).toString("hex"); // as the viewer names its page load
  let seq = 0;
  const send = (events, n = ++seq) => request(view, "POST", `input?run=${run}&seq=${n}`, events, PHONE);
  return { view, s, previews, again, viewerPage: { status: page.status, viewport: /width=device-width/.test(page.text) }, input: send, resend: (events) => send(events, seq) };
}
const tap = ([x, y]) => [
  { type: "mouse", action: "mouseMoved", x, y, button: "none", buttons: 0 },
  { type: "mouse", action: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
  { type: "mouse", action: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
];
const chars = (s) => [...s].map((c) => ({ type: "char", text: c, modifiers: 0 }));

// --- The native build, installed the way the helper installs it -------------------------------

function run(argv, env, ms = 1_800_000) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}
async function installNative() {
  // PB_INSTALL_HOME: a folder kept between runs (a developer's reruns); the install skips what is there.
  const home = process.env.PB_INSTALL_HOME || join(tmpdir(), "pb-e2e-install");
  mkdirSync(join(home, "downloads"), { recursive: true, mode: 0o700 });
  if (!existsSync(join(home, "runtime"))) symlinkSync(RUNTIME, join(home, "runtime"), "dir");
  if (!existsSync(join(home, "engine"))) cpSync(ENGINE, join(home, "engine"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ browser: "pairbrowse" }));
  if (!existsSync(join(home, "browser"))) cpSync(join(CACHE, NATIVE.linux.file), join(home, "downloads", NATIVE.linux.file));
  const script = `const { ensureNative } = await import("/repo/scripts/native/install.mjs"); const exe = await ensureNative((m) => process.stderr.write("install: " + m + "\\n")); console.log("EXE " + exe);`;
  const r = await run([process.execPath, "--input-type=module", "-e", script], { PAIRBROWSE_HOME: home });
  const exe = r.out.match(/^EXE (\S+)$/m)?.[1];
  if (r.code !== 0 || !exe || exe === "null") throw new Error(`the native build didn't install:\n${r.out.slice(-3000)}`);
  return { exe, engine: join(home, "engine") };
}

// --- Reading the helper's home ----------------------------------------------------------------

const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
// Every file of the helper's home but the browser's own storage (the profile folders, where the
// site's form data belongs to the person), the native build and the downloaded lists (the phishing
// list's numbers are not PairBrowse's writing): { path: text }.
function homeFiles(home) {
  const out = {};
  const skip = new Set([join(home, "profile"), join(home, "sessions", "work"), join(home, "sessions", "default"), join(home, "runtime"), join(home, "engine"), join(home, "browser"), join(home, "lists")]);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (skip.has(p)) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!existsSync(join(p, "Local State"))) walk(p); }
      else if (st.isFile() && st.size < 32 << 20) out[p.slice(home.length + 1)] = read(p);
    }
  };
  walk(home);
  return out;
}
// Card-shaped runs: 13 to 19 digits (spaces or dashes between), Luhn-valid.
export function cardShaped(s) {
  const found = [];
  for (const m of String(s).matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const d = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let n = Number(d[d.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    if (sum % 10 === 0 && /^(4|5[1-5]|2[2-7]|3[47]|6)/.test(d)) found.push(d);
  }
  return found;
}

// --- The run ----------------------------------------------------------------------------------

const site = await startSite();
const httpStub = await httpProxy({ upstream: site.port });
const socksStub = await socks5Proxy({ upstream: site.port });
const direct = await traceServer({ ip: OWN, loc: "DE" });
const stun = await stunResponder({ mapped: OWN });
const hook = await startWebhook();
const helpers = [];
const sockets = [];
const results = []; // every agent result's text, for step 6's scan
let home = null;

try {
  // The native build, installed and checked as the helper's install step does.
  at = "install";
  const native = await installNative();
  result.native = native.exe.replace(/^.*\/(browser|pairbrowse)/, "$1");

  const config = {
    browserEngine: "pairbrowse", server: { keepAlive: true },
    handoff: { enabled: true, grantMinutes: 30, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] },
    network: { strict: true },
  };
  home = serverHome(RUNTIME, { prefix: "pb-e2e-", executablePath: native.exe, config });
  cpSync(native.engine, join(home, "engine"), { recursive: true });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
  const env = {
    PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: "http://trace-e2e.test/cdn-cgi/trace", directUrl: `http://127.0.0.1:${direct.port}/cdn-cgi/trace`, stun: `stun:127.0.0.1:${stun.port}`, ms: 20_000 }),
    PAIRBROWSE_TEST_RELAUNCH_MS: "1000",
    PAIRBROWSE_TEST_RESUME_GRACE_MS: "600000",
  };

  // 1. Server mode, keep-alive, its own Xvfb.
  at = "1";
  const h = await startServerHelper(home, { env, ms: 180_000 });
  helpers.push(h.daemon);
  // keep-alive starts the browser with the helper, nobody connected (the first start per
  // runtime measures graphics first).
  await until("the browser started by itself", () => /browser started \(session /.test(logText(home)), 900_000, 500);
  const PARENT = 71001;
  const agent = async (name) => {
    const s = await session(h.socketPath, name, { pairbrowseParent: PARENT });
    sockets.push(s);
    const tool = async (t, args = {}, ms = 180_000) => {
      for (let i = 0; ; i++) {
        const r = await s.tool(t, args, ms);
        const said = text(r);
        results.push(said);
        if (!said.includes(MEASURING_BUSY) || i > 200) return r;
        await sleep(3000);
      }
    };
    return { ...s, tool };
  };
  let a = await agent("a");
  const rec = screenRecord(home);
  Object.assign(step(1), {
    screen: rec ? { display: rec.display, geometry: rec.geometry, alive: pidAlive(rec.pid) } : null,
    status: text(await a.tool("pairbrowse_status", { kind: "claude", text: "Setting up" })),
  });

  // The owner's live view address (its key), as Settings and the live view's owner page use it.
  const owner = text(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
  if (!owner) throw new Error("no live view address");
  const ownerHeaders = { origin: new URL(owner).origin };
  const ownerPost = async (path, body) => { const r = await request(owner, "POST", path, body, ownerHeaders); let j = null; try { j = JSON.parse(r.text); } catch {} return { status: r.status, json: j, text: r.text }; };

  // 2. A profile export imported; two proxies added, the HTTP one assigned.
  at = "2";
  const record = { ...profileDefaults(), name: "berlin-desk",
    locale: { languages: ["de-DE", "de", "en"], timezone: "Europe/Berlin", source: "set" },
    window: { width: 1200, height: 760 } };
  const exported = exportProfile({ schema: 1, id: "p-00000000000000e2", kind: "store", revision: 1, status: "active", created: "2026-10-21T08:00:00Z", engine: null, ...record }).text;
  const imported = await ownerPost(`profile-import?file=berlin-desk.json&source=${encodeURIComponent("my laptop")}&license=own-capture&name=imported`, exported);
  const profiles = await request(owner, "GET", "profiles.json", undefined, ownerHeaders);
  const add = [
    await ownerPost("network", { op: "add", id: "http-local", type: "http", host: "127.0.0.1", port: httpStub.port, auth: false }),
    await ownerPost("network", { op: "add", id: "socks-local", type: "socks5", host: "127.0.0.1", port: socksStub.port, auth: false }),
  ];
  const socksTest = await ownerPost("network", { op: "test", type: "socks5", host: "127.0.0.1", port: socksStub.port, auth: false });
  const assign = await ownerPost("network", { op: "session", session: "work", choice: "proxy", id: "http-local" });
  const summary = await request(owner, "GET", "network.json", undefined, ownerHeaders);
  Object.assign(step(2), {
    imported: { status: imported.status, ok: imported.json?.ok, name: imported.json?.name, format: imported.json?.format, error: imported.json?.error, items: imported.json?.items },
    listed: /"imported"/.test(profiles.text),
    added: add.map((r) => ({ status: r.status, text: r.json?.text || r.json?.error })),
    socksTest: { status: socksTest.status, verdict: socksTest.json?.verdict, exit: socksTest.json?.exit, country: socksTest.json?.exit?.country ?? null, coherence: (socksTest.json?.coherence || []).map((c) => c.id), error: socksTest.json?.error },
    assign: { status: assign.status, text: assign.json?.text || assign.json?.error },
    summary: summary.text,
  });

  // 3. The session on that profile and proxy: the launch checks.
  at = "3";
  const logMark = logText(home).length;
  const created = text(await a.tool("pairbrowse_session", { action: "new", name: "work", profile: "imported" }, 900_000));
  const nav = await a.tool("browser_navigate", { url: `${SHOP}/login` }, 300_000);
  const status3 = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Signed in" }));
  const launchLog = logText(home).slice(logMark);
  const observations = JSON.parse(read(join(home, "sessions", "work.network.json")) || "null");
  const diag = await request(owner, "GET", "diagnostics.json", undefined, ownerHeaders);
  const report = await request(owner, "POST", "diagnostics/report", {}, ownerHeaders);
  const pid = browserPid(h.daemon.pid);
  Object.assign(step(3), {
    created, navigate: text(nav).slice(0, 300), navigateError: !!nav.result?.isError, status: status3,
    launchLog: launchLog.split("\n").filter((l) => /launch: network|passed its check|failed its check|graphics|profile|browser started/i.test(l)).slice(-20),
    observations: observations?.checks || null,
    proxyAsked: httpStub.log.map((l) => l.target || l.host).filter(Boolean).slice(0, 40),
    socksAsked: socksStub.log.map((l) => l.host).slice(0, 20),
    siteAsked: site.asked.slice(0, 40),
    diagnostics: (() => { try { return JSON.parse(diag.text); } catch { return { unreadable: diag.status }; } })(),
    report: (() => { try { return JSON.parse(report.text).text; } catch { return `(${report.status})`; } })(),
    sandbox: pid ? sandboxOf(pid) : null,
  });

  // A second tab, then back to the first: the restore has two tabs to bring back.
  await a.tool("browser_tabs", { action: "new", url: `${SHOP}/two` });
  await a.tool("browser_tabs", { action: "select", index: 0 });

  // 4. The challenge page, handed to the person.
  at = "4";
  await a.tool("browser_navigate", { url: `${SHOP}/challenge` });
  await until("the challenge page", () => site.last("challenge"), 60_000, 200);
  const said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check for Ada with code hunter2", step: "captcha" }));
  const handed = said.match(/hand-off ([0-9a-f]{8}) for tab (\d+)/);
  const turn = await until("the webhook's message", () => turnsFrom(hook, "turn")[0], 30_000, 100);
  const p = await takeOver(turn.link);
  const waiting = a.tool("browser_wait_for", {}, 600_000);
  const sent = [];
  sent.push((await p.input(tap(AT.answer))).status);
  sent.push((await p.input(chars("blue"))).status);
  await until("the person's answer in the field", () => site.last("answer") === "4", 30_000, 100);
  // The same batch again (a phone whose answer was lost sends it once more): not typed twice.
  sent.push((await p.resend(chars("blue"))).status);
  await sleep(1000);
  const answerAfterResend = site.last("answer");
  sent.push((await p.input(tap(AT.verify))).status);
  await until("the check passed", () => site.last("cleared"), 60_000, 100);
  const done = await request(p.view, "POST", "turn-done", {}, PHONE);
  const waited = await waiting;
  p.s.close();
  const tabsAfter = text(await a.tool("browser_tabs", { action: "list" }));
  const snap4 = text(await a.tool("browser_snapshot"));
  Object.assign(step(4), {
    said, handed: handed ? { id: handed[1], tab: handed[2] } : null,
    message: turn, messageKeys: Object.keys(turn).sort(), previews: p.previews, secondRedeem: p.again, viewerPage: p.viewerPage,
    sent, answerAfterResend, done: done.status,
    waited: text(waited), waitedError: !!waited.result?.isError,
    current: tabsAfter.match(/^- (\d+): \(current\) \[[^\n]*\]\(([^)\s]*)\)/m)?.slice(1, 3) || null,
    cookies: snap4.match(/cookies: [^\n"]*/)?.[0] || null,
  });

  // 6 (first half). The card page: the agent may not type a card number.
  at = "6";
  await a.tool("browser_navigate", { url: `${SHOP}/pay` });
  await until("the card page", () => site.last("pay"), 60_000, 200);
  const snapPay = text(await a.tool("browser_snapshot"));
  const ref = snapPay.match(/"Card number"[^\n]*\[ref=(f?\d*e\d+)\]/)?.[1];
  const typed = await a.tool("browser_type", { target: ref, element: "Card number", text: "4242 4242 4242 4242" });
  const filled = await a.tool("browser_fill_form", { fields: [{ name: "Card number", type: "textbox", target: ref, value: CARD }] });
  await sleep(1000);
  Object.assign(step(6), {
    ref: !!ref, typeRefused: !!typed.result?.isError, typeSaid: text(typed).slice(0, 400),
    fillRefused: !!filled.result?.isError, fillSaid: text(filled).slice(0, 400), pageGot: site.last("card"),
  });
  const pay = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please pay with your card", step: "payment" }));
  const payTurn = await until("the payment hand-off's message", () => turnsFrom(hook, "turn")[1], 30_000, 100);
  step(6).handed = pay;

  // 5. The browser killed, then its Xvfb.
  at = "5";
  await sleep(2500); // the tabs file's debounce
  const kills = [];
  for (const what of ["browser", "xvfb"]) {
    const mark = logText(home).length;
    const turnsBefore = turnsFrom(hook, "turn").length;
    const started = logCount(home, /browser started \(session work\)/);
    const screenBefore = screenRecord(home);
    if (what === "browser") process.kill(browserPid(h.daemon.pid), "SIGKILL");
    else process.kill(screenBefore.pid, "SIGKILL");
    await until(`the browser back after the ${what} kill`, () => logCount(home, /browser started \(session work\)/) > started, 900_000, 500);
    await until(`its tabs back after the ${what} kill`, () => /restored \d+ tabs/.test(logText(home).slice(mark)), 300_000, 200);
    const replaced = await until(`the hand-off's new link after the ${what} kill`, () => turnsFrom(hook, "turn")[turnsBefore], 120_000, 200).catch(() => null);
    const after = logText(home).slice(mark);
    const screenAfter = screenRecord(home);
    kills.push({
      what,
      lines: after.split("\n").filter((l) => /ended by itself|closed by itself|browser closed|launch: network|passed its check|failed its check|restored \d+ tabs|browser started|replaced by|stopped safely|profile/i.test(l)).slice(-20),
      checkBeforeTabs: after.indexOf("passed its check at launch") >= 0 && after.indexOf("passed its check at launch") < after.search(/restored \d+ tabs/),
      network: /launch: network "http-local" \(session, strict\)/.test(after) || /launch: network "http-local"/.test(after),
      restored: after.match(/restored (\d+) tabs/)?.[1] || null,
      newScreen: what === "xvfb" ? !!(screenAfter && screenAfter.pid !== screenBefore.pid && pidAlive(screenAfter.pid)) : screenAfter?.pid === screenBefore.pid,
      replaced: replaced ? { id: replaced.id, expiresAt: replaced.expiresAt, kind: replaced.kind, host: replaced.host } : null,
    });
  }
  // The agent comes back (its app session's own), in its own tab.
  a = await agent("a2");
  const tabs5 = text(await a.tool("browser_tabs", { action: "list" }, 300_000));
  const status5 = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Back" }));
  Object.assign(step(5), {
    kills, original: { id: payTurn.id, expiresAt: payTurn.expiresAt },
    tabs: tabs5, status: status5,
    observations: (JSON.parse(read(join(home, "sessions", "work.network.json")) || "null")?.checks || []).map((c) => ({ kind: c.kind, proxy: c.proxy, dns: c.dns, verdict: c.verdict })),
  });

  // 6 (second half). The person pays in the hand-off; the agent waits and goes on.
  at = "6b";
  const latest = turnsFrom(hook, "turn").at(-1);
  const q = await takeOver(latest.link);
  const waiting6 = a.tool("browser_wait_for", {}, 600_000);
  const typedBy = [];
  typedBy.push((await q.input(tap(AT.card))).status);
  typedBy.push((await q.input(chars(CARD))).status);
  await until("the person's card number in the field", () => site.last("card") === "16:ok", 60_000, 100);
  const done6 = await request(q.view, "POST", "turn-done", {}, PHONE);
  const waited6 = await waiting6;
  q.s.close();
  const snap6 = text(await a.tool("browser_snapshot"));
  await sleep(2000); // the logs' and the journal's writes
  const files = homeFiles(home);
  const where = (s) => cardShaped(s).length > 0;
  Object.assign(step(6), {
    personTyped: typedBy, pageGotAfter: site.last("card"), done: done6.status,
    waited: text(waited6).slice(0, 600), waitedError: !!waited6.result?.isError,
    snapshotHasCard: where(snap6), snapshotSays: (snap6.match(/"Card number"[^\n]*/) || [""])[0].slice(0, 200),
    cardIn: {
      results: results.filter(where).map((r) => r.slice(0, 200)),
      messages: hook.raw.filter(where).length,
      files: Object.entries(files).filter(([, t]) => where(t)).map(([f]) => f),
      logsRead: ["daemon.log", "audit.jsonl"].filter((f) => f in files),
    },
    filesScanned: Object.keys(files).length,
  });
  result.audit = read(join(home, "audit.jsonl")).split("\n").filter(Boolean).map((l) => { try { const j = JSON.parse(l); return j.kind || j.event || "?"; } catch { return "unreadable"; } });
  result.messages = hook.got.map((m) => ({ event: m.event, kind: m.kind, host: m.host, expiresAt: m.expiresAt, reason: m.reason, keys: Object.keys(m).sort().join(",") }));
} catch (e) {
  result.error = `at step ${at}: ${String(e?.stack || e)}`;
  result.site = { reports: site.reports.slice(-40), asked: site.asked.slice(-40) };
  result.said = results.slice(-12).map((r) => r.slice(0, 400));
}
if (home) result.log = logText(home).slice(-6000);
try {
  for (const s of sockets) s.sock.destroy();
  for (const d of helpers) if (!(await signalHelper(d, "SIGTERM", 30_000))) await signalHelper(d, "SIGKILL");
} catch {}
for (const s of [site, httpStub, socksStub, direct, stun, hook]) { try { await s.close(); } catch {} }
if (home) rmSync(home, { recursive: true, force: true });
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
