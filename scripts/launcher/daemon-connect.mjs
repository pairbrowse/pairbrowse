// Reaching the local helper (scripts/daemon.mjs) over its private socket, starting it when it isn't
// running: the bridge (scripts/launch.mjs) and the opener (scripts/open.mjs) share this.
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, openSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureDirs, loadConfig } from "../paths.mjs";
import { ensureRuntime } from "../runtime.mjs";
import { withoutTestSwitches } from "../testenv.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let localReady = false;
// The home's folders, the template files and the pinned runtime, once per process.
export function prepareLocal(say = () => {}) {
  if (localReady) return;
  ensureDirs();
  if (!existsSync(paths.secrets)) {
    copyFileSync(join(root, "templates", "secrets.env.example"), paths.secrets);
    if (process.platform !== "win32") chmodSync(paths.secrets, 0o600);
  }
  if (!existsSync(paths.facts)) copyFileSync(join(root, "templates", "facts.example.md"), paths.facts);
  ensureRuntime(say);
  localReady = true;
}

// macOS: PairBrowse Agent, the small app a native PairBrowse build carries in
// Contents/Helpers (bundle id app.pairbrowse.agent). It disclaims responsibility for itself and
// runs the helper as its child, so macOS charges a privacy prompt the helper raises (Downloads,
// say) to "PairBrowse Agent": never to the PairBrowse browser (whose camera, microphone and
// screen grants stay its own), never to "node", and never to the app that started the helper
// (a terminal, the Claude app, the browser's opener). It runs only <node> <.../scripts/daemon.mjs>.
export const AGENT = ["Contents", "Helpers", "PairBrowse Agent.app", "Contents", "MacOS", "PairBrowse Agent"];
const isExecutableFile = (p) => { try { accessSync(p, fsConstants.X_OK); return statSync(p).isFile(); } catch { return false; } };
const appOf = (exe) => /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] || null;
// The agent to run the helper on: the one in the browser config names (a path to a PairBrowse
// app's program), else in the PairBrowse browser installed under the helper's home; null
// elsewhere than macOS, or with neither (then the helper runs on Node directly, as before).
export function agentProgram(config = loadConfig(), { platform = process.platform, usable = isExecutableFile, home = paths.home } = {}) {
  if (platform !== "darwin") return null;
  const named = [config?.browser, config?.executablePath].find((p) => typeof p === "string" && isAbsolute(p));
  const apps = [named && appOf(named), join(home, "browser", "PairBrowse.app")].filter(Boolean);
  for (const app of apps) {
    const program = join(app, ...AGENT);
    if (usable(program)) return program;
  }
  return null;
}

// Starts the helper, detached: on PairBrowse Agent when there is one (agentProgram), else on Node.
// Returns the child (the agent, or the helper itself).
export function startDaemon({ agent = agentProgram(), run = spawn } = {}) {
  const out = openSync(paths.daemonLog, "a");
  const script = join(root, "scripts", "daemon.mjs");
  const [file, args] = agent ? [agent, [process.execPath, script]] : [process.execPath, [script]];
  const child = run(file, args, { detached: true, stdio: ["ignore", out, out], env: withoutTestSwitches(process.env) });
  child.unref?.();
  return child;
}

export function connectOnce(socketPath = paths.socket) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

// The helper's socket: the running helper's, else a new helper's (up to 15 s for it to listen).
export async function connectLocal(say = () => {}) {
  prepareLocal(say);
  try {
    return await connectOnce();
  } catch {}
  let agent = agentProgram();
  let child = startDaemon({ agent });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      return await connectOnce();
    } catch {}
    // An agent that ended before the helper listened (it refused, or could not run Node): the
    // helper on Node directly, once.
    if (agent && child.exitCode !== null) {
      say(`PairBrowse Agent ended (${child.exitCode}); starting the helper on Node`);
      agent = null;
      child = startDaemon({ agent: null });
    }
  }
  throw new Error(`couldn't reach the PairBrowse daemon; see ${paths.daemonLog}`);
}
