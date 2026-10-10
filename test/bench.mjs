// Reproducible performance baseline for the helper: cold start, idle CPU and memory of the whole
// process tree, MCP round trips, snapshot/navigate/click/type latency with and without
// screenshots, and memory after a long run of actions. Not a test: run it by hand.
//
//   PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime node test/bench.mjs [--ops 60] [--json out.json]
//   ... --soak N [--viewers V]   N rounds on one helper, memory over time, V live-view viewers
//   ... --agents N [--rounds R]  N agents at once in their own tabs
//   ... --joiner R               a shared-browser joiner (two helpers) over R rounds
//
// It starts its own helper on a temporary home with a headless browser, so a running PairBrowse
// is untouched. Numbers are wall-clock on this machine: compare runs on the same machine only.
import { createRequire } from "node:module";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
if (!runtime) { console.error("PAIRBROWSE_TEST_RUNTIME is required"); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const OPS = Number(opt("--ops", 60));
const JSON_OUT = opt("--json", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const hasImage = (r) => (r.result?.content || []).some((c) => c.type === "image");

// The process tree under pid: rss (KB) and cumulative CPU seconds, from ps.
function tree(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8" }).trim().split("\n").map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? [m[1], m[2], m[3], m[4], m[5]] : null; }).filter(Boolean);
  const kind = (cmd) => /daemon\.mjs/.test(cmd) ? "helper" : /--type=renderer/.test(cmd) ? "renderer" : /--type=gpu/.test(cmd) ? "gpu" : /--type=utility/.test(cmd) ? "utility" : /--type=/.test(cmd) ? cmd.match(/--type=(\S+)/)[1] : /chrom|Chrom|pairbrowse/i.test(cmd) ? "browser" : "other";
  const kids = new Map();
  for (const [p, pp, rss, time, cmd] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push({ pid: Number(p), rss: Number(rss), cpu: cpuSeconds(time), kind: kind(cmd) }); }
  const out = [];
  const walk = (p) => { for (const k of kids.get(String(p)) || []) { out.push(k); walk(k.pid); } };
  const self = rows.find((r) => Number(r[0]) === pid);
  if (self) out.push({ pid, rss: Number(self[2]), cpu: cpuSeconds(self[3]), kind: "helper" });
  walk(pid);
  return out;
}
function cpuSeconds(t) { // "mm:ss.cc" or "hh:mm:ss"
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}
const sumRss = (procs) => procs.reduce((a, p) => a + p.rss, 0);
const sumCpu = (procs) => procs.reduce((a, p) => a + p.cpu, 0);

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: Math.max(...xs, 0), mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0 });

async function timed(fn) { const t = Date.now(); const r = await fn(); return [Date.now() - t, r]; }

async function startHelper({ screenshots }) {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const h = mkdtempSync(join(tmpdir(), "pb-bench-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", ...(screenshots ? {} : { screenshots: false }) }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const t0 = Date.now();
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_MEMORY: "1", PAIRBROWSE_TRACE: "1" }, stdio: ["ignore", out, out] });
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const socketAt = Date.now() - t0;
  const s = await session(socketPath, "b");
  const [firstAnswer] = await timed(() => s.tool("pairbrowse_session", { action: "new", clean: true }, 120_000));
  const [tabsAt] = await timed(() => s.tool("browser_tabs", { action: "list" }, 120_000));
  const stop = async () => {
    s.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  };
  return { daemon, s, home: h, startup: { socketMs: socketAt, sessionNewMs: firstAnswer, firstTabsMs: tabsAt, totalMs: Date.now() - t0 }, stop, log: () => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } } };
}

