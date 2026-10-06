// A PairBrowse helper started from a temporary home, and an MCP client on its socket (both sides).
import net from "node:net";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, openSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
// The two sides talk through a shared folder (PB_MAIL), whichever machine hosts.
const mail = process.env.PB_MAIL || "/tmp/pbmail";
export const post = (name, value = "") => writeFileSync(join(mail, name), String(value));
export async function wait(name, ms = 600_000) { const f = join(mail, name); for (let t = 0; t < ms && !existsSync(f); t += 300) await sleep(300); return readFileSync(f, "utf8"); }
// This machine's browser: the PairBrowse browser on macOS, Patchright's Chromium on Linux.
export function browserPath() {
  if (process.platform === "darwin") return process.env.HOME + "/.pairbrowse/browser/PairBrowse.app/Contents/MacOS/pairbrowse";
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  const sub = readdirSync(join(root, dir)).find((d) => /^chrome-linux/.test(d));
  return join(root, dir, sub, "chrome");
}
export const chromeArgs = process.platform === "linux" ? ["--headless=new", "--no-sandbox"] : ["--headless=new"];
export async function attach(home, app = "claude-code") {
  const sp = join(home, "run", "browser.sock");
  let sock;
  for (let i = 0; ; i++) { sock = net.createConnection(sp); if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break; if (i > 80) throw new Error("no socket"); await sleep(250); }
  const waiting = new Map(); let seq = 0;
  createInterface({ input: sock }).on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const call = (method, params = {}) => new Promise((resolve) => { const id = `x${++seq}`; waiting.set(id, resolve); sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1" } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { tool: (name, args = {}) => call("tools/call", { name, arguments: args }), close: () => sock.destroy() };
}
export async function helper({ home, repo, runtime, config, env = {}, app = "claude-code" }) {
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, "runtime"))) symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const out = openSync(join(home, "stderr.log"), "a");
  const d = spawn(process.execPath, [join(repo, "scripts", "daemon.mjs")], { cwd: repo, env: { ...process.env, PAIRBROWSE_HOME: home, ...env }, stdio: ["ignore", out, out] });
  const sp = join(home, "run", "browser.sock");
  for (let i = 0; i < 200 && !existsSync(sp); i++) await sleep(100);
  const c = await attach(home, app);
  const tool = c.tool;
  return { tool, stop: () => { c.close(); d.kill("SIGTERM"); } };
}
