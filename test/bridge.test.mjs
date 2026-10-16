// The bridge (scripts/launcher/bridge.mjs): Claude Code's or Codex's "browser" MCP server, a line
// bridge between stdio and the helper's private socket. Run here as its own process against a
// fake helper listening on that socket in a home of its own under the system's temp folder: no
// real helper and no browser are ever started.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeUrl = pathToFileURL(join(root, "scripts", "launcher", "bridge.mjs")).href;
const homes = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// A home with the pinned runtime looking installed (so the bridge never runs npm) and its socket folder.
function newHome() {
  const home = mkdtempSync(join(tmpdir(), "pb-br-"));
  homes.push(home);
  mkdirSync(join(home, "runtime", "node_modules", "@playwright", "mcp"), { recursive: true });
  writeFileSync(join(home, "runtime", "package-lock.json"), readFileSync(join(root, "runtime", "package-lock.json")));
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  return home;
}

// A fake helper: each agent connection's messages, answered by answer(msg, conn) (null: no
// answer). The bridge's version hello (handoff.mjs) is answered as a helper of the same version
// does, on its own connection, which isn't counted among them (hellos): a connection counts at
// its first other line, or once 100 ms passed without a hello (an agent's that sends nothing yet).
async function fakeHelper(home, answer) {
  const conns = [];
  const hellos = [];
  const server = net.createServer((sock) => {
    const conn = { sock, got: [] };
    sock.on("error", () => {});
    let counted = false;
    const count = () => { if (!counted) { counted = true; conns.push(conn); } };
    const timer = setTimeout(count, 100);
    createInterface({ input: sock }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (!counted && msg?.pairbrowse === "hook" && msg.op === "version") { clearTimeout(timer); counted = true; hellos.push(msg); sock.end('{"restart":false,"why":"same version"}\n'); return; }
      clearTimeout(timer);
      count();
      conn.got.push(msg);
      const reply = answer(msg, conn);
      if (reply) sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }) + "\n");
    });
  });
  await new Promise((r) => server.listen(join(home, "run", "browser.sock"), r));
  return { conns, hellos, close: () => { for (const c of conns) c.sock.destroy(); server.close(); } };
}

// The bridge as its own process: send(msg or raw line), the messages it writes, its stderr and exit.
function startBridge(home, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PAIRBROWSE_")));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(bridgeUrl)}).then((m) => m.startBridge())`], { env: { ...env, PAIRBROWSE_HOME: home, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  let err = "";
  createInterface({ input: child.stdout }).on("line", (l) => out.push(JSON.parse(l)));
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  return {
    child, out, exited, stderr: () => err,
    send: (m) => child.stdin.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n"),
    kill: () => { if (child.exitCode === null) child.kill(); },
  };
}

async function until(what, check, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const got = check();
    if (got) return got;
  }
  throw new Error(`timed out: ${what}`);
}

const TOOLS = [{ name: "browser_click", inputSchema: { type: "object" } }];
const standard = (msg) => {
  if (msg.method === "initialize") return { result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } } };
  if (msg.method === "tools/list") return { result: { tools: TOOLS } };
  if (msg.method === "tools/call") return { result: { content: [{ type: "text", text: `ran ${msg.params.name}` }] } };
  return null;
};