// A small site: a form page, a page with a long list, a page that keeps changing.
function site() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/form")) return res.end(`<!doctype html><title>Form</title><h1>Sign up</h1><form onsubmit="event.preventDefault();document.getElementById('o').textContent='sent '+name.value"><label>Name <input name="name"></label><label>Email <input name="email" type="email"></label><label>Plan <select name="plan"><option>Free</option><option>Pro</option></select></label><label><input type="checkbox" name="tos"> I agree</label><button type="submit">Create account</button></form><p id="o"></p><button id="b" onclick="document.getElementById('c').textContent=(+document.getElementById('c').textContent||0)+1">Count</button><span id="c">0</span>`);
    if (req.url.startsWith("/long")) return res.end(`<!doctype html><title>Long</title><h1>Long list</h1>${Array.from({ length: 400 }, (_, i) => `<p><a href="#${i}">Item ${i}</a> some text about item ${i} with <b>bold</b> parts</p>`).join("")}`);
    res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1><input name="q">`);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` })));
}

async function sampleIdle(pid, seconds) {
  await sleep(4000); // the browser's GPU process winds down for a few seconds after work
  const a = tree(pid);
  await sleep(seconds * 1000);
  const b = tree(pid);
  const perKind = {};
  for (const p of b) { const was = a.find((x) => x.pid === p.pid); perKind[p.kind] = Math.round(((perKind[p.kind] || 0) + ((p.cpu - (was?.cpu || 0)) / seconds) * 100) * 10) / 10; }
  return { rssKb: sumRss(b), procs: b.length, cpuPct: Math.round(((sumCpu(b) - sumCpu(a)) / seconds) * 1000) / 10, perKind };
}

async function run({ screenshots }) {
  const { server, url } = await site();
  const helper = await startHelper({ screenshots });
  const { s, daemon } = helper;
  const result = { screenshots, startup: helper.startup };
  try {
    const mem = async () => JSON.parse(text(await s.tool("pairbrowse_test_memory")));
    await s.tool("browser_navigate", { url: url("/form") }, 60_000);
    result.idleAfterStart = await sampleIdle(daemon.pid, 15);
    result.helperMemStart = await mem();

    const rt = [];
    for (let i = 0; i < 30; i++) rt.push((await timed(() => s.tool("pairbrowse_status", { text: `bench ${i}`, kind: "claude" })))[0]);
    result.statusRoundTrip = stats(rt);

    const snap = [], snapImg = [];
    for (let i = 0; i < OPS / 3; i++) { const [ms, r] = await timed(() => s.tool("browser_snapshot", {})); snap.push(ms); snapImg.push(hasImage(r)); }
    result.snapshotForm = { ...stats(snap), withImage: snapImg.filter(Boolean).length };

    await s.tool("browser_navigate", { url: url("/long") }, 60_000);
    const snapL = [];
    for (let i = 0; i < OPS / 3; i++) snapL.push((await timed(() => s.tool("browser_snapshot", {})))[0]);
    result.snapshotLong = stats(snapL);

    const nav = [];
    for (let i = 0; i < OPS / 3; i++) nav.push((await timed(() => s.tool("browser_navigate", { url: url(`/p${i}`) }, 60_000)))[0]);
    result.navigate = stats(nav);

    await s.tool("browser_navigate", { url: url("/form") }, 60_000);
    const snapR = text(await s.tool("browser_snapshot", {}));
    const ref = (label) => { const m = snapR.match(new RegExp(`${label}[^\\n]*\\[ref=([^\\]]+)\\]`)); return m?.[1]; };
    result.snapshotSample = snapR.split("\n").filter((l) => /Count|Name/.test(l)).slice(0, 4);
    const countRef = ref("button \"Count\"") || ref("Count");
    const nameRef = ref("textbox \"Name\"") || ref("Name");
    const click = [], clickOk = [];
    for (let i = 0; i < OPS / 3; i++) { const [ms, r] = await timed(() => s.tool("browser_click", { element: "Count button", target: countRef })); click.push(ms); clickOk.push(!r.result?.isError); if (r.result?.isError && !result.clickError) result.clickError = text(r).slice(0, 300); }
    result.click = { ...stats(click), ok: clickOk.filter(Boolean).length };
    const type = [];
    for (let i = 0; i < OPS / 3; i++) type.push((await timed(() => s.tool("browser_type", { element: "Name field", target: nameRef, text: `Name ${i}` })))[0]);
    result.type = stats(type);
    const fill = [];
    for (let i = 0; i < 5; i++) fill.push((await timed(() => s.tool("pairbrowse_run", { steps: [{ fill: "Name", value: `Person ${i}` }, { fill: "Email", value: `p${i}@example.com` }, { select: "Plan", value: "Pro" }, { check: "I agree" }] }, 60_000)))[0]);
    result.fastModeForm = stats(fill);
    // Verify the count really went up: a fast wrong click is a failure.
    const after = text(await s.tool("browser_snapshot", {}));
    result.clickVerified = new RegExp(`\\b${click.length}\\b`).test(after);

    if (screenshots) {
      const sn = text(await s.tool("browser_snapshot", {}));
      const m = sn.match(/button "Count" \[ref=([^\]]+)\]/);
      void m;
      const ca = [];
      for (let i = 0; i < 10; i++) ca.push((await timed(() => s.tool("pairbrowse_click_at", { x: 60, y: 60, element: "heading" })))[0]);
      result.clickAt = stats(ca);
    }

    result.helperMemEnd = await mem();
    result.idleAfterWork = await sampleIdle(daemon.pid, 15);
    result.tree = tree(daemon.pid).map((p) => ({ kind: p.kind, rssKb: p.rss }));
    // The last traced phases of each tool (PAIRBROWSE_TRACE in serve.mjs).
    const byTool = new Map();
    for (const l of helper.log().split("\n")) { const m = l.match(/trace (\S+) (.*)$/); if (m) byTool.set(m[1], m[2]); }
    result.trace = [...byTool].map(([t, v]) => `${t} ${v}`);
  } catch (e) {
    result.error = `${e.message}\n${helper.log().slice(-1500)}`;
  } finally {
    const [stopMs] = await timed(helper.stop);
    result.shutdownMs = stopMs;
    server.close();
  }
  return result;
}

