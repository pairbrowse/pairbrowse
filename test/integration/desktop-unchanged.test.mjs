// Nothing changed for a desktop user (spec server-mode sections 3 and 14, decision 8): the native
// build on this Mac, in a helper home of the test's own, as a person at the computer runs it.
//   1  no server mode: no virtual screen, no keep-alive, a real window (not hidden), the sandbox on
//   2  a hand-off with no channel set: the step is done in the PairBrowse window (the bar and the
//      side panel say "your turn", the person acts in the tab) and the agent goes on; no grant, no
//      message, no link
//   3  a channel set, Away off: as 2; Away on (the owner's switch, as Settings and the side panel
//      send it): the message and link go out and the step can still be done in the window;
//      whichever the person uses first completes it (the window, then the phone's Done); Away off
//      again: window only
//   4  this Mac's host profile is captured (once, kept 0600 in the test's home) and the GPU pages
//      and the measurement name is this Mac's own, never a software renderer
//   5  a proxy assigned to one session only: that session goes through it, the other stays direct
// Every page is local (a fixture the test person completes), every proxy a stub. Needs macOS,
// PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE (copied into the test's home) and
// PAIRBROWSE_TEST_EXECUTABLE (the native build's Contents/MacOS/pairbrowse). It opens a real window.
import "../helpers/home.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";
import { attachDaemon } from "../helpers/live.mjs";
import { httpProxy, stunResponder, traceServer } from "../helpers/proxies.mjs";
import { nativeManifest, MEASURING } from "../../scripts/native-engine.mjs";
import { MEASURING_BUSY, MEASURING_GRAPHICS } from "../../scripts/daemon/browser/graphics.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const exe = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const native = (() => { try { return !!(runtime && engine && exe && nativeManifest(exe).version); } catch { return false; } })();
const SKIP = process.platform !== "darwin" ? "macOS only" : !native ? "set PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE (a native build for macOS)" : false;

const SHOP = "http://shop.pbtest.example";
const EXIT = "203.0.113.10", OWN = "198.51.100.20";

// --- The site ---------------------------------------------------------------------------------

const REPORT = `<script>const ev=(k,v="")=>fetch("/ev?"+new URLSearchParams({k,v:String(v)}),{cache:"no-store"});</script>`;
const PAGES = {
  // What the page reads of its screen, window and graphics: "probe: {json} end".
  "/size": () => `<!doctype html><title>Size</title><p id=s>probe: waiting</p><script>
(async () => {
  const o = { sw: screen.width, sh: screen.height, iw: innerWidth, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio, visible: document.visibilityState };
  try { const gl = document.createElement("canvas").getContext("webgl"); const d = gl && gl.getExtension("WEBGL_debug_renderer_info"); o.webgl = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : null); } catch (e) { o.webgl = "error " + e.message; }
  try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); o.webgpu = a ? { vendor: a.info?.vendor || "", architecture: a.info?.architecture || "", description: a.info?.description || "" } : null; } catch (e) { o.webgpu = "error " + e.message; }
  document.getElementById("s").textContent = "probe: " + JSON.stringify(o) + " end";
})();
</script>`,
  // The site's own check, a local fixture only the test person completes: once the right answer is
  // in the field the page sends it by itself (as many checks do), and moves on.
  "/challenge": () => `<!doctype html><title>Check</title><body>${REPORT}
<h1>Verify you are human</h1>
<form id=f method=post action="/challenge"><input id=answer name=answer aria-label="Answer" autocomplete=off style="position:absolute;left:20px;top:100px;width:300px;height:40px"></form>
<script>const a=document.getElementById("answer");a.addEventListener("input",()=>{ev("answer",a.value.length);ev("value",a.value);if(a.value==="blue")document.getElementById("f").submit();});ev("challenge","loaded");</script>`,
  "/cleared": () => `<!doctype html><title>Checked</title>${REPORT}<h1>Check passed</h1><p><a href="/account">Continue to your account</a></p><script>ev("cleared","loaded");</script>`,
  "/account": () => `<!doctype html><title>Account</title>${REPORT}<h1>Your account</h1><script>ev("account","loaded");</script>`,
  "/page": () => `<!doctype html><title>Page</title><h1>A page</h1>`,
};

