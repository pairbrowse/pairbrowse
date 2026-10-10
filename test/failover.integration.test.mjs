// Sharing failover over real Cloudflare Quick Tunnels, with two temporary homes on this computer
// (a host helper and a joiner's helper, each with its own browser): the host keeps two tunnels;
// the one the joiner came in through is killed (cloudflared itself, SIGKILL), and the joiner's
// PairBrowse moves to the standby with the same key: their status stays "You're in", nothing
// about a connection shows on either side, the host still lists them, their agent keeps working
// in the host's tab, and the host starts a replacement tunnel. Needs the network, cloudflared and
// PAIRBROWSE_TEST_RUNTIME; opt in with PAIRBROWSE_TEST_REAL_TUNNEL=1. Cloudflare allows only so
// many fresh Quick Tunnels from one machine in a while (this test opens three): run it sparingly.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const real = process.env.PAIRBROWSE_TEST_REAL_TUNNEL === "1";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP = `<title>Form</title><body style="margin:0"><form><label>Note <input id="i" name="note" style="display:block;width:100vw;height:20vh;font-size:30px"></label></form></body>`;

function rpc(write, input) {
  const waiting = new Map();
  createInterface({ input }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  return (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

function home(prefix) {
  mkdirSync(shortBase, { recursive: true });
  const dir = mkdtempSync(join(shortBase, prefix));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  // The cloudflared already downloaded for this computer, instead of a fresh download per home.
  const tools = join(homedir(), ".pairbrowse", "tools");
  if (existsSync(tools)) symlinkSync(tools, join(dir, "tools"), "dir");
  return dir;
}

const stateOf = (h) => { try { return JSON.parse(readFileSync(join(h, "sharing.json"), "utf8")); } catch { return null; } };
const logOf = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } };
const children = (pid) => { try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const kill9 = (pid) => { try { process.kill(pid, "SIGKILL"); return true; } catch { return false; } };

test("sharing failover: the tunnel the joiner uses dies; they move to the standby with the same key and nothing shows", { skip: !runtime || !real, timeout: 300_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = process.env.PAIRBROWSE_TEST_EXECUTABLE || require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const port = fixture.address().port;
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}`];
  const hostHome = home("fh-"), joinHome = home("fj-");
  writeFileSync(join(hostHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Bob" }));
  writeFileSync(join(joinHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Alice" }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_SCREEN: "1" });
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(50);
    let sock;
    for (let i = 0; ; i++) {
      sock = net.createConnection(socketPath);
      const ok = await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); });
      if (ok) break;
      if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const results = { host: [], joiner: [] }; // every result's text, by side
  const tool = async (side, name, args = {}) => { const r = await side.call("tools/call", { name, arguments: args }); results[side.who].push(text(r)); return r; };
  const until = async (what, check, ms = 30_000, every = 300) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  const evaluate = async (side, fn) => {
    const r = text(await tool(side, "browser_evaluate", { function: fn }));
    const m = r.match(/### Result\n([\s\S]*?)(\n###|$)/);
    try { return JSON.parse(m ? m[1].trim() : r); } catch { return m ? m[1].trim() : r; }
  };
  const fieldValue = async (host) => {
    // The host's snapshot (the value as the host's agent reads it), with the field itself as the check.
    const snap = text(await tool(host, "browser_snapshot"));
    const live = String(await evaluate(host, "() => document.getElementById('i').value"));
    return { snap, live };
  };
  const statuses = []; // [seconds since the kill, the joiner's status]
  let host, joiner, stage = "start";
  let keepers = []; // the host's tunnels as last saved (the state file goes with the last code)
  const t0 = Date.now();
  const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
  try {
    host = { ...(await connect(hostHome)), who: "host" };
    joiner = { ...(await connect(joinHome)), who: "joiner" };
    stage = "the host starts a clean session and opens the form";
    const fresh = await tool(host, "pairbrowse_session", { action: "new", clean: true });
    assert.ok(!fresh.result?.isError, text(fresh));
    assert.ok(!(await tool(host, "browser_navigate", { url: "http://one.pbtest.example/form" })).result.isError);

    stage = "a shared browser code, and two live tunnels";
    const made = text(await tool(host, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code", mode: "shared" }));
    assert.match(made, /Shared browser: they work in this browser itself/, made);
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code, made);
    const codeUrl = JSON.parse(Buffer.from(code.slice("pb-join:".length), "base64url").toString("utf8")).u;
    const state = await until("two live tunnels in the host's saved state", () => { const s = stateOf(hostHome); return s?.tunnels?.length >= 2 && s.tunnels.every((t) => { try { process.kill(t.pid, 0); return true; } catch { return false; } }) && s; }, 90_000, 1000);
    console.log(`pool filled ${since(t0)} after start: ${state.tunnels.map((t) => `${new URL(t.url).host} (keeper ${t.pid})`).join(", ")}; the code carries ${new URL(codeUrl).host}`);

    stage = "the joiner joins and the host lets them in";
    assert.match(text(await tool(joiner, "pairbrowse_join", { action: "join", code })), /shared browser/);
    const id = await until("the request", async () => text(await tool(host, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice \((?:Claude Code|Codex)\), waiting/)?.[1], 60_000);
    assert.match(text(await tool(host, "pairbrowse_invite", { action: "approve", id })), /Let Alice in/);
    const status = async () => text(await tool(joiner, "pairbrowse_join", { action: "status" }));
    await until("the joiner is in", async () => /You're in/.test(await status()), 60_000);

    stage = "the joiner's agent types in the host's field";
    const snap = await until("the host's form through the shared browser", async () => { const s = text(await tool(joiner, "browser_snapshot")); return /textbox "Note"/.test(s) && s; }, 60_000, 1000);
    const note = snap.match(/textbox "Note"[^\n]*\[ref=((?:f\d+)?e\d+)\]/)?.[1];
    assert.ok(note, snap.slice(0, 600));
    await tool(host, "pairbrowse_collaboration", { action: "release" });
    const typed = await until("the agent may type", async () => { const r = await tool(joiner, "browser_type", { target: note, element: "Note", text: "first" }); return !r.result?.isError && r; }, 30_000);
    assert.ok(typed);
    const first = await until("the first value with the host", async () => { const v = await fieldValue(host); return v.live === "first" && v; }, 20_000);
    assert.ok(first.snap.includes("first") || first.live === "first", first.snap.slice(0, 400));
    // Every address with the joiner (pushed with the tabs): give the standby time to be known.
    await sleep(2000);
    const notesFrom = { host: results.host.length, joiner: results.joiner.length };

    stage = "the joiner's tunnel is killed";
    const before = stateOf(hostHome);
    const used = before.tunnels.find((t) => new URL(t.url).origin === new URL(codeUrl).origin) || before.tunnels[0];
    const standby = before.tunnels.filter((t) => t !== used).map((t) => new URL(t.url).host);
    const cloudflared = children(used.pid);
    const killedAt = Date.now();
    const dead = [...cloudflared.map(kill9), kill9(used.pid)];
    console.log(`killed ${new URL(used.url).host}: cloudflared ${cloudflared.join(",") || "(none found)"} and keeper ${used.pid} -> ${JSON.stringify(dead)}; standby ${standby.join(", ")}`);
    assert.ok(dead.some(Boolean), "something was killed");

    stage = "the joiner stays in while the tunnel is gone";
    let listedAlways = true;
    for (const end = killedAt + 25_000; Date.now() < end; await sleep(2000)) {
      const s = await status();
      statuses.push([since(killedAt), s.split("\n")[0]]);
      assert.match(s, /You're in/, `joiner status ${since(killedAt)} after the kill: ${s}`);
      assert.doesNotMatch(s, /offline|dropped|Can't reach|Reconnecting/, `joiner status ${since(killedAt)} after the kill: ${s}`);
      const collab = text(await tool(host, "pairbrowse_collaboration", { action: "status" }));
      const list = text(await tool(host, "pairbrowse_invite", { action: "list" }));
      if (!/Alice/.test(collab) || !/request r[0-9a-f]{6}: Alice[^\n]*let in/.test(list)) { listedAlways = false; console.log(`host ${since(killedAt)}: collaboration ${JSON.stringify(collab.slice(0, 200))}; list ${JSON.stringify(list.slice(0, 300))}`); }
    }
    assert.ok(listedAlways, "the host kept the joiner listed throughout");

    stage = "the joiner's agent types again, through the standby";
    await tool(host, "pairbrowse_collaboration", { action: "release" });
    const again = await until("the agent may type again", async () => { const r = await tool(joiner, "browser_type", { target: note, element: "Note", text: " second" }); return !r.result?.isError && r; }, 60_000);
    assert.ok(again);
    const second = await until("the second value with the host", async () => { const v = await fieldValue(host); return /second/.test(v.live) && v; }, 30_000);
    const actedAt = Date.now();
    console.log(`first joiner action after the kill landed ${since(killedAt)} later: ${JSON.stringify(second.live)}`);
    assert.ok(second.snap.includes("second") || /second/.test(second.live), second.snap.slice(0, 400));
    const addr = await until("the joiner on the standby", async () => (await status()), 5000).catch(() => "");
    statuses.push([since(killedAt), addr.split("\n")[0]]);

    stage = "nothing about the connection on either side";
    const notes = (side) => results[side].slice(notesFrom[side]).flatMap((r) => [...r.matchAll(/### PairBrowse\n([\s\S]*?)(?=\n###|$)/g)].map((m) => m[1]));
    for (const side of ["host", "joiner"]) {
      for (const n of notes(side)) assert.doesNotMatch(n, /connection|tunnel|dropped|lost/i, `${side} note after the kill: ${n}`);
    }

    stage = "the host's log says one tunnel stopped and a replacement came";
    const hostLog = await until("the refill in the host's log", () => { const l = logOf(hostHome); return /a sharing tunnel stopped; 1 left/.test(l) && (l.split("sharing tunnel up:").length - 1 >= 3 || (stateOf(hostHome)?.tunnels?.length ?? 0) >= 2) && l; }, 90_000, 1000);
    assert.match(hostLog, /a sharing tunnel stopped; 1 left/);
    const after = stateOf(hostHome);
    console.log(`pool after the refill (${since(killedAt)} after the kill): ${(after?.tunnels || []).map((t) => new URL(t.url).host).join(", ")}`);
    const joinerLog = logOf(joinHome);
    const errors = joinerLog.split("\n").filter((l) => /\berror\b/i.test(l));
    assert.deepEqual(errors, [], `error lines in the joiner's log:\n${errors.join("\n")}`);
    console.log(`timings: pool ready ${since(t0)}; kill at +${((killedAt - t0) / 1000).toFixed(1)}s; second value at +${((actedAt - t0) / 1000).toFixed(1)}s`);
    console.log(`joiner statuses after the kill:\n${statuses.map(([t, s]) => `  ${t}: ${s}`).join("\n")}`);
    console.log(`host log (sharing lines):\n${hostLog.split("\n").filter((l) => /sharing|tunnel|join/i.test(l)).map((l) => `  ${l}`).join("\n")}`);
    console.log(`joiner log (join lines):\n${joinerLog.split("\n").filter((l) => /join|relay|offline|session/i.test(l)).slice(-30).map((l) => `  ${l}`).join("\n")}`);

    stage = "teardown";
    keepers = after?.tunnels || [];
    assert.match(text(await tool(joiner, "pairbrowse_join", { action: "leave" })), /Left Bob's session/);
    await tool(host, "pairbrowse_invite", { action: "revoke_all" });
  } catch (e) {
    const tail = (h) => logOf(h).slice(-3000);
    throw new Error(`${stage}: ${e.message}\njoiner statuses:\n${statuses.map(([t, s]) => `  ${t}: ${s}`).join("\n")}\nhost log:\n${tail(hostHome)}\njoiner log:\n${tail(joinHome)}`);
  } finally {
    host?.sock.destroy();
    joiner?.sock.destroy();
    fixture.close();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
    // The host's helper stops its tunnels on SIGTERM; make sure no keeper of these homes outlives the test.
    for (const t of [...keepers, ...(stateOf(hostHome)?.tunnels || [])]) { for (const c of children(t.pid)) kill9(c); kill9(t.pid); }
    rmSync(hostHome, { recursive: true, force: true });
    rmSync(joinHome, { recursive: true, force: true });
  }
});