// --soak N: N rounds of navigate + snapshot + click + type on one helper, the helper's heap and
// the tree's RSS every 50 rounds: growth that doesn't level off is a leak.
// --viewers N: N people watching through the live view (a watch link, each an open event
// stream taking every frame) during the soak: the frames they got and the tree's CPU meanwhile.
async function soak(rounds, viewers = 0) {
  const { server, url } = await site();
  const helper = await startHelper({ screenshots: true });
  const { s, daemon } = helper;
  const samples = [];
  const watching = [];
  const got = { frames: 0, bytes: 0, events: 0 };
  try {
    const mem = async () => JSON.parse(text(await s.tool("pairbrowse_test_memory")));
    const probe = async (i) => { const m = await mem(); samples.push({ round: i, heapMb: Math.round(m.heapUsed / 1048576), helperRssMb: Math.round(m.rss / 1048576), treeMb: Math.round(sumRss(tree(daemon.pid)) / 1024), contexts: m.contexts }); };
    await s.tool("browser_navigate", { url: url("/form") }, 60_000);
    if (viewers) {
      const inv = text(await s.tool("pairbrowse_invite", { action: "create", role: "watch", label: "Watcher", hours: 1, share: "link", name: "Host" }));
      const link = inv.match(/Link: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/)/)?.[1];
      if (!link) throw new Error(`no watch link: ${inv.slice(0, 200)}`);
      for (let v = 0; v < viewers; v++) {
        const ac = new AbortController();
        const res = await fetch(`${link}events`, { signal: ac.signal });
        const reader = res.body.getReader();
        const pump = (async () => { for (;;) { const { done, value } = await reader.read().catch(() => ({ done: true })); if (done) return; got.bytes += value.length; const t = Buffer.from(value).toString("latin1"); got.frames += (t.match(/event: frame/g) || []).length; got.events += (t.match(/\nevent: /g) || []).length; } })();
        watching.push({ ac, pump });
      }
      await sleep(1500);
    }
    const cpu0 = tree(daemon.pid), t0 = Date.now();
    await probe(0);
    for (let i = 1; i <= rounds; i++) {
      await s.tool("browser_navigate", { url: url(i % 2 ? "/form" : `/p${i}`) }, 60_000);
      const snap = text(await s.tool("browser_snapshot", {}));
      const ref = snap.match(/button "Count" \[ref=([^\]]+)\]/)?.[1] || snap.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
      if (ref) { await s.tool("browser_click", { element: "it", target: ref }); }
      const field = snap.match(/textbox[^\n]*\[ref=([^\]]+)\]/)?.[1];
      if (field) await s.tool("browser_type", { element: "field", target: field, text: `r${i}` });
      if (i % 50 === 0) await probe(i);
    }
    const secs = (Date.now() - t0) / 1000;
    const cpu1 = tree(daemon.pid);
    const perKind = {};
    for (const p of cpu1) { const was = cpu0.find((x) => x.pid === p.pid); perKind[p.kind] = Math.round(((perKind[p.kind] || 0) + ((p.cpu - (was?.cpu || 0)) / secs) * 100) * 10) / 10; }
    await sleep(3000);
    await probe(rounds + 1);
    samples.push({ viewers, secs: Math.round(secs), cpuPctDuring: perKind, viewersGot: viewers ? { ...got, mb: Math.round(got.bytes / 1048576 * 10) / 10 } : undefined });
  } catch (e) {
    samples.push({ error: `${e.message}\n${helper.log().slice(-1000)}` });
  } finally {
    for (const w of watching) w.ac.abort();
    await helper.stop();
    server.close();
  }
  return samples;
}

