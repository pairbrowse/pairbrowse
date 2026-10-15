// Shared by the live tests: they drive the browser the way PairBrowse ships, through Patchright.
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { sleep } from "./util.mjs";

// Where live tests make their helper homes: the system's temporary folder, on the machine's own
// disk (an external disk a build saturates holds every helper up for seconds), or /tmp when the
// socket path under it would pass the 104-byte limit of a Unix socket's address.
export function testBase() {
  const base = tmpdir();
  return join(base, "xx-XXXXXX/run/browser.sock").length > 100 ? "/tmp" : base;
}

const tail = (file, n = 1500) => { try { return readFileSync(file, "utf8").slice(-n); } catch { return ""; } };

// A helper started by a test, once it listens: a connected socket. It fails at once when the
// helper exits, with the ends of its stderr and its log, rather than at the end of a wait.
export async function attachDaemon({ socketPath, daemon, home, ms = 60_000 }) {
  const end = Date.now() + ms;
  const why = () => `\n--- daemon.stderr.log ---\n${tail(join(home, "daemon.stderr.log"))}\n--- daemon.log ---\n${tail(join(home, "daemon.log"))}`;
  for (;;) {
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`the helper exited (${daemon.exitCode ?? daemon.signalCode}) before it listened${why()}`);
    const sock = net.createConnection(socketPath);
    if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) return sock;
    sock.destroy();
    if (Date.now() > end) throw new Error(`couldn't connect to ${socketPath} within ${ms} ms${why()}`);
    await sleep(100);
  }
}

// Patchright from the pinned runtime (PAIRBROWSE_TEST_RUNTIME).
export const patchright = (runtime) => createRequire(join(runtime, "package.json"))("patchright");

// The page script as the helper adds it (scripts/daemon/hud.mjs ensure): under Patchright,
// page.evaluate runs in a hidden script world, not the page's, so the script is added there once
// the page has loaded and every later call reaches it.
export async function ensureHud(page, source, name) {
  if (!(await page.evaluate((n) => typeof window[n] === "function", name))) await page.evaluate(source);
}

// Reads what the page's own scripts set (window.sent and the like): in the page's world.
export const inPage = (target, fn, arg) => target.evaluate(fn, arg, undefined, false);


// A session on the helper's socket, as Claude Code would open one.
export async function session(socketPath, name) {
  let sock;
  for (let i = 0; ; i++) {
    sock = net.createConnection(socketPath);
    if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
    if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
    await sleep(200);
  }
  const waiting = new Map();
  const answers = [];
  createInterface({ input: sock }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined) answers.push(m.id);
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  const call = (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `${name}${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { sock, answers, tool: (tool, args = {}, ms) => call("tools/call", { name: tool, arguments: args }, ms) };
}
