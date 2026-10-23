// Starting a real helper (scripts/daemon.mjs) for a live test, in a home of the test's own under
// the system's temp folder: the home (runtime link, config.json), the spawn (its stderr in
// <home>/daemon.stderr.log), the wait until it listens, and the stop.
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, openSync, closeSync, rmSync, cpSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { testBase, attachDaemon } from "./live.mjs";
import { sleep } from "./util.mjs";

// The repository's root.
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Patchright's build from the pinned runtime: the browser the live tests drive.
export const driverBrowserPath = (runtime) => createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();

// The native build the live tests' helpers run instead of Playwright's: PAIRBROWSE_TEST_EXECUTABLE
// naming a native build (its Contents/MacOS/pairbrowse on macOS) with PAIRBROWSE_TEST_ENGINE (the
// engine pack, copied into each home by linkInstalls), else null. Read-only: the build is launched
// from where it is, each helper on a home of its own. The build's manifest is read here rather than
// through scripts/native-engine.mjs: a project module loaded now would fix paths.mjs on this
// process's home before a test sets its own (handoff).
// nativeVersion: that build's version ("155.0.8059.84"), else null.
const nativeBuild = (() => {
  const exe = process.env.PAIRBROWSE_TEST_EXECUTABLE, engine = process.env.PAIRBROWSE_TEST_ENGINE;
  if (!exe || !engine) return null;
  const contents = dirname(dirname(exe));
  for (const f of [join(contents, "Resources", "PairBrowse-build.json"), join(dirname(exe), "PairBrowse-build.json")]) {
    try { const m = JSON.parse(readFileSync(f, "utf8")); if (m?.product === "PairBrowse" && typeof m.version === "string") return { exe, version: m.version }; } catch {}
  }
  return null;
})();
export const nativeExe = nativeBuild?.exe ?? null;
export const nativeVersion = nativeBuild?.version ?? null;

// The browser keys of a test helper's config.json: the native build (nativeExe) or Patchright's.
export const testBrowser = (runtime) => (nativeExe ? { executablePath: nativeExe, browserEngine: "pairbrowse" } : { executablePath: driverBrowserPath(runtime) });

// What a test home needs of the installs: the runtime linked in and, on the native build, the
// engine pack copied (the helper checks and may rewrite its own).
export function linkInstalls(home, runtime) {
  if (runtime) symlinkSync(runtime, join(home, "runtime"), "dir");
  if (nativeExe) cpSync(process.env.PAIRBROWSE_TEST_ENGINE, join(home, "engine"), { recursive: true });
}

// A new helper home under testBase() with the runtime linked in (the link is what lets the helper
// read its PAIRBROWSE_TEST_* switches, scripts/testenv.mjs). With config, writes config.json:
// testBrowser's, headless, no screen, no screenshots, then config's own keys; config.browserArgs are added after
// --headless=new.
export function helperHome(runtime, { prefix = "pbh-", config } = {}) {
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, prefix));
  linkInstalls(home, runtime);
  if (config) {
    const { browserArgs = [], ...rest } = config;
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...testBrowser(runtime), browserArgs: ["--headless=new", ...browserArgs], display: "none", screenshots: false, ...rest }));
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