async function startSite() {
  const reports = [], asked = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://any");
    const host = String(req.headers.host || "").split(":")[0];
    asked.push(`${host}${url.pathname}`);
    if (url.pathname === "/cdn-cgi/trace") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`ip=${EXIT}\nloc=US\n`); }
    if (url.pathname === "/ev") {
      reports.push({ host, k: url.searchParams.get("k"), v: url.searchParams.get("v") });
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/challenge") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => { res.writeHead(303, { location: new URLSearchParams(body).get("answer") === "blue" ? "/cleared" : "/challenge" }); res.end(); });
      return;
    }
    const page = PAGES[url.pathname];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(page ? page() : "not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, reports, asked,
    last: (k) => reports.filter((r) => r.k === k).at(-1)?.v ?? null,
    count: (k) => reports.filter((r) => r.k === k).length,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

// The person's channel: a loopback webhook keeping every message.
async function startWebhook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { try { got.push(JSON.parse(body)); } catch { got.push({ unreadable: body }); } res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => { server.closeAllConnections?.(); server.close(); } };
}

function request(base, method, path = "", body, headers = {}) {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname + u.search, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch {} resolve({ status: res.statusCode, text: t, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- This Mac -------------------------------------------------------------------------------------

// Every process: { pid, ppid, cmd }.
function processes() {
  return execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}
function descendants(pid, all = processes()) {
  const found = [];
  for (let gen = [pid]; gen.length;) {
    const next = all.filter((p) => gen.includes(p.ppid));
    found.push(...next);
    gen = next.map((p) => p.pid);
  }
  return found;
}
// The browser the helper started: its child running the native build, not one of its helpers.
const browserOf = (helperPid) => processes().find((p) => p.ppid === helperPid && p.cmd.startsWith(exe) && !/--type=/.test(p.cmd)) || null;
// The GPU this Mac has, as the system names it ("Apple M2 Pro").
function macGpus() {
  const j = JSON.parse(execFileSync("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8" }));
  return (j.SPDisplaysDataType || []).map((d) => String(d.sppci_model || d._name || "")).filter(Boolean);
}
// The main screen's size in points.
function macScreen() {
  const script = 'ObjC.import("AppKit"); const f = $.NSScreen.screens.objectAtIndex(0).frame; JSON.stringify({ width: f.size.width, height: f.size.height })';
  return JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }));
}
// Whether the process is a regular app in the window server's list (a window and a Dock icon),
// as lsappinfo says ("Foreground"); a hidden browser is not.
function appType(pid) {
  try {
    const asn = execFileSync("/usr/bin/lsappinfo", ["find", `pid=${pid}`], { encoding: "utf8" }).match(/ASN:0x[0-9a-f]+-0x[0-9a-f]+-/i)?.[0];
    return asn ? execFileSync("/usr/bin/lsappinfo", ["info", "-only", "ApplicationType", asn], { encoding: "utf8" }).match(/"ApplicationType"="([^"]*)"/)?.[1] || "" : "";
  } catch { return ""; }
}

// --- The helper -----------------------------------------------------------------------------------

let site, hook, proxy, direct, stun, home, h = null;
const env = () => ({ PAIRBROWSE_TEST_FILL: "1", PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: `http://trace-${randomBytes(3).toString("hex")}.test/cdn-cgi/trace`, directUrl: `http://127.0.0.1:${direct.port}/cdn-cgi/trace`, stun: `stun:127.0.0.1:${stun.port}`, ms: 20_000 }) });
const logText = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
const why = () => `\n--- daemon.log ---\n${logText().slice(-4000)}`;
const configOf = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