test("both ways, line by line: junk ignored, initialize names the parent and the participant, pairbrowse_join added", async () => {
  const home = newHome();
  const helper = await fakeHelper(home, standard);
  const b = startBridge(home, { PAIRBROWSE_PARTICIPANT: `Ann\u0007ie ${"x".repeat(80)}` });
  try {
    b.send("not json");
    b.send("null");
    b.send("42");
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex", version: "1" } } });
    const init = await until("initialize answer", () => b.out.find((m) => m.id === 1));
    assert.equal(init.result.serverInfo.name, "fake");
    const sent = helper.conns[0].got.find((m) => m.method === "initialize");
    assert.equal(sent.params.clientInfo.pairbrowseParent, process.pid, "the app that started the bridge");
    assert.equal(sent.params.clientInfo.pairbrowseParticipant, `Annie ${"x".repeat(54)}`, "control characters out, 60 at most");
    assert.equal(sent.params.clientInfo.name, "codex");
    assert.equal(helper.conns[0].got.length, 1, "junk lines never reach the helper");
    assert.deepEqual(helper.hellos.map((h) => h.version), [JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version], "it said its own version first, on a connection of its own");
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await until("tools/list", () => b.out.find((m) => m.id === 2));
    assert.deepEqual(list.result.tools.map((t) => t.name), ["browser_click", "pairbrowse_join"], "no dock tool for Codex");
    b.send({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "browser_click", arguments: {} } });
    assert.equal((await until("call", () => b.out.find((m) => m.id === "x"))).result.content[0].text, "ran browser_click");
    assert.equal(b.child.exitCode, null, "still running after junk");
  } finally { b.kill(); helper.close(); }
});

test("Claude Code on macOS also gets pairbrowse_dock; elsewhere only pairbrowse_join", async () => {
  const home = newHome();
  const helper = await fakeHelper(home, standard);
  const b = startBridge(home);
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code", version: "1" } } });
    await until("initialize", () => b.out.find((m) => m.id === 1));
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (await until("tools/list", () => b.out.find((m) => m.id === 2))).result.tools.map((t) => t.name);
    assert.deepEqual(names, process.platform === "darwin" ? ["browser_click", "pairbrowse_join", "pairbrowse_dock"] : ["browser_click", "pairbrowse_join"]);
  } finally { b.kill(); helper.close(); }
});

test("the helper drops the connection: what was in flight fails with a retry note, the bridge reconnects and replays the opening", async () => {
  const home = newHome();
  const helper = await fakeHelper(home, (msg, conn) => {
    if (msg.method === "tools/call" && msg.params.name === "crash") { conn.sock.destroy(); return null; }
    return standard(msg);
  });
  const b = startBridge(home);
  try {
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "codex" } } });
    await until("initialize", () => b.out.find((m) => m.id === 1));
    b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    b.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "crash", arguments: {} } });
    const failed = await until("in-flight failure", () => b.out.find((m) => m.id === 7));
    assert.equal(failed.error.code, -32002);
    assert.match(failed.error.message, /restarted\. Retry/);
    await until("a second connection", () => helper.conns.length === 2 && helper.conns[1].got.length >= 2);
    const [reinit, note] = helper.conns[1].got;
    assert.equal(reinit.id, "pb-reinit");
    assert.equal(reinit.method, "initialize");
    assert.equal(reinit.params.clientInfo.name, "codex", "the client's own opening, replayed");
    assert.equal(note.method, "notifications/initialized");
    b.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_click", arguments: {} } });
    await until("the next call", () => b.out.find((m) => m.id === 8));
    assert.ok(!b.out.some((m) => m.id === "pb-reinit"), "the replayed opening's answer is the bridge's own");
    assert.equal(b.out.filter((m) => m.id === 1).length, 1);
  } finally { b.kill(); helper.close(); }
});

test("stdin closing ends the bridge cleanly", async () => {
  const home = newHome();
  const helper = await fakeHelper(home, standard);
  const b = startBridge(home);
  try {
    await until("connected", () => helper.conns.length === 1);
    b.child.stdin.end();
    assert.equal(await b.exited, 0);
  } finally { b.kill(); helper.close(); }
});

test("a helper that can't be reached or started: the bridge says why and exits 1", async () => {
  const home = newHome();
  // No helper listens, and the helper's log can't be opened (a folder in its place), so starting
  // one fails before any process is spawned.
  mkdirSync(join(home, "daemon.log"));
  const b = startBridge(home);
  try {
    assert.equal(await b.exited, 1);
    assert.match(b.stderr(), /^pairbrowse: .*EISDIR/m);
  } finally { b.kill(); }
});
