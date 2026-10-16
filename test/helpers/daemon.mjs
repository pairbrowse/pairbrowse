// Starting a real helper (scripts/daemon.mjs) for a live test, in a home of the test's own under
// the system's temp folder: the home (runtime link, config.json), the spawn (its stderr in
// <home>/daemon.stderr.log), the wait until it listens, and the stop.
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { testBase, attachDaemon } from "./live.mjs";
import { sleep } from "./util.mjs";

// The repository's root.
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Patchright's build from the pinned runtime: the browser the live tests drive.
export const driverBrowserPath = (runtime) => createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();

// A new helper home under testBase() with the runtime linked in (the link is what lets the helper
// read its PAIRBROWSE_TEST_* switches, scripts/testenv.mjs). With config, writes config.json:
// headless, no screen, no screenshots, then config's own keys; config.browserArgs are added after
// --headless=new.
export function helperHome(runtime, { prefix = "pbh-", config } = {}) {
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, prefix));
  if (runtime) symlinkSync(runtime, join(home, "runtime"), "dir");
  if (config) {
    const { browserArgs = [], ...rest } = config;
    writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath: driverBrowserPath(runtime), browserArgs: ["--headless=new", ...browserArgs], display: "none", screenshots: false, ...rest }));
  }
  return home;
}

// The helper's process for home, its stdout and stderr appended to <home>/daemon.stderr.log.
// env is added to this process's environment; PAIRBROWSE_HOME is always home.
export function spawnDaemon(home, { env = {}, cwd = root } = {}) {
  const out = openSync(join(home, "daemon.stderr.log"), "a");
  try {
    return spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd, env: { ...process.env, ...env, PAIRBROWSE_HOME: home }, stdio: ["ignore", out, out] });
  } finally {
    closeSync(out);
  }
}

// Ends a helper this test started: SIGTERM, then up to ms for it to exit.
export async function stopDaemon(daemon, ms = 10_000) {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(ms)]);
}

// A helper for home, started and listening: { daemon, home, socketPath, sock (connected), stop() }.
// stop() closes the socket, ends the helper and, with remove, deletes the home.
export async function startHelper(home, { env = {}, ms = 60_000, remove = false } = {}) {
  const daemon = spawnDaemon(home, { env });
  const socketPath = join(home, "run", "browser.sock");
  let sock;
  try {
    sock = await attachDaemon({ socketPath, daemon, home, ms });
  } catch (e) {
    await stopDaemon(daemon);
    throw e;
  }
  return {
    daemon, home, socketPath, sock,
    async stop() {
      sock.destroy();
      await stopDaemon(daemon);
      if (remove) rmSync(home, { recursive: true, force: true });
    },
  };
}