// config.json as a person's desktop has it: the native build, headed (no --headless, no display
// or server keys), the mock keychain every test launch uses, the local site's names.
function writeConfig(extra = {}) {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executablePath: exe, browserEngine: "pairbrowse", sessionPicker: false, screenshots: false,
    browserArgs: ["--use-mock-keychain", "--password-store=basic", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${site.port}`],
    ...extra,
  }));
}

// The helper started, an agent connected, its first page open (the first start captures this Mac
// and measures graphics; calls are refused meanwhile and retried, as the refusal says).
async function startHelper() {
  const daemon = spawnDaemon(home, { env: env() });
  const socketPath = join(home, "run", "browser.sock");
  (await attachDaemon({ socketPath, daemon, home, ms: 120_000 })).destroy();
  const agent = await session(socketPath, `d${randomBytes(2).toString("hex")}`);
  const tool = async (name, args = {}, ms = 600_000) => {
    for (let i = 0; ; i++) {
      const r = await agent.tool(name, args, ms);
      if (!text(r).includes(MEASURING_BUSY) || i > 200) return r;
      await sleep(3000);
    }
  };
  h = { daemon, socketPath, agent: { ...agent, tool } };
  const owner = text(await tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
  assert.ok(owner, "the owner's live view address");
  h.owner = owner;
  h.get = (path) => request(owner, "GET", path, undefined, { origin: new URL(owner).origin });
  h.post = (path, body) => request(owner, "POST", path, body, { origin: new URL(owner).origin });
  return h;
}
async function stopHelper() {
  if (!h) return;
  h.agent.sock.destroy();
  await stopDaemon(h.daemon, 30_000);
  h = null;
}

const currentUrl = async () => text(await h.agent.tool("browser_tabs", { action: "list" })).match(/^- \d+: \(current\) \[[^\n]*\]\(([^)\s]*)\)/m)?.[1];
const refOf = (snap, name) => snap.match(new RegExp(`"${name}"[^\\n]*\\[ref=(f?\\d*e\\d+)\\]`))?.[1];
// The person in the window: types the answer into the tab's field (a field set as a person
// would, PAIRBROWSE_TEST_FILL), and the page moves on.
const personAnswers = async (url) => text(await h.agent.tool("pairbrowse_test_fill", { url, selector: "#answer", value: "blue" }));
// The person in the window through the desktop app's live view (the owner's), its own input
// path, outside the agents' queue (an agent's wait or run holds that, and one connection's calls
// run one after another): a click into the field, then the answer typed.
const personTypesInLiveView = async () => {
  // The live view on screen (its stream open: the picture its input is placed in), showing the tab.
  const u = new URL("events", h.owner);
  let heard = "";
  const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { origin: u.origin } }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => { heard = (heard + d).slice(-4000); }); });
  req.on("error", () => {});
  try {
    // The stream up and following the tab on screen (a frame kept from an earlier stream may be stale).
    await until("the live view's stream", () => /event: tabs\n/.test(heard), 20_000, 100);
    await sleep(1500);
    const frame = await until("the live view's picture", async () => (await h.get("state.json")).json?.frame, 20_000, 200);
    return await typeInto(frame);
  } finally { req.destroy(); }
};
const typeInto = async (frame) => {
  // The live view's coordinates are its picture's pixels: the page's CSS pixels times the picture's scale.
  const k = frame?.w && probe?.iw ? frame.w / probe.iw : 1;
  const at = { x: Math.round(170 * k), y: Math.round(120 * k) };
  const batch = [
    { type: "mouse", action: "mouseMoved", ...at, button: "none", buttons: 0 },
    { type: "mouse", action: "mousePressed", ...at, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouse", action: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: 1 },
    ..."blue".split("").map((c) => ({ type: "char", text: c, modifiers: 0 })),
  ];
  return (await h.post("input", batch)).status;
};
const turnsOf = (event) => hook.got.filter((m) => m.event === `pairbrowse.${event}`);
const audit = () => { try { return readFileSync(join(home, "audit.jsonl"), "utf8"); } catch { return ""; } };
// The bar's state (the live view's status) and the side panel's Hand-offs.
const barStatus = async () => (await h.get("state.json")).json?.status || null;
const handoffItems = async () => (await h.get("handoffs.json")).json?.items || [];

before(async () => {
  if (SKIP) return;
  site = await startSite();
  hook = await startWebhook();
  proxy = await httpProxy({ upstream: site.port });
  direct = await traceServer({ ip: OWN, loc: "DE" });
  stun = await stunResponder({ mapped: OWN });
  const base = testBase();
  mkdirSync(base, { recursive: true });
  home = mkdtempSync(join(base, "pb-desk-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  cpSync(engine, join(home, "engine"), { recursive: true });
  writeConfig();
  await startHelper();
});

after(async () => {
  if (SKIP) return;
  await stopHelper().catch(() => {});
  for (const s of [site, hook, direct, stun]) { try { s?.close(); } catch {} }
  try { await proxy?.close(); } catch {}
  if (home) rmSync(home, { recursive: true, force: true });
});

// --- 1 and 4: the launch ------------------------------------------------------------------------

let probe = null;
test("1: no server mode: no virtual screen, a real window, the sandbox on", { skip: SKIP, timeout: 900_000 }, async () => {
  try {
    const nav = await h.agent.tool("browser_navigate", { url: `${SHOP}/size` });
    assert.ok(!nav.result?.isError, text(nav).slice(0, 400));
    await h.agent.tool("browser_wait_for", { text: " end" });
    const m = /probe: (\{.*?\}) end/s.exec(text(await h.agent.tool("browser_snapshot")));
    assert.ok(m, "the page said what it reads");
    probe = JSON.parse(m[1].replace(/\\"/g, '"'));

    // No server mode: no virtual screen record, no Xvfb, no keep-alive, no "Server".
    assert.ok(!existsSync(join(home, "run", "Xauthority.json")), "no virtual screen of the helper's own");
    const tree = descendants(h.daemon.pid);
    assert.ok(!tree.some((p) => /(^|\/)Xvfb(\s|$)/.test(p.cmd)), "no Xvfb");
    const status = text(await h.agent.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.doesNotMatch(status, /virtual screen|keep-alive|Server/i, status);
    assert.doesNotMatch(status, /sandbox is off|sandbox stays on/i, "no sandbox warning");
    assert.doesNotMatch(logText(), /server mode|virtual screen|keep-alive/i, "the log names no server mode");

    // A real window: no --headless, an app with a window on this Mac's own screen.
    const browser = browserOf(h.daemon.pid);
    assert.ok(browser, `the native build runs under the helper: ${tree.map((p) => p.cmd.slice(0, 120)).join("\n")}`);
    assert.doesNotMatch(browser.cmd, /--headless/, "headed");
    assert.equal(appType(browser.pid), "Foreground", "a regular app with a window");
    const real = macScreen();
    assert.deepEqual([probe.sw, probe.sh], [real.width, real.height], `the page reads this Mac's screen: ${JSON.stringify(probe)} vs ${JSON.stringify(real)}`);
    assert.ok(probe.ow > 0 && probe.oh > 0, "the window has a size");

    // The sandbox: no switch turns it off anywhere, and every renderer runs under the seatbelt.
    const kids = descendants(browser.pid);
    assert.ok(![browser, ...kids].some((p) => /--no-sandbox(\s|=|$)/.test(p.cmd)), "no --no-sandbox");
    const renderers = kids.filter((p) => /--type=renderer/.test(p.cmd));
    assert.ok(renderers.length > 0, "renderers run");
    assert.ok(renderers.every((p) => /--seatbelt-client=\d+/.test(p.cmd)), `every renderer sandboxed: ${renderers.map((p) => p.cmd.slice(0, 160)).join("\n")}`);
  } catch (e) { throw new Error(`${e.message}${why()}`, { cause: e }); }
});

