// Server mode, Phase A (spec server-mode section 4, step 46): a real helper and browser on the
// helper's own virtual screen (display "xvfb", no DISPLAY), headed with its sandbox on. The screen
// and the browser are killed under it and come back with the tabs, each agent's tab as its own;
// a stop leaves nothing behind, a killed helper's screen is reaped by the next one, a login
// survives a restart, and with keep-alive the browser comes back by itself until it keeps
// crashing. Needs Linux with Xvfb and xauth, and PAIRBROWSE_TEST_RUNTIME; a system that can't run
// the browser's sandbox (no user namespaces) fails here, since server mode never starts without it.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { session } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { SCREEN, browserPid, canRunXvfb, commandLine, logCount, logText, pidAlive, sandboxOf, screenRecord, serverHome, signalHelper, startServerHelper, startSite } from "../helpers/server.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime && "set PAIRBROWSE_TEST_RUNTIME") || (!canRunXvfb() && "Linux with Xvfb and xauth only");
const T = { skip: SKIP, timeout: 300_000 };

const cookieLine = (r) => text(r).match(/cookies: [^\n"]*/)?.[0] || "(no cookie line)";
const pageUrl = (r) => text(r).match(/Page URL: (\S+)/)?.[1] || "";
const display = (rec) => Number(rec.display.slice(1));
// The close handler's own line (not keep-alive's "the browser closed by itself").
const CLOSED = /Z browser closed$/;

// One helper and site for a test: everything ends with it, the home removed; a failure carries
// the end of the helper's log.
async function withHelper(config, env, fn) {
  const site = await startSite();
  const home = serverHome(runtime, { config });
  const run = { home, site, helpers: [], open: [] };
  run.start = async () => { const h = await startServerHelper(home, { env }); run.helpers.push(h.daemon); run.helper = h; return h; };
  run.agent = async (name, parent) => { const s = await session(run.helper.socketPath, name, parent ? { pairbrowseParent: parent } : {}); run.open.push(s); return s; };
  try {
    await fn(run);
  } catch (e) {
    throw new Error(`${e.message}\n--- daemon.log ---\n${logText(home).slice(-3000)}`, { cause: e });
  } finally {
    for (const s of run.open) s.sock.destroy();
    for (const d of run.helpers) await signalHelper(d, "SIGTERM").then((ok) => ok || signalHelper(d, "SIGKILL"));
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("starts headed on its own virtual screen; window matches virtualScreen 1280x800; no sandbox warning", T, async () => {
  await withHelper({}, {}, async ({ start, agent, site, home }) => {
    const { daemon } = await start();
    const a = await agent("a");
    await a.tool("browser_navigate", { url: site.url("/size") }, 120_000);
    await a.tool("browser_wait_for", { text: " end" });
    const m = /size: (\{.*?\}) end/s.exec(text(await a.tool("browser_snapshot", {})));
    assert.ok(m, "the page showed its sizes");
    const size = JSON.parse(m[1].replace(/\\"/g, '"'));
    assert.deepEqual([size.sw, size.sh], [SCREEN.width, SCREEN.height], "the screen pages read is the virtual screen");
    assert.ok(size.iw > 0 && size.iw <= SCREEN.width && size.ih > 0 && size.ih <= SCREEN.height, `the page shows inside it: ${JSON.stringify(size)}`);
    const rec = screenRecord(home);
    assert.ok(rec && pidAlive(rec.pid), "its own Xvfb runs, with its record");
    assert.deepEqual(rec.geometry, SCREEN);
    const pid = browserPid(daemon.pid);
    assert.ok(pid, "the browser runs");
    assert.doesNotMatch(commandLine(pid), /--headless/, "headed");
    assert.match(commandLine(pid), new RegExp(`--window-size=${SCREEN.width},${SCREEN.height} .*--window-position=0,0|--window-position=0,0 .*--window-size=${SCREEN.width},${SCREEN.height}`), "the window fills the screen from its top-left corner");
    const box = sandboxOf(pid);
    assert.equal(box.noSandboxSwitch, false, "no --no-sandbox");
    assert.ok(box.renderers > 0 && box.namespaced === box.renderers, `every renderer in its own namespaces: ${JSON.stringify(box)}`);
    if (process.arch === "x64") assert.equal(box.seccomp, box.renderers, "and the seccomp filter");
    const status = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.match(status, new RegExp(`virtual screen ${rec.display} ${SCREEN.width}x${SCREEN.height}`));
    assert.doesNotMatch(status, /sandbox is off|sandbox stays on/i, "no sandbox warning");
    assert.doesNotMatch(logText(home), /sandbox is off/i);
  });
});

test("Xvfb killed: next action brings a new screen and the tabs back, active tab first", T, async () => {
  await withHelper({}, {}, async ({ start, agent, site, home }) => {
    const { daemon } = await start();
    const a = await agent("a");
    await a.tool("browser_navigate", { url: site.url("/one") }, 120_000);
    await a.tool("browser_tabs", { action: "new", url: site.url("/two") });
    await a.tool("browser_tabs", { action: "new", url: site.url("/three") });
    const list = text(await a.tool("browser_tabs", { action: "list" }));
    const two = list.match(/^- (\d+):[^\n]*\/two\)/m)?.[1];
    await a.tool("browser_tabs", { action: "select", index: Number(two) });
    await sleep(2500); // the tabs file's debounce
    const before = screenRecord(home);
    process.kill(before.pid, "SIGKILL");
    await until("the screen's end noticed", () => /virtual screen :\d+ ended by itself/.test(logText(home)), 20_000, 100);
    await until("the browser closed", () => logCount(home, CLOSED) >= 1, 20_000, 100);
    assert.equal(daemon.exitCode, null, "the helper lives on");
    await sleep(500);
    const b = await agent("b");
    assert.equal(pageUrl(await b.tool("browser_snapshot", {}, 120_000)), site.url("/two"), "the first action starts on the tab that was active");
    const back = text(await b.tool("browser_tabs", { action: "list" }));
    for (const p of ["/one", "/two", "/three"]) assert.ok(back.includes(`](${site.url(p)})`), `${p} is back: ${back}`);
    const after = screenRecord(home);
    assert.ok(after && after.pid !== before.pid && pidAlive(after.pid), "a new Xvfb, with its record");
    assert.ok(!pidAlive(before.pid));
    assert.match(text(await b.tool("pairbrowse_status", { kind: "claude", text: "Checking" })), new RegExp(`virtual screen ${after.display} `));
  });
});

test("browser killed: an agent's tab comes back as its successor", T, async () => {
  await withHelper({}, { PAIRBROWSE_TEST_RESUME_GRACE_MS: "60000" }, async ({ start, agent, site, home }) => {
    const { daemon } = await start();
    const a = await agent("a", 70001);
    await a.tool("browser_navigate", { url: site.url("/alpha") }, 120_000);
    const b = await agent("b", 70002);
    await b.tool("browser_tabs", { action: "new", url: site.url("/beta") });
    assert.equal(pageUrl(await b.tool("browser_snapshot", {})), site.url("/beta"));
    assert.equal(pageUrl(await a.tool("browser_snapshot", {})), site.url("/alpha"));
    await sleep(2500); // the tabs file's debounce
    const pid = browserPid(daemon.pid);
    assert.ok(pid, "the browser process is found");
    process.kill(pid, "SIGKILL");
    await until("the browser closed", () => logCount(home, CLOSED) >= 1, 20_000, 100);
    await until("both connections ended", () => a.sock.destroyed && b.sock.destroyed, 10_000, 100);
    // Both bridges come back (the same app sessions), B first: B's tab was the active one.
    const b2 = await agent("b2", 70002);
    const a2 = await agent("a2", 70001);
    assert.equal(pageUrl(await b2.tool("browser_snapshot", {}, 120_000)), site.url("/beta"), "B is in its own tab again");
    assert.equal(pageUrl(await a2.tool("browser_snapshot", {}, 120_000)), site.url("/alpha"), "A too, never B's");
    assert.match(logText(home), /participant \S+ resumes /);
  });
});

test("SIGTERM leaves no Xvfb, lock, socket, cookie, record, browser.sock or daemon.lock", T, async () => {
  await withHelper({}, {}, async ({ start, agent, site, home, helpers }) => {
    const { daemon } = await start();
    const a = await agent("a");
    await a.tool("browser_navigate", { url: site.url("/one") }, 120_000);
    const rec = screenRecord(home);
    const n = display(rec);
    assert.ok(existsSync(`/tmp/.X${n}-lock`) && existsSync(join(home, "run", "Xauthority")));
    a.sock.destroy();
    assert.ok(await signalHelper(daemon, "SIGTERM"), "the helper exits on SIGTERM");
    helpers.length = 0;
    await until("Xvfb ended", () => !pidAlive(rec.pid), 5000, 100);
    for (const f of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`, join(home, "run", "Xauthority"), join(home, "run", "Xauthority.json"), join(home, "run", "browser.sock"), join(home, "daemon.lock")]) {
      assert.ok(!existsSync(f), `${f} is gone`);
    }
  });
});

test("helper SIGKILLed: the next helper reaps and reuses the display", T, async () => {
  await withHelper({}, {}, async ({ start, agent, site, home }) => {
    const first = await start();
    const a = await agent("a");
    await a.tool("browser_navigate", { url: site.url("/one") }, 120_000);
    const rec = screenRecord(home);
    a.sock.destroy();
    assert.ok(await signalHelper(first.daemon, "SIGKILL"));
    assert.ok(pidAlive(rec.pid), "its Xvfb outlives a killed helper");
    await sleep(1000); // the browser leaves once its pipe closed
    await start();
    const b = await agent("b");
    assert.ok(!(await b.tool("browser_navigate", { url: site.url("/two") }, 120_000)).result?.isError);
    assert.match(logText(home), new RegExp(`virtual screen ${rec.display}: ended the Xvfb a stopped helper left running \\(pid ${rec.pid}\\)`));
    assert.ok(!pidAlive(rec.pid), "the old Xvfb is ended");
    const now = screenRecord(home);
    assert.equal(now.display, rec.display, "and its display used again");
    assert.notEqual(now.pid, rec.pid);
  });
});

test("a login cookie survives a restart", T, async () => {
  await withHelper({}, {}, async ({ start, agent, site, helpers }) => {
    const first = await start();
    const a = await agent("a");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", name: "shop" }, 120_000)), /Created and switched/);
    await a.tool("browser_navigate", { url: site.url("/login") });
    assert.equal(cookieLine(await a.tool("browser_navigate", { url: site.url("/account") })), "cookies: login=kept", "the site set the cookie");
    a.sock.destroy();
    assert.ok(await signalHelper(first.daemon, "SIGTERM"));
    helpers.length = 0;
    await start();
    const b = await agent("b");
    const list = text(await b.tool("browser_tabs", { action: "list" }, 120_000));
    assert.match(list, /\/account\)/, "the session and its tab come back");
    assert.equal(cookieLine(await b.tool("browser_navigate", { url: site.url("/account") })), "cookies: login=kept", "the login came back");
  });
});

test("keepAlive with no agent: the browser comes back by itself; three crashes stop it", T, async () => {
  const WINDOW = 45_000;
  await withHelper({ server: { keepAlive: true } }, { PAIRBROWSE_TEST_RELAUNCH_MS: "500", PAIRBROWSE_TEST_CRASH_WINDOW_MS: String(WINDOW) }, async ({ start, agent, site, home }) => {
    const { daemon } = await start();
    // Nobody connected: the browser starts with the helper, and each time it is killed it comes back.
    for (let n = 1; n <= 3; n++) {
      await until(`start ${n}`, () => logCount(home, /browser started \(session/) >= n, 60_000, 100);
      const pid = browserPid(daemon.pid);
      assert.ok(pid, `browser ${n} runs`);
      process.kill(pid, "SIGKILL");
      await until(`close ${n} noticed`, () => logCount(home, CLOSED) >= n, 20_000, 100);
      assert.equal(daemon.exitCode, null, "the helper never ends with keep-alive");
    }
    assert.match(logText(home), /closed by itself 3 times within 45 s, each soon after it started: no new start for 45 s/);
    assert.equal(logCount(home, /keep-alive: the browser closed by itself; it starts again in 0\.5 s/), 2, "two starts were planned, not a third");
    await sleep(2000);
    assert.equal(logCount(home, /browser started \(session/), 3, "no fourth start");
    assert.equal(browserPid(daemon.pid), 0);
    const a = await agent("a");
    const refused = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.match(refused, /the browser keeps crashing on this machine: see daemon\.log/);
    // Once the hold is over, the next action starts it.
    await sleep(WINDOW);
    assert.ok(!(await a.tool("browser_navigate", { url: site.url("/one") }, 120_000)).result?.isError);
    assert.ok(browserPid(daemon.pid), "the browser runs again");
  });
});