// --agents N: N agents at once, each in a tab of its own on the one helper, each doing ROUNDS of
// navigate + snapshot + click + verify. Per-agent latencies and the sum of verified clicks.
async function agents(n, rounds = 10) {
  const { server, url } = await site();
  const helper = await startHelper({ screenshots: true });
  const { daemon } = helper;
  const socketPath = join(helper.home, "run", "browser.sock");
  const out = { agents: n, rounds, perAgent: [], verified: 0, wrong: 0 };
  const sessions = [helper.s];
  try {
    for (let i = 1; i < n; i++) sessions.push(await session(socketPath, `g${i}`));
    const t0 = Date.now();
    await Promise.all(sessions.map(async (s, i) => {
      const nav = [], snap = [], click = [];
      if (i > 0) await s.tool("browser_tabs", { action: "new" }, 60_000);
      for (let r = 0; r < rounds; r++) {
        nav.push((await timed(() => s.tool("browser_navigate", { url: url(`/form?a=${i}&r=${r}`) }, 60_000)))[0]);
        const [ms, sn] = await timed(() => s.tool("browser_snapshot", {}, 60_000));
        snap.push(ms);
        const ref = text(sn).match(/button "Count" \[ref=([^\]]+)\]/)?.[1];
        if (!ref) { out.wrong++; continue; }
        const [cms, cr] = await timed(() => s.tool("browser_click", { element: "Count", target: ref }, 60_000));
        click.push(cms);
        // The click's own result carries the page: the count must read 1.
        if (!cr.result?.isError && /\b1\b/.test(text(cr))) out.verified++; else out.wrong++;
      }
      out.perAgent.push({ agent: i, navigate: stats(nav), snapshot: stats(snap), click: stats(click) });
    }));
    out.wallMs = Date.now() - t0;
    out.callsPerSecond = Math.round((n * rounds * 3) / (out.wallMs / 1000) * 10) / 10;
    out.mem = JSON.parse(text(await helper.s.tool("pairbrowse_test_memory")));
    out.treeMb = Math.round(sumRss(tree(daemon.pid)) / 1024);
  } catch (e) {
    out.error = `${e.message}\n${helper.log().slice(-1500)}`;
  } finally {
    for (const s of sessions.slice(1)) s.sock.destroy();
    await helper.stop();
    server.close();
  }
  return out;
}