test("4: this Mac's host profile is captured and the GPU is the real one", { skip: SKIP, timeout: 300_000 }, async (t) => {
  try {
    assert.ok(probe, "test 1 read the page");
    const gpus = macGpus();
    assert.ok(gpus.length, "system_profiler names a GPU");
    const ours = (s) => gpus.some((g) => String(s || "").includes(g));
    const log = logText();
    assert.ok(log.includes(MEASURING), "the first start captured this Mac");

    // The capture, kept in the test's home, private, with this Mac's GPU in it.
    const file = join(home, "mac-host-profile.json");
    assert.ok(existsSync(file), "the capture is kept");
    assert.equal(statSync(file).mode & 0o777, 0o600, "0600");
    const kept = JSON.parse(readFileSync(file, "utf8"));
    const keptText = JSON.stringify(kept.profile?.webgl ?? {});
    assert.ok(ours(keptText), `the capture's WebGL names this Mac's GPU (${gpus.join(", ")}): ${keptText.slice(0, 400)}`);
    assert.doesNotMatch(keptText, /swiftshader|llvmpipe|software/i, "never a software renderer");

    // What pages read: WebGL names this Mac's GPU.
    assert.ok(ours(probe.webgl), `the page's WebGL names this Mac's GPU (${gpus.join(", ")}): ${probe.webgl}`);
    assert.doesNotMatch(String(probe.webgl), /swiftshader|llvmpipe|software/i);

    // The measurement (spec E4): taken once, hardware, the browser process's own renderer.
    assert.ok(log.includes(MEASURING_GRAPHICS), "graphics measured once for this browser version");
    assert.match(log, /graphics: hardware, WebGL 2/, `measured as hardware: ${log.match(/graphics: [^\n]*/g)?.join(" | ")}`);
    const diag = await h.get("diagnostics.json");
    assert.equal(diag.status, 200, diag.text);
    const said = JSON.stringify(diag.json);
    assert.doesNotMatch(said, /"kind":"software"/, `diagnostics: ${said.slice(0, 1500)}`);
    assert.match(said, /hardware/, `diagnostics say hardware: ${said.slice(0, 1500)}`);
    // WebGPU before patch 961: reported as the page reads it, diagnostic only.
    t.diagnostic(`WebGPU in the page: ${JSON.stringify(probe.webgpu)}; GPU ${gpus.join(", ")}; graphics line: ${log.match(/graphics: [^\n]*/)?.[0]}`);
    t.diagnostic(`diagnostics graphics: ${said.slice(0, 600)}`);
    // The profile's validation for this build: every rule that didn't match, named.
    const dir = join(home, "browser-profiles");
    const all = readdirSync(dir).filter((f) => /^p-[0-9a-f]{16}\.json$/.test(f)).flatMap((f) => Object.values(JSON.parse(readFileSync(join(dir, f), "utf8")).validation || {}).flatMap((v) => v.items || []));
    const off = all.filter((i) => ["mismatch", "unsupported", "not-applied"].includes(i.status));
    t.diagnostic(`validation not matched: ${off.map((i) => `${i.rule} ${i.status}: ${i.reason}`).join(" | ") || "none"}`);
    const rule = (id) => all.find((i) => i.rule === id)?.status;
    assert.equal(rule("webgl.strings-vs-backend"), "matched", "pages' WebGL strings are the browser's own renderer");
    assert.equal(rule("sandbox.on"), "matched", "measured with the sandbox on");
    // Before patch 961 the only allowed mismatch is WebGPU's limits (spec section 14, Phase E:
    // "or reported as a mismatch until patch 961 ships").
    const before961 = (i) => /^webgpu\./.test(i.rule) && /limit/i.test(i.reason || "");
    assert.deepEqual(off.filter((i) => !before961(i)).map((i) => `${i.rule}: ${i.reason}`), [], "nothing else is off");
  } catch (e) { throw new Error(`${e.message}${why()}`, { cause: e }); }
});

