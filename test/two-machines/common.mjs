// A PairBrowse helper started from a temporary home, and an MCP client on its socket (both sides).
import net from "node:net";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, openSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
export async function helper({ home, repo, runtime, config, env = {}, app = "claude-code" }) {
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, "runtime"))) symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const out = openSync(join(home, "stderr.log"), "a");
  const d = spawn(process.execPath, [join(repo, "scripts", "daemon.mjs")], { cwd: repo, env: { ...process.env, PAIRBROWSE_HOME: home, ...env }, stdio: ["ignore", out, out] });
  const sp = join(home, "run", "browser.sock");
  for (let i = 0; i < 200 && !existsSync(sp); i++) await sleep(100);
  let sock;
  for (let i = 0; ; i++) { sock = net.createConnection(sp); if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break; if (i > 80) throw new Error("no socket"); await sleep(250); }
  const waiting = new Map(); let seq = 0;
  createInterface({ input: sock }).on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const call = (method, params = {}) => new Promise((resolve) => { const id = `x${++seq}`; waiting.set(id, resolve); sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1" } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tool = (name, args = {}) => call("tools/call", { name, arguments: args });
  return { tool, stop: () => { sock.destroy(); d.kill("SIGTERM"); } };
}
