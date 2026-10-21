// The Phase E opt-in cases on the native Linux build, the side that runs inside the A13 container
// (linux-graphics.test.mjs and graphics-recovery.test.mjs start it there; spec server-mode
// decision 10, step 49). One case per run, named by its first argument; it prints what it saw as
// one line "RESULT <json>" for the test to judge, and exits 0 unless the case itself could not run.
//
//   graphics   the first start measures once (a host without a GPU: software rendering, the page
//              measured under the engine's identity), then a page reads what pages read, the status
//              part, the log, the default profile's verdict and the sandbox; then, on the same home
//              and measurement, a start that asks for a GPU is refused and no browser runs
//   recovery   after the same start, the browser is killed; the next action brings it back on the
//              same request and measurement, without measuring again
//
// /runtime: the pinned runtime; /cache: the pinned Linux build and engine pack (native-cache.mjs),
// installed first by native-linux.mjs as the helper's install step installs them.
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { session } from "../../helpers/live.mjs";
import { sleep, text, until } from "../../helpers/util.mjs";
import { browserPid, logCount, logText, pidAlive, processes, sandboxOf, serverHome, signalHelper, startServerHelper } from "../../helpers/server.mjs";
import { installNativeLinux } from "./native-linux.mjs";
import { GRAPHICS_PAGE, parseGraphics, parseWheel, servePage } from "./graphics-page.mjs";
import { MEASURING_BUSY } from "../../../scripts/daemon/browser/graphics.mjs";
import { GRAPHICS_STOP_MS, GRAPHICS_TIMEOUT_MS } from "../../../scripts/native/check.mjs";

const RUNTIME = "/runtime";
const which = process.argv[2];
const result = { case: which, uid: userInfo().uid };
const helpers = [];
const sockets = [];
let home = null;

// The default profile's record and its verdict for build (browser-profiles/<id>.json, kind "config").
function defaultValidation(h, build) {
  const dir = join(h, "browser-profiles");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let p;
    try { p = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (p?.kind === "config") return p.validation?.[build] ?? null;
  }
  return null;
}
// The native browsers running now (the build's own processes, not its helpers).
const browsers = (exe) => processes().filter((p) => p.cmd.startsWith(exe) && !/--type=/.test(p.cmd)).length;

// An agent's connection to the helper: its tool calls go through the one graphics measurement
// (a minute or two under emulation; refused at once while it runs, the agent retries, as the
// refusal tells it to).
async function connect(socketPath, name) {
  const s = await session(socketPath, name);
  sockets.push(s);
  const tool = async (tool, args = {}, ms = 180_000) => {
    const deadline = Date.now() + GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS + 120_000;
    for (;;) {
      const r = await s.tool(tool, args, ms);
      if (!text(r).includes(MEASURING_BUSY) || Date.now() > deadline) return r;
      await sleep(3000);
    }
  };
  return { sock: s.sock, tool };
}
async function start(h, env = {}) {
  const started = await startServerHelper(h, { env, ms: 180_000 });
  helpers.push(started.daemon);
  const a = await connect(started.socketPath, "a");
  return { ...started, ...a, connect: (name) => connect(started.socketPath, name) };
}
async function readPage(h, url) {
  const nav = await h.tool("browser_navigate", { url });
  await h.tool("browser_wait_for", { text: " end" });
  const shown = text(await h.tool("browser_snapshot", {}));
  const page = parseGraphics(shown);
  if (!page) throw new Error(`the page showed nothing:\n${text(nav).slice(0, 1500)}\n${shown.slice(0, 1500)}`);
  return page;
}

const site = await servePage(GRAPHICS_PAGE);
try {
  const native = await installNativeLinux();
  result.native = { version: native.version, exe: native.exe.replace(/^.*\/(browser|pairbrowse)/, "$1") };
  home = serverHome(RUNTIME, { prefix: `pb-graphics-${which}-`, executablePath: native.exe, config: { browserEngine: "pairbrowse", sessionPicker: false } });
  cpSync(native.engine, join(home, "engine"), { recursive: true });

  const h = await start(home, { PAIRBROWSE_TEST_RELAUNCH_MS: "1000" });
  result.page = await readPage(h, site.url);
  // The wheel as an agent's scroll turns it: the events a tall page saw after one
  // pairbrowse_scroll down (whole notches of the platform pages are told about).
  if (which === "graphics") {
    await h.tool("browser_navigate", { url: site.wheelUrl });
    await h.tool("browser_wait_for", { text: "wheel:" });
    result.scroll = text(await h.tool("pairbrowse_scroll", { direction: "down" }));
    result.wheel = parseWheel(text(await h.tool("browser_snapshot", {})));
  }
  result.status = text(await h.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
  const pid = browserPid(h.daemon.pid);
  result.sandbox = pid ? sandboxOf(pid) : null;
  result.validation = defaultValidation(home, native.version);
  result.measured = logCount(home, /measuring graphics once for this browser version/);
  result.launchLines = logText(home).split("\n").filter((l) => /launch: graphics|graphics probe|graphics not measured/.test(l)).slice(-12);

  if (which === "recovery") {
    // After a crash the helper ends agents' connections (their bridges reconnect within 10 s and
    // are back in their tabs); this agent connects again, as a bridge does.
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && pidAlive(pid); i++) await sleep(100);
    result.killed = !pidAlive(pid);
    await until("the helper saw the browser close", () => /browser closed/.test(logText(home)), 30_000, 200);
    h.sock.destroy();
    const b = await h.connect("b");
    result.pageAfter = await readPage(b, site.url);
    result.statusAfter = text(await b.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    const again = browserPid(h.daemon.pid);
    result.newBrowser = again && again !== pid;
    result.sandboxAfter = again ? sandboxOf(again) : null;
    result.validationAfter = defaultValidation(home, native.version);
    result.measuredAfter = logCount(home, /measuring graphics once for this browser version/);
    result.launchLinesAfter = logText(home).split("\n").filter((l) => /launch: graphics|browser started|browser closed|measured again/.test(l)).slice(-12);
  }
  h.sock.destroy();
  result.stopped = await signalHelper(h.daemon, "SIGTERM");

  if (which === "graphics") {
    // The same home and measurement, a GPU asked for: refused by name before anything starts.
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, pairbrowse: { ...(config.pairbrowse || {}), graphics: "gpu" } }));
    const g = await start(home);
    result.gpu = { navigate: text(await g.tool("browser_navigate", { url: site.url })), browsers: browsers(native.exe), measured: logCount(home, /measuring graphics once for this browser version/) };
    result.gpu.status = text(await g.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    g.sock.destroy();
    await signalHelper(g.daemon, "SIGTERM");
  }
} catch (e) {
  result.error = String(e?.stack || e);
  if (home) result.log = logText(home).slice(-6000);
} finally {
  for (const s of sockets) s.sock.destroy();
  for (const d of helpers) await signalHelper(d, "SIGTERM").catch(() => {});
  site.close();
  if (home && result.log === undefined) result.log = logText(home).split("\n").filter((l) => /launch|graphics|refus|doesn't start/i.test(l)).slice(-40).join("\n");
}
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