// --- 2: no channel ------------------------------------------------------------------------------

test("2: a hand-off with no channel set is done in the window and the agent goes on; no grant, message or link", { skip: SKIP, timeout: 300_000 }, async () => {
  try {
    const a = h.agent;
    assert.ok(!(await a.tool("browser_navigate", { url: `${SHOP}/challenge` })).result?.isError);
    const said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check", step: "captcha" }));
    assert.doesNotMatch(said, /hand-off [0-9a-f]{8}|Your turn sent|channel|https?:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}/i, said);
    // The bar and the side panel say it's the person's turn.
    assert.equal((await barStatus())?.kind, "you", "the bar says your turn");
    const items = await handoffItems();
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.equal(items[0].kind, "captcha");
    // Nothing refused in the window-only case: reading works, the tab is the agent's to leave alone.
    assert.match(text(await a.tool("browser_snapshot")), /Verify you are human/);

    // The person answers in the tab; the agent waits for the next page as the skill says.
    assert.equal(await personAnswers(`${SHOP}/challenge`), "filled");
    let seen = "";
    for (let i = 0; i < 10 && !/Check passed/.test(seen); i++) seen = text(await a.tool("browser_wait_for", { text: "Check passed" }));
    assert.match(seen, /"Check passed" is on the page/, seen);
    const snap = text(await a.tool("browser_snapshot"));
    const next = refOf(snap, "Continue to your account");
    assert.ok(next, snap.slice(0, 600));
    const clicked = await a.tool("browser_click", { target: next, element: "Continue to your account" });
    assert.ok(!clicked.result?.isError, text(clicked));
    await until("the account page", () => site.last("account"), 20_000, 100);
    assert.notEqual((await barStatus())?.kind, "you", "the agent's click took the badge down");

    // A fast-mode hand-off step the same way: done in the window, the run goes on.
    assert.ok(!(await a.tool("browser_navigate", { url: `${SHOP}/challenge` })).result?.isError);
    const run = a.tool("pairbrowse_run", { steps: [{ handoff: { say: "Please complete the check", until: "Check passed" } }] }, 300_000);
    await until("the run's hand-off in the side panel", async () => (await handoffItems()).length === 1, 30_000, 300);
    // The run holds the agents' queue while it waits, so the person types through the live view.
    assert.equal(await personTypesInLiveView(), 204);
    await until("the person's answer in the field", () => site.last("answer") === "4", 30_000, 100);
    await until("the page moved on", () => site.count("cleared") >= 2, 30_000, 100).catch((e) => { throw new Error(`${e.message}: field ${JSON.stringify(site.last("value"))}, asked ${site.asked.slice(-8).join(" ")}; ${JSON.stringify(site.reports.slice(-6))}`); });
    const ran = await run;
    assert.ok(!ran.result?.isError, text(ran));
    assert.equal((await handoffItems()).length, 0, "the side panel's entry went");

    // No grant, no message, no link, no tunnel.
    assert.doesNotMatch(audit(), /"kind":"(minted|notified|redeemed)"/, "no grant");
    assert.deepEqual(hook.got, [], "no message");
    assert.ok(!descendants(h.daemon.pid).some((p) => /cloudflared/.test(p.cmd)), "no public link: no tunnel");
    assert.doesNotMatch(logText(), /hand-off [0-9a-f]{8}|tunnel/i);
  } catch (e) { throw new Error(`${e.message}${why()}`, { cause: e }); }
});

