// Shared by the live tests: they drive the browser the way PairBrowse ships, through Patchright.
import { createRequire } from "node:module";
import { join } from "node:path";
import net from "node:net";
import { createInterface } from "node:readline";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
