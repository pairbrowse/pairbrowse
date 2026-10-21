// The server-mode Phase A opt-in cases, the side that runs inside the A13 container
// (server-docker.test.mjs starts it there; spec server-mode step 46). One case per run, named by
// its first argument; it prints what it saw as one line "RESULT <json>" for the test to judge, and
// exits 0 unless the case itself could not run.
//
//   restart    a page opens with the sandbox on; a stop and start bring back the session, its
//              tabs and its login
//   refused    the launch is refused (Docker's default seccomp profile, or root) and no browser
//              process ever starts
//   keepalive  with server.keepAlive, a helper SIGKILLed and started again (as systemd's
//              Restart=on-failure would) brings the browser back by itself with the session and tabs
//
// PAIRBROWSE_TEST_RUNTIME: the pinned runtime (mounted); PLAYWRIGHT_BROWSERS_PATH: where the
// driver's browser was installed. Homes are made under the container's temp folder.
import { rmSync } from "node:fs";
import { userInfo } from "node:os";
import { session } from "../../helpers/live.mjs";
import { sleep, text, until } from "../../helpers/util.mjs";
import { browserPid, logText, pidAlive, processes, sandboxOf, screenRecord, serverHome, signalHelper, startServerHelper, startSite } from "../../helpers/server.mjs";
import { driverBrowserPath } from "../../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const which = process.argv[2];
const cookieLine = (r) => text(r).match(/cookies: [^\n"]*/)?.[0] || "(no cookie line)";
const result = { case: which, uid: userInfo().uid };

const site = await startSite();
const home = serverHome(runtime, { prefix: `pbsrv-${which}-`, config: which === "keepalive" ? { server: { keepAlive: true } } : {} });
const helpers = [];
const sockets = [];
const start = async () => { const h = await startServerHelper(home); helpers.push(h.daemon); return h; };
const agent = async (socketPath, name) => { const s = await session(socketPath, name); sockets.push(s); return s; };
// The browser processes running now: anything started from the driver's browser.
const exe = driverBrowserPath(runtime);
const browsers = () => processes().filter((p) => p.cmd.startsWith(exe)).length;

try {
  if (which === "restart") {
    const first = await start();
    const a = await agent(first.socketPath, "a");
    result.created = text(await a.tool("pairbrowse_session", { action: "new", name: "work" }, 180_000));
    await a.tool("browser_navigate", { url: site.url("/login") }, 180_000);
    result.cookieBefore = cookieLine(await a.tool("browser_navigate", { url: site.url("/account") }));
    await a.tool("browser_tabs", { action: "new", url: site.url("/two") });
    result.sandbox = sandboxOf(browserPid(first.daemon.pid));
    result.status = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    result.screen = screenRecord(home);
    await sleep(2500); // the tabs file's debounce
    a.sock.destroy();
    result.stopped = await signalHelper(first.daemon, "SIGTERM");
    result.screenGone = !pidAlive(result.screen.pid);
    const again = await start();
    const b = await agent(again.socketPath, "b");
    result.listAfter = text(await b.tool("browser_tabs", { action: "list" }, 180_000));
    result.statusAfter = text(await b.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    result.cookieAfter = cookieLine(await b.tool("browser_navigate", { url: site.url("/account") }));
  } else if (which === "refused") {
    const h = await start();
    const a = await agent(h.socketPath, "a");
    result.navigate = text(await a.tool("browser_navigate", { url: site.url("/one") }, 180_000));
    result.status = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }, 180_000));
    await sleep(3000);
    result.browsers = browsers();
    result.log = logText(home).split("\n").filter((l) => /sandbox|root/i.test(l)).slice(-10);
  } else if (which === "keepalive") {
    const first = await start();
    const a = await agent(first.socketPath, "a");
    await a.tool("pairbrowse_session", { action: "new", name: "work" }, 180_000);
    await a.tool("browser_navigate", { url: site.url("/one") }, 180_000);
    await a.tool("browser_tabs", { action: "new", url: site.url("/two") });
    await sleep(2500); // the tabs file's debounce
    const screen = screenRecord(home);
    a.sock.destroy();
    result.killed = await signalHelper(first.daemon, "SIGKILL");
    await sleep(1000); // the service manager's restart pause
    const mark = logText(home).length;
    const again = await start();
    // Nobody connected: the browser starts with the helper and its tabs come back.
    await until("the browser started by itself", () => /browser started \(session work\)/.test(logText(home).slice(mark)), 180_000, 200);
    await until("its tabs restored", () => /restored \d+ tabs/.test(logText(home).slice(mark)), 180_000, 200);
    result.startedAlone = browserPid(again.daemon.pid) > 0;
    result.restored = logText(home).slice(mark).match(/restored (\d+) tabs/)?.[1];
    result.reaped = new RegExp(`ended the Xvfb a stopped helper left running \\(pid ${screen.pid}\\)`).test(logText(home).slice(mark));
    result.oldScreenGone = !pidAlive(screen.pid);
    const b = await agent(again.socketPath, "b");
    result.listAfter = text(await b.tool("browser_tabs", { action: "list" }, 180_000));
    result.sessionAfter = text(await b.tool("pairbrowse_session", { action: "list" }));
    result.statusAfter = text(await b.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
  } else {
    throw new Error(`unknown case ${which}`);
  }
} catch (e) {
  result.error = String(e?.stack || e);
  result.log = logText(home).slice(-3000);
} finally {
  for (const s of sockets) s.sock.destroy();
  for (const d of helpers) if (!(await signalHelper(d, "SIGTERM"))) await signalHelper(d, "SIGKILL");
  site.close();
  rmSync(home, { recursive: true, force: true });
}
result.base = site.base;
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
