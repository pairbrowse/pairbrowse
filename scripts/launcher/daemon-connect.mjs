// Reaching the local helper (scripts/daemon.mjs) over its private socket, starting it when it isn't
// running: the bridge (scripts/launch.mjs) and the opener (scripts/open.mjs) share this.
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, openSync, readFileSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureDirs, loadConfig, SELECTED } from "../paths.mjs";
import { ensureRuntime } from "../runtime.mjs";
import { withoutTestSwitches } from "../testenv.mjs";
import { sleep, pidAlive } from "../util.mjs";
import { askVersion, waitGone, HANDOFF_WAIT_MS } from "../handoff.mjs";

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
// app's program), else in the PairBrowse browser installed in the shared installs' home (an
// instance runs the same agent); null elsewhere than macOS, or with neither (then the helper runs
// on Node directly, as before).
export function agentProgram(config = loadConfig(), { platform = process.platform, usable = isExecutableFile, home = paths.shared } = {}) {
  if (platform !== "darwin") return null;
  const named = [config?.browser, config?.executablePath].find((p) => typeof p === "string" && isAbsolute(p));
  const apps = [named && appOf(named), join(home, "browser", "PairBrowse.app")].filter(Boolean);
  for (const app of apps) {
    const program = join(app, ...AGENT);
    if (usable(program)) return program;
  }
  return null;
}

// The helper's environment: this process's without the test switches, and the instance this
// process chose from its project's .pairbrowse.json named outright, so the helper (and the tunnel
// keepers it starts) use the same home whatever folder they run in.
export function helperEnv(env = process.env, selected = SELECTED) {
  const out = withoutTestSwitches(env);
  if (selected.source === "project") out.PAIRBROWSE_INSTANCE = selected.instance || "default";
  return out;
}

// Starts the helper, detached: on PairBrowse Agent when there is one (agentProgram), else on Node.
// Returns the child (the agent, or the helper itself).
export function startDaemon({ agent = agentProgram(), run = spawn } = {}) {
  const out = openSync(paths.daemonLog, "a");
  const script = join(root, "scripts", "daemon.mjs");
  const [file, args] = agent ? [agent, [process.execPath, script]] : [process.execPath, [script]];
  const child = run(file, args, { detached: true, stdio: ["ignore", out, out], env: helperEnv() });
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

// This copy's own version (its package.json): what the bridge says to the running helper.
export const BRIDGE_VERSION = (() => { try { return String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || ""); } catch { return ""; } })();

// The pid in the helper's lock file, 0 for none.
const lockHolder = () => { try { return Number(readFileSync(paths.daemonLock, "utf8")) || 0; } catch { return 0; } };
const answers = () => connectOnce().then((s) => { s.destroy(); return true; }, () => false);

// A running helper older than this copy, with nobody using it, stops for it (handoff.mjs): the
// bridge says its version first (bounded, HELLO_MS). Any answer but a yes (an older helper's,
// none, a helper in use): nothing more. A yes: up to HANDOFF_WAIT_MS for the old helper to be gone
// (socket and lock), then true: start this copy's. version is this copy's (tests give another).
async function handOver(say, version) {
  let sock;
  try { sock = await connectOnce(); } catch { return false; }
  const a = await askVersion(sock, version).catch(() => ({ restart: false }));
  if (!a.restart) return false;
  say(`PairBrowse ${version} is installed; the helper restarts on it`);
  if (!(await waitGone({ reachable: answers, holder: lockHolder }))) say(`the old helper is still stopping after ${HANDOFF_WAIT_MS / 1000} s; starting this one anyway`);
  return true;
}

// The helper's socket: the running helper's (after the version hello), else a new helper's (up to
// 15 s for it to listen). agent: the PairBrowse Agent to start it on (agentProgram).
export async function connectLocal(say = () => {}, { version = BRIDGE_VERSION, agent: given, start = startDaemon } = {}) {
  prepareLocal(say);
  if (!(await handOver(say, version))) {
    try {
      return await connectOnce();
    } catch {}
  }
  let agent = given === undefined ? agentProgram() : given;
  let child = start({ agent });
  let starts = 1;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      return await connectOnce();
    } catch {}
    // An agent that ended before the helper listened (it refused, or could not run Node): the
    // helper on Node directly, once.
    if (agent && child.exitCode !== null) {
      say(`PairBrowse Agent ended (${child.exitCode}); starting the helper on Node`);
      agent = null;
      child = start({ agent: null });
      starts++;
    } else if (typeof child.exitCode === "number" && starts < 3 && !pidAlive(lockHolder())) {
      // The one started left (an old helper still held the lock as it stopped), and nobody holds
      // it now: once more.
      child = start({ agent: null });
      starts++;
    }
  }
  throw new Error(`couldn't reach the PairBrowse daemon; see ${paths.daemonLog}`);
}
