// A real helper and browser for live tests (PAIRBROWSE_TEST_RUNTIME), headless, in a home of its
// own under the system's temp folder: { a (an agent's session), h (the home), stop() }.
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session, testBase } from "./live.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

export async function liveHelper(runtime, { prefix = "lh-", config = {}, args = [], name = "w", env = {} } = {}) {
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, prefix));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new", ...args], display: "none", screenshots: false, ...config }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, ...env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, name);
  const agents = [a];
  return {
    a, h, socketPath,
    async agent(n) { const s = await session(socketPath, n); agents.push(s); return s; },
    async stop() {
      for (const s of agents) s.sock.destroy();
      if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
      rmSync(h, { recursive: true, force: true });
    },
  };
}