// --joiner R: a shared-browser joiner soak. A host helper (Bob) and a joiner helper (Alice) on
// this computer, a pb-join code approved, the joiner's picture page connected (WebRTC). Then R
// rounds in which the host's agent navigates and clicks (the count verified in the click's own
// result) while the joiner's agent, working in the host's browser, snapshots. Both helpers'
// memory every 20 rounds, both trees' CPU over the soak, and the connection's state.
async function joinerSoak(rounds) {
  const net = await import("node:net");
  const { createInterface } = await import("node:readline");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const APP = `<title>App</title><body style="margin:0"><h1>App</h1><button id="b" style="display:block;width:100vw;height:30vh" onclick="document.getElementById('n').textContent=(+document.getElementById('n').textContent||0)+1">Tap</button><span id="n">0</span><input id="i" aria-label="Note" style="display:block;width:100vw;height:20vh;font-size:30px"><div style="height:150vh">more below</div>`;
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const home = (prefix, name) => { const dir = mkdtempSync(join(tmpdir(), prefix)); symlinkSync(runtime, join(dir, "runtime"), "dir"); writeFileSync(join(dir, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", participantName: name })); return dir; };
  const hostHome = home("pbj-h-", "Bob"), joinHome = home("pbj-j-", "Alice");
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_SCREEN: "1", PAIRBROWSE_TEST_MEMORY: "1", PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" });
  const rpc = (write, input) => {
    const waiting = new Map();
    createInterface({ input }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    let seq = 0;
    return (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => { const id = `t${++seq}`; const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms); waiting.set(id, (m) => { clearTimeout(timer); resolve(m); }); write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  };
  const tool = (call, name, args = {}, ms) => call("tools/call", { name, arguments: args }, ms);
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] });
    daemons.push(daemon);
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 200 && !existsSync(socketPath); i++) await sleep(50);
    let sock;
    for (let i = 0; ; i++) { sock = net.createConnection(socketPath); const ok = await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); }); if (ok) break; if (i > 50) throw new Error(`couldn't connect to ${socketPath}`); await sleep(200); }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call, daemon, home: h };
  };
  const until = async (what, check, ms = 30_000) => { let last; for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last; throw new Error(`timed out: ${what}`); };
  const out = { rounds, samples: [] };
  let host, joiner;
  try {
    host = await connect(hostHome);
    joiner = await connect(joinHome);
    await tool(host.call, "pairbrowse_session", { action: "new", clean: true }, 120_000);
    await tool(joiner.call, "pairbrowse_session", { action: "new", clean: true }, 120_000);
    if ((await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/app" })).result?.isError) throw new Error("the host's navigate failed");
    const made = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" }));
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    if (!code) throw new Error(`no join code: ${made.slice(0, 300)}`);
    await tool(joiner.call, "pairbrowse_join", { action: "join", code });
    const id = await until("the join request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice \((?:Claude Code|Codex)\), waiting/)?.[1]);
    await tool(host.call, "pairbrowse_invite", { action: "approve", id });
    const onScreen = async (args) => { const r = text(await tool(joiner.call, "pairbrowse_test_screen", args)); try { return JSON.parse(r); } catch { return null; } };
    const screen = await until("the picture page", async () => (await onScreen({}))?.index >= 0 && await onScreen({}));
    const live = text(await tool(joiner.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: screen.index }) });
    await until("the direct connection", async () => (await onScreen({ expr: "window.pbScreen && window.pbScreen.state()" }))?.value?.conn === "connected", 45_000);
    const mem = async (c) => { try { return JSON.parse(text(await tool(c.call, "pairbrowse_test_memory"))); } catch { return {}; } };
    const probe = async (round) => {
      const hm = await mem(host), jm = await mem(joiner);
      out.samples.push({ round, host: { heapMb: Math.round(hm.heapUsed / 1048576), rssMb: Math.round(hm.rss / 1048576), treeMb: Math.round(sumRss(tree(host.daemon.pid)) / 1024) }, joiner: { heapMb: Math.round(jm.heapUsed / 1048576), rssMb: Math.round(jm.rss / 1048576), treeMb: Math.round(sumRss(tree(joiner.daemon.pid)) / 1024) }, conn: (await onScreen({ expr: "window.pbScreen.state()" }))?.value?.conn });
    };
    await probe(0);
    const h0 = tree(host.daemon.pid), j0 = tree(joiner.daemon.pid), t0 = Date.now();
    const lat = { hostNavigate: [], hostClick: [], joinerSnapshot: [] };
    let verified = 0, wrong = 0, joinerErrors = 0;
    for (let r = 1; r <= rounds; r++) {
      const [navMs, nav] = await timed(() => tool(host.call, "browser_navigate", { url: `http://one.pbtest.example/app?r=${r}` }, 60_000));
      lat.hostNavigate.push(navMs);
      const ref = text(nav).match(/button "Tap"[^\n]*\[ref=([^\]]+)\]/)?.[1] || text(await tool(host.call, "browser_snapshot", {})).match(/button "Tap"[^\n]*\[ref=([^\]]+)\]/)?.[1];
      const [[clickMs, cr], [snapMs, js]] = await Promise.all([
        timed(() => (ref ? tool(host.call, "browser_click", { element: "Tap", target: ref }, 60_000) : null)),
        timed(() => tool(joiner.call, "browser_snapshot", {}, 60_000)),
      ]);
      lat.hostClick.push(clickMs); lat.joinerSnapshot.push(snapMs);
      if (cr && !cr.result?.isError && /\b1\b/.test(text(cr))) verified++; else wrong++;
      if (js.result?.isError) joinerErrors++;
      if (r % 20 === 0) await probe(r);
    }
    const secs = (Date.now() - t0) / 1000;
    const pct = (a, b) => Math.round(((sumCpu(b) - sumCpu(a)) / secs) * 1000) / 10;
    out.cpuPctDuring = { hostTree: pct(h0, tree(host.daemon.pid)), joinerTree: pct(j0, tree(joiner.daemon.pid)), secs: Math.round(secs) };
    out.latency = { hostNavigate: stats(lat.hostNavigate), hostClick: stats(lat.hostClick), joinerSnapshot: stats(lat.joinerSnapshot) };
    out.verified = verified; out.wrong = wrong; out.joinerErrors = joinerErrors;
    await sleep(3000);
    await probe(rounds + 1);
  } catch (e) {
    out.error = `${e.message}\n${[hostHome, joinHome].map((h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-1200); } catch { return ""; } }).join("\n---\n")}`;
  } finally {
    for (const c of [host, joiner]) c?.sock.destroy();
    fixture.close();
    for (const d of daemons) if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); }
    for (const h of [hostHome, joinHome]) rmSync(h, { recursive: true, force: true });
  }
  return out;
}

if (opt("--joiner", "")) {
  const r = await joinerSoak(Number(opt("--joiner", 60)));
  console.log(JSON.stringify(r, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), joiner: r }, null, 1));
  process.exit(0);
}

if (opt("--agents", "")) {
  const r = await agents(Number(opt("--agents", 3)), Number(opt("--rounds", 10)));
  console.log(JSON.stringify(r, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), agents: r }, null, 1));
  process.exit(0);
}

if (opt("--soak", "")) {
  const samples = await soak(Number(opt("--soak", 200)), Number(opt("--viewers", 0)));
  console.log(JSON.stringify(samples, null, 1));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), soak: samples }, null, 1));
  process.exit(0);
}

const results = [];
for (const screenshots of [true, false]) {
  const r = await run({ screenshots });
  results.push(r);
  console.log(JSON.stringify(r, null, 1));
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 1));
