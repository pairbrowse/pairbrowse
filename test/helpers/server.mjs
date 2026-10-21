// Shared by the server-mode live tests (test/integration/server-display.test.mjs and, inside the A13
// container, test/optin/server/server-run.mjs; spec server-mode Phase A): a helper home on its own
// virtual screen, the helper started with no screen of its own, the screen's ownership record, the
// browser process and its renderers' sandbox as /proc shows them, and a local site. Linux only
// (/proc). No project code is loaded here.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { attachDaemon, testBase } from "./live.mjs";
import { driverBrowserPath, root } from "./daemon.mjs";
import { sleep } from "./util.mjs";

// The virtual screen the tests ask for (virtualScreen), not the 1366x900 default.
export const SCREEN = { width: 1280, height: 800, depth: 24 };

// Whether this machine can run the helper's own virtual screen: Linux with Xvfb and xauth.
export const canRunXvfb = () => process.platform === "linux" && ["Xvfb", "xauth"].every((bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0);

// A helper home under testBase() with the runtime linked in (what lets the helper read its test
// switches) and config.json: the browser headed on its own virtual screen (display "xvfb",
// SCREEN), no picker, no screenshots, then config's own keys.
export function serverHome(runtime, { prefix = "pbs-", config = {}, executablePath } = {}) {
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, prefix));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath: executablePath ?? driverBrowserPath(runtime), display: "xvfb", virtualScreen: SCREEN, sessionPicker: false, screenshots: false, ...config }));
  return home;
}

// The helper for home, as a service manager starts it: no DISPLAY, WAYLAND_DISPLAY or XAUTHORITY
// from this process, env added. Resolves once it listens: { daemon, socketPath }.
export async function startServerHelper(home, { env = {}, ms = 90_000 } = {}) {
  const base = { ...process.env };
  for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete base[k];
  const out = openSync(join(home, "daemon.stderr.log"), "a");
  let daemon;
  try {
    daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...base, ...env, PAIRBROWSE_HOME: home }, stdio: ["ignore", out, out] });
  } finally { closeSync(out); }
  const socketPath = join(home, "run", "browser.sock");
  try {
    (await attachDaemon({ socketPath, daemon, home, ms })).destroy();
  } catch (e) { daemon.kill("SIGKILL"); throw e; }
  return { daemon, socketPath };
}

// Sends signal to the helper; resolves whether it exited within ms.
export async function signalHelper(daemon, signal = "SIGTERM", ms = 15_000) {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return true;
  const exited = new Promise((r) => daemon.once("exit", () => r(true)));
  daemon.kill(signal);
  return Promise.race([exited, sleep(ms).then(() => false)]);
}

// The helper's log (daemon.log), or "".
export const logText = (home) => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
// How many lines of the log match re.
export const logCount = (home, re) => logText(home).split("\n").filter((l) => re.test(l)).length;

// The virtual screen's ownership record (run/<name>.json), or null.
export function screenRecord(home, name = "Xauthority") {
  try { return JSON.parse(readFileSync(join(home, "run", `${name}.json`), "utf8")); } catch { return null; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

// Every process /proc shows: { pid, ppid, cmd } (cmd's arguments joined by spaces).
export function processes() {
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const stat = read(`/proc/${d}/stat`);
    const ppid = Number(stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (stat) out.push({ pid: Number(d), ppid, cmd: commandLine(d) });
  }
  return out;
}

// The browser under the helper: its child that isn't a node process, the virtual screen (Xvfb) or
// one of the browser's own helpers (--type=), or 0.
export function browserPid(helperPid) {
  return processes().find((p) => p.ppid === helperPid && p.cmd && !/^\S*(\/|^)(node|Xvfb)(\s|$)/.test(p.cmd) && !/--type=/.test(p.cmd))?.pid || 0;
}

// A process's command line, its arguments joined by spaces ("" when it's gone).
export const commandLine = (pid) => (read(`/proc/${pid}/cmdline`) || "").replace(/\0+$/, "").split("\0").join(" ");

// Every process the browser started, at any depth.
export function descendants(pid) {
  const all = processes();
  const found = [];
  for (let gen = [pid]; gen.length;) {
    const next = all.filter((p) => gen.includes(p.ppid));
    found.push(...next);
    gen = next.map((p) => p.pid);
  }
  return found;
}

// The browser's sandbox as the kernel shows it: its command line has no --no-sandbox, and every
// process its sandboxed zygote started (the renderers: forked from the zygote, they keep its
// command line; the zygote's own --no-zygote-sandbox twin, for utility processes, doesn't count)
// runs in a PID namespace of its own (NSpid names two pids or more: the namespace layer of the
// sandbox) and, where the kernel runs the browser's own instructions, under a seccomp filter
// (Seccomp 2). { browser, noSandboxSwitch, renderers, namespaced, seccomp } (the last two: how many).
export function sandboxOf(pid) {
  const cmd = (read(`/proc/${pid}/cmdline`) || "").split("\0");
  const tree = descendants(pid);
  const zygotes = new Set(tree.filter((p) => /--type=zygote/.test(p.cmd) && !/--no-zygote-sandbox/.test(p.cmd)).map((p) => p.pid));
  const renderers = tree.filter((p) => zygotes.has(p.ppid) || /--type=renderer/.test(p.cmd));
  const status = renderers.map((p) => read(`/proc/${p.pid}/status`) || "");
  return {
    browser: pid,
    noSandboxSwitch: cmd.some((a) => /^--no-sandbox(=|$)/i.test(a)),
    renderers: renderers.length,
    namespaced: status.filter((s) => (/^NSpid:\s*(.*)$/m.exec(s)?.[1].trim().split(/\s+/).length || 0) >= 2).length,
    seccomp: status.filter((s) => /^Seccomp:\s*2$/m.test(s)).length,
  };
}

// The local site: /login sets a persistent cookie (a login); every page shows its path and the
// cookies that came back ("cookies: ..."); /size shows the screen and the viewport as the page
// reads them ("size: {json} end"). Resolves { base, url(path), close() }.
export function startSite() {
  const server = http.createServer((req, res) => {
    const login = req.url.startsWith("/login");
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", ...(login ? { "set-cookie": ["login=kept; Path=/; Max-Age=86400"] } : {}) });
    const size = req.url.startsWith("/size") ? `<p id=s>size: waiting</p><script>
document.getElementById("s").textContent = "size: " + JSON.stringify({ sw: screen.width, sh: screen.height, iw: innerWidth, ih: innerHeight }) + " end";
</script>` : "";
    res.end(`<!doctype html><title>Page ${req.url}</title><h1>Page ${req.url}</h1><p>cookies: ${req.headers.cookie || "(none)"}</p>${size}`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, url: (p) => `${base}${p}`, close: () => server.close() });
  }));
}
