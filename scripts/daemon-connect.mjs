// Reaching the local helper (scripts/daemon.mjs) over its private socket, starting it when it isn't
// running: the bridge (scripts/launch.mjs) and the opener (scripts/open.mjs) share this.
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureDirs } from "./paths.mjs";
import { ensureRuntime } from "./runtime.mjs";
import { withoutTestSwitches } from "./test-gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

export function startDaemon() {
  const out = openSync(paths.daemonLog, "a");
  spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { detached: true, stdio: ["ignore", out, out], env: withoutTestSwitches(process.env) }).unref();
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
  startDaemon();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      return await connectOnce();
    } catch {}
  }
  throw new Error(`couldn't reach the PairBrowse daemon; see ${paths.daemonLog}`);
}