// --- 3: a channel, the Away switch ----------------------------------------------------------------

test("3: Away on sends the message and link and the window still completes the step; whichever comes first; Away off is window only again", { skip: SKIP, timeout: 600_000 }, async () => {
  try {
    // The channel set up (config.json handoff and its secret), the helper started again on it.
    await stopHelper();
    writeConfig({ handoff: { enabled: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] } });
    writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
    await startHelper();
    const a = h.agent;

    // A channel, Away off (its default): window only.
    assert.equal((await h.get("config.json")).json?.away?.on, false, "Away is off by default");
    assert.ok(!(await a.tool("browser_navigate", { url: `${SHOP}/challenge` })).result?.isError);
    let said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check", step: "captcha" }));
    assert.doesNotMatch(said, /hand-off [0-9a-f]{8}|Your turn sent/, said);
    await sleep(1500);
    assert.deepEqual(turnsOf("turn"), [], "Away off: no message");
    text(await a.tool("pairbrowse_status", { kind: "claude", text: "Back" }));

    // Away on, as the side panel's switch sends it: remembered in config.json.
    const on = await h.post("config", { away: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json?.away?.on, true, on.text);
    assert.equal(configOf().handoff?.away, true, "remembered");

    // (a) The window first: the message and link go out, the person answers in the window, and the
    // agent waiting as told (browser_wait_for with nothing named) hears the hand-off ended.
    said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check", step: "captcha" }));
    assert.match(said, /Your turn sent \(webhook\): hand-off ([0-9a-f]{8}) for tab \d+/, said);
    const id = said.match(/hand-off ([0-9a-f]{8})/)[1];
    const turn = await until("the webhook's message", () => turnsOf("turn")[0], 20_000, 100);
    assert.equal(turn.id, id);
    assert.match(turn.link, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/, "a private link, never a public one");
    assert.equal((await barStatus())?.kind, "you", "the bar says your turn too");
    assert.equal((await handoffItems()).length, 1, "and the side panel");
    const startedAt = Date.now();
    const cleared = site.count("cleared");
    const waiting = a.tool("browser_wait_for", {}, 300_000);
    await sleep(1000);
    assert.equal(await personTypesInLiveView(), 204);
    await until("the check passed in the window", () => site.count("cleared") > cleared, 20_000, 100);
    const waited = await waiting;
    const tookMs = Date.now() - startedAt;
    assert.ok(!waited.result?.isError, text(waited));
    assert.match(text(waited), new RegExp(`hand-off ${id} ended`), `the wait hears the step was done in the window: ${text(waited)}`);
    assert.ok(tookMs < 60_000, `the wait ended with the step, not at its two minutes: ${tookMs} ms`);
    const landing = await request(turn.link, "GET");
    assert.doesNotMatch(landing.text, /Take over/, "the phone's link is over");
    await until("the phone hears it ended", () => turnsOf("ended").some((m) => m.id === id), 20_000, 100);
    const snap = text(await a.tool("browser_snapshot"));
    const next = refOf(snap, "Continue to your account");
    const clicked = await a.tool("browser_click", { target: next, element: "Continue to your account" });
    assert.ok(!clicked.result?.isError, `the agent's hands are back: ${text(clicked)}`);
    text(await a.tool("pairbrowse_status", { kind: "claude", text: "Back" }));

    // (b) The phone first: Take over and Done end it; the waiting agent goes on.
    assert.ok(!(await a.tool("browser_navigate", { url: `${SHOP}/challenge` })).result?.isError);
    said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check", step: "captcha" }));
    const id2 = said.match(/hand-off ([0-9a-f]{8})/)?.[1];
    assert.ok(id2, said);
    const turn2 = await until("the second message", () => turnsOf("turn").find((m) => m.id === id2), 20_000, 100);
    const waiting2 = a.tool("browser_wait_for", {}, 300_000);
    const r = await request(turn2.link, "POST", "redeem", {});
    assert.equal(r.status, 200, r.text);
    const view = new URL(r.json.view, turn2.link).href;
    assert.equal((await request(view, "POST", "turn-done", {})).status, 200);
    const waited2 = await waiting2;
    assert.match(text(waited2), new RegExp(`hand-off ${id2} ended \\(done\\)`), text(waited2));
    text(await a.tool("pairbrowse_status", { kind: "claude", text: "Back" }));

    // Away off again: window only.
    const off = await h.post("config", { away: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(configOf().handoff?.away, false);
    const before = hook.got.length;
    said = text(await a.tool("pairbrowse_status", { kind: "you", text: "Please complete the check", step: "captcha" }));
    assert.doesNotMatch(said, /hand-off [0-9a-f]{8}|Your turn sent/, said);
    await sleep(1500);
    assert.equal(hook.got.filter((m) => m.event === "pairbrowse.turn").length, turnsOf("turn").length);
    assert.equal(hook.got.slice(before).filter((m) => m.event === "pairbrowse.turn").length, 0, "Away off: no message");
    const clearedBefore = site.count("cleared");
    assert.equal(await personTypesInLiveView(), 204);
    await until("done in the window", () => site.count("cleared") > clearedBefore, 20_000, 200).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(site.reports.slice(-6))}; tabs ${text(await a.tool("browser_tabs", { action: "list" }))}`); });
    assert.match(await currentUrl() || "", /\/cleared$/);
    text(await a.tool("pairbrowse_status", { kind: "claude", text: "Back" }));
  } catch (e) { throw new Error(`${e.message}${why()}\nmessages: ${JSON.stringify(hook.got)}`, { cause: e }); }
});

// --- 5: a proxy for one session -------------------------------------------------------------------

test("5: a proxy assigned to one session only: that session goes through it, the other stays direct", { skip: SKIP, timeout: 600_000 }, async () => {
  try {
    const a = h.agent;
    const add = await h.post("network", { op: "add", id: "stub", type: "http", host: "127.0.0.1", port: proxy.port, auth: false });
    assert.equal(add.status, 200, add.text);
    const assign = await h.post("network", { op: "session", session: "work", choice: "proxy", id: "stub" });
    assert.equal(assign.status, 200, assign.text);
    const summary = await h.get("network.json");
    assert.equal(summary.json?.default ?? null, null, `no default proxy: ${summary.text}`);

    // The default session: direct.
    const id = randomBytes(3).toString("hex");
    const proxied = () => proxy.log.map((l) => l.target || "").join(" ");
    const first = await a.tool("browser_navigate", { url: `http://direct-${id}.pbtest.example/page` });
    assert.ok(!first.result?.isError, `${text(first).slice(0, 600)}\ntabs: ${text(await a.tool("browser_tabs", { action: "list" }))}`);
    assert.ok(site.asked.includes(`direct-${id}.pbtest.example/page`), "the page loaded");
    assert.doesNotMatch(proxied(), new RegExp(`direct-${id}`), "not through the proxy");

    // The work session: through its proxy, its exit checked at launch.
    const mark = logText().length;
    const made = text(await a.tool("pairbrowse_session", { action: "new", name: "work" }, 600_000));
    assert.match(made, /work/, made);
    const nav = await a.tool("browser_navigate", { url: `http://work-${id}.pbtest.example/page` });
    assert.ok(!nav.result?.isError, `${text(nav).slice(0, 400)}\ntabs: ${text(await a.tool("browser_tabs", { action: "list" }))}`);
    assert.match(proxied(), new RegExp(`work-${id}\\.pbtest\\.example/page`), "through the proxy");
    assert.match(logText().slice(mark), /launch: network "stub"/, "the work session's launch names its proxy");
    const kept = JSON.parse(readFileSync(join(home, "sessions", "work.network.json"), "utf8"));
    assert.equal(kept.checks.find((c) => c.kind === "launch")?.proxy, "stub");

    // Back to the default session: still direct, no check, nothing kept for it.
    const mark2 = logText().length;
    const back = text(await a.tool("pairbrowse_session", { action: "use", name: "default" }, 600_000));
    assert.match(back, /default/i, back);
    const before = proxy.log.length;
    assert.ok(!(await a.tool("browser_navigate", { url: `http://direct2-${id}.pbtest.example/page` })).result?.isError);
    assert.ok(site.asked.includes(`direct2-${id}.pbtest.example/page`), "the page loaded");
    assert.equal(proxy.log.length, before, `the proxy saw nothing: ${JSON.stringify(proxy.log.slice(before))}`);
    assert.doesNotMatch(logText().slice(mark2), /launch: network "stub"/, "the default session's launch names no proxy");
    assert.ok(!existsSync(join(home, "network.json")), "no exit kept for the direct session");
  } catch (e) { throw new Error(`${e.message}${why()}`, { cause: e }); }
});
