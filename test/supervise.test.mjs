// Supervising the browser's surroundings (scripts/daemon/browser/supervise.mjs): the virtual screen
// started before a launch that needs one, an Xvfb that exits by itself forgotten and the browser on
// it closed (the next launch starts a new screen), and a stop that is never taken for a lost screen.
import "./helpers/home.mjs";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createBrowserState } from "../scripts/daemon/browser/state.mjs";
import { createSupervisor } from "../scripts/daemon/browser/supervise.mjs";

// A supervisor whose screens are fakes: each start gives a screen whose exit(why) acts as Xvfb
// exiting, and whose stop exits it as the real one does.
function harness({ needs = true, config = {} } = {}) {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  const logs = [], starts = [];
  const startScreen = async (log, { geometry, onExit }) => {
    const n = 99 + starts.length;
    const screen = { display: `:${n}`, env: { DISPLAY: `:${n}` }, geometry, stops: 0, nows: 0 };
    screen.exit = (why = { code: 1, signal: null }) => onExit(why);
    screen.stop = async () => { screen.stops++; screen.exit({ code: null, signal: "SIGTERM" }); };
    screen.stopNow = () => { screen.nows++; };
    starts.push(screen);
    return screen;
  };
  const sup = createSupervisor(st, { config, log: (l) => logs.push(l), startScreen, needsScreen: () => needs });
  return { st, sup, logs, starts };
}

// A browser context that records its close.
const fakeContext = () => {
  const ctx = { closed: 0, close: async () => { ctx.closed++; } };
  return ctx;
};

test("an Xvfb exit clears the screen and the next ensure starts one", async () => {
  const { st, sup, logs, starts } = harness({ config: { virtualScreen: { width: 1280, height: 800 } } });
  const first = await sup.ensureScreen();
  assert.equal(st.screen, first);
  assert.deepEqual(first.geometry, { width: 1280, height: 800, depth: 24 }, "the configured geometry, filled");
  assert.equal(await sup.ensureScreen(), first, "one screen while it runs");
  assert.equal(starts.length, 1);
  const ctx = fakeContext();
  st.contextPromise = Promise.resolve(ctx);
  first.exit({ code: null, signal: "SIGKILL" });
  assert.equal(st.screen, null, "the lost screen is forgotten at once");
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.closed, 1, "the browser on it closes (the existing close path runs)");
  assert.ok(logs.some((l) => l.includes("virtual screen :99 ended by itself (SIGKILL)")), logs.join("\n"));
  const second = await sup.ensureScreen();
  assert.notEqual(second, first);
  assert.equal(second.display, ":100");
  assert.equal(st.screen, second);
  // A late exit of the old screen never drops the new one.
  first.exit();
  assert.equal(st.screen, second);
});

test("a lost screen with no browser running only forgets the screen", async () => {
  const { st, sup } = harness();
  const screen = await sup.ensureScreen();
  screen.exit({ code: 1, signal: null });
  assert.equal(st.screen, null);
  assert.equal(st.contextPromise, null);
});

test("a stop is never a lost screen: no browser close, the screen ended once", async () => {
  const { st, sup, logs } = harness();
  const screen = await sup.ensureScreen();
  const ctx = fakeContext();
  st.contextPromise = Promise.resolve(ctx);
  await sup.stopScreen();
  await new Promise((r) => setImmediate(r));
  assert.equal(screen.stops, 1);
  assert.equal(st.screen, null);
  assert.equal(st.screenStopping, false);
  assert.equal(ctx.closed, 0, "shutdown closes the browser itself");
  assert.ok(!logs.some((l) => l.includes("ended by itself")), logs.join("\n"));
  await sup.stopScreen(); // nothing to stop: no error
  // At process exit: told to end now, and its exit then is not a lost screen either.
  const next = await sup.ensureScreen();
  sup.stopScreenNow();
  assert.equal(next.nows, 1);
  next.exit({ code: 0, signal: null });
  assert.equal(st.screen, next, "nothing runs after process exit; the screen is left as it was");
  assert.equal(ctx.closed, 0);
});

test("no screen where the machine has one of its own", async () => {
  const { st, sup, starts } = harness({ needs: false });
  assert.equal(await sup.ensureScreen(), null);
  assert.equal(starts.length, 0);
  await sup.stopScreen();
  sup.stopScreenNow();
  assert.equal(st.screen, null);
});

test("a browser that won't close after losing its screen is bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { st, sup, logs } = harness();
  const screen = await sup.ensureScreen();
  st.contextPromise = Promise.resolve({ close: () => new Promise(() => {}) });
  screen.exit();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(5000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.includes("didn't close after losing its screen")), logs.join("\n"));
});

// The wiring (read from the source: launch() needs a real browser): the launch asks the supervisor
// for its screen before the browser starts and runs it on that screen, not on st.screen read later;
// a screen lost meanwhile closes the browser; shutdown and process exit go through the supervisor.
test("launch, close and process exit go through the supervisor", () => {
  const src = (p) => readFileSync(new URL(`../scripts/daemon/${p}`, import.meta.url), "utf8");
  const launch = src("browser/launch.mjs");
  const ensure = launch.indexOf("const screen = await api.ensureScreen();");
  assert.ok(ensure > 0, "launch() keeps the screen it asked for");
  assert.ok(ensure < launch.indexOf("await launchEngine("), "the screen comes before the browser");
  assert.match(launch, /env: \{ \.\.\.process\.env, \.\.\.\(screen\?\.env \|\| \{\}\) \}/);
  assert.match(launch, /\.\.\.launchOptions\(config, \{\n\s+shell: st\.shell, firstRun, screen, profileArgs: chosen\.switches,\n/, "the window is sized to that screen (launchOptions screen), or the profile's");
  assert.doesNotMatch(launch, /st\.screen\?\.env/);
  const lostCheck = launch.slice(launch.indexOf("if (screen && st.screen !== screen) {"), launch.indexOf("api.adopt(p, ctx)"));
  assert.ok(lostCheck.includes("ctx.close()") && lostCheck.includes("the virtual screen ended while the browser started"), "a screen lost during the start closes the browser and fails the launch");
  assert.ok(launch.indexOf("await launchEngine(") < launch.indexOf("if (screen && st.screen !== screen) {"), "checked once the browser started");
  const close = launch.slice(launch.indexOf("async function close("));
  assert.match(close.slice(0, close.indexOf("\n  }\n")), /await api\.stopScreen\(\);/);
  assert.doesNotMatch(launch, /startVirtualDisplay|needsVirtualDisplay/, "only the supervisor starts a screen");
  assert.match(launch, /, launchLog, undefined, \{ server: api\.isServer\(\) \}\);/, "in server mode the launch keeps the sandbox required (engine.mjs launchEngine)");
  const context = src("context.mjs");
  assert.match(context, /const \{ stopScreenNow, [^}]*\} = Object\.assign\(api, createSupervisor\(st, deps, api\)\);/);
  assert.ok(context.indexOf("createSupervisor(st, deps, api)") < context.indexOf("createLaunch(st, deps, api)"), "api.ensureScreen exists before launch is made");
  assert.match(context, /^\s+stopScreenNow,$/m);
});

test("stopScreenNow from context marks the stop before the screen exits", async () => {
  const { st, sup } = harness();
  const screen = await sup.ensureScreen();
  const ctx = fakeContext();
  st.contextPromise = Promise.resolve(ctx);
  sup.stopScreenNow();
  assert.equal(st.screenStopping, true);
  screen.exit({ code: null, signal: "SIGTERM" });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.closed, 0, "an exit after stopScreenNow never closes the browser as a lost screen");
});

// A supervisor for the crash-loop guard: a clock the test moves, on a server or a desktop.
function guarded({ server = true } = {}) {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  const logs = [], loops = [];
  const clock = { t: 1_000_000 };
  const sup = createSupervisor(st, { config: {}, log: (l) => logs.push(l), needsScreen: () => false, server: () => server, now: () => clock.t, onCrashLoop: () => loops.push(clock.t) });
  return { st, sup, logs, loops, clock };
}
const MIN = 60_000;

test("three early unexpected closes stop launches for five minutes; late ones and a desktop don't count", () => {
  const { sup, logs, loops, clock } = guarded();
  assert.equal(sup.crashLoop(), null);
  assert.equal(sup.noteUnexpectedClose(clock.t - 10_000), false, "one");
  clock.t += MIN;
  assert.equal(sup.noteUnexpectedClose(clock.t - 2 * MIN), false, "a browser that ran for two minutes is not counted");
  assert.equal(sup.noteUnexpectedClose(clock.t - 5_000), false, "two");
  assert.equal(sup.crashLoop(), null);
  clock.t += MIN;
  assert.equal(sup.noteUnexpectedClose(clock.t - 60_000), true, "three, the last 60 s after its launch");
  assert.equal(sup.crashLoop(), "the browser keeps crashing on this machine: see daemon.log");
  assert.deepEqual(loops, [clock.t], "one message to the channels");
  assert.ok(logs.some((l) => /closed by itself 3 times within 5 minutes/.test(l)), logs.join("\n"));
  assert.equal(sup.noteUnexpectedClose(clock.t - 1000), true, "while it holds: still stopped, no second message");
  assert.equal(loops.length, 1);
  clock.t += 5 * MIN - 1;
  assert.ok(sup.crashLoop(), "for five minutes");
  clock.t += 1;
  assert.equal(sup.crashLoop(), null, "then over");
  assert.ok(logs.some((l) => /the hold is over/.test(l)));
  assert.equal(sup.noteUnexpectedClose(clock.t - 1000), false, "and the count starts again from nothing");
  assert.equal(sup.noteUnexpectedClose(clock.t - 1000), false);
  assert.equal(sup.noteUnexpectedClose(clock.t - 1000), true);
  assert.equal(loops.length, 2);

  const desk = guarded({ server: false });
  for (let i = 0; i < 5; i++) assert.equal(desk.sup.noteUnexpectedClose(desk.clock.t - 1000), false, "on a desktop a person closing the window looks the same");
  assert.equal(desk.sup.crashLoop(), null);
  assert.deepEqual(desk.st.unexpectedCloses, []);
});

test("closes spread over more than five minutes are no loop", () => {
  const { sup, clock } = guarded();
  for (let i = 0; i < 6; i++) {
    assert.equal(sup.noteUnexpectedClose(clock.t - 1000), false, `close ${i + 1}`);
    clock.t += 3 * MIN; // two closes within any five minutes, never three
  }
  assert.equal(sup.crashLoop(), null);
});

test("statusParts names the virtual screen and a crash loop", async () => {
  const { st, sup } = harness({ config: { virtualScreen: { width: 1280, height: 800 } } });
  assert.deepEqual(sup.statusParts(), [], "no screen, no loop: nothing");
  await sup.ensureScreen();
  assert.deepEqual(sup.statusParts(), ["virtual screen :99 1280x800"]);
  const g = guarded();
  for (let i = 0; i < 3; i++) g.sup.noteUnexpectedClose(g.clock.t - 1000);
  assert.deepEqual(g.sup.statusParts(), ["warning: the browser keeps crashing on this machine: see daemon.log; no new start for 5 more minutes (or until PairBrowse restarts)"]);
  g.clock.t += 4 * MIN + 30_000;
  assert.match(g.sup.statusParts()[0], /for 1 more minute \(/);
  g.clock.t += 30_000;
  assert.deepEqual(g.sup.statusParts(), []);
  assert.equal(g.st.crashLoopUntil, 0);
  assert.equal(st.crashLoopUntil, 0, "a screen alone is no loop");
});

// The guard's wiring (read from the source: it needs a real browser): a close counts unless a
// session switch, a shutdown or the helper's own reset caused it; a launch that fails (a lost screen, and later a network
// refusal) closes before the close handler exists, so it never counts; getContext() refuses while
// the guard holds and no browser runs; pairbrowse_status says so instead of failing.
test("a switch, shutdown, the helper's own reset or failed launch never counts; getContext and status read the guard", () => {
  const src = (p) => readFileSync(new URL(`../scripts/daemon/${p}`, import.meta.url), "utf8");
  const launch = src("browser/launch.mjs");
  assert.match(launch, /if \(!st\.switching && !st\.resetting && !shuttingDown\(\) && !api\.noteUnexpectedClose\(launchedAt\)\) api\.relaunchSoon\(launchedAt\);/, "keep-alive starts again only when the guard lets it");
  // The helper's own resets (serve.mjs: the turn cap, a disconnected agent's stalled call) go
  // through reset(), which marks the close as its own.
  assert.match(launch, /async function reset\(\) \{\n\s+st\.resetting = true;\n\s+try \{ await \(await st\.contextPromise\)\?\.close\(\); \} catch \{\} finally \{ st\.resetting = false; \}/);
  const serve = src("serve.mjs");
  assert.equal(serve.match(/await context\.reset\(\);/g)?.length, 2, "both resets in serve.mjs");
  assert.doesNotMatch(serve, /context\.current\(\)\)\?\.close\(\)/, "no reset closes the browser around the guard");
  const handler = launch.indexOf('ctx.on("close", () => {');
  assert.ok(launch.indexOf("api.noteUnexpectedClose(") > handler, "only in the close handler");
  assert.ok(launch.indexOf("if (screen && st.screen !== screen) {") < handler, "a failed launch closes before the handler is added");
  assert.ok(launch.indexOf("const launchedAt = Date.now();") < handler);
  const get = launch.slice(launch.indexOf("function getContext()"), launch.indexOf("const closeWatchers"));
  assert.match(get, /const loop = !st\.contextPromise && api\.crashLoop\(\);\n\s+if \(loop\) return Promise\.reject\(new Error\(loop\)\);/);
  assert.ok(get.indexOf("api.crashLoop()") < get.indexOf("st.contextPromise = launch()"), "refused before a launch starts");
  const context = src("context.mjs");
  assert.match(context, /const \{ stopScreenNow, crashLoop, statusParts: screenParts, keepAlive, keepAliveStart, isServer \} = Object\.assign\(api, createSupervisor\(st, deps, api\)\);/);
  // The supervisor's parts first, then the profile's (sessions/profiles.mjs) and its graphics (browser/graphics.mjs), then the session's network (daemon/network.mjs, net-refuse.test.mjs).
  assert.match(context, /^\s+crashLoop, statusParts: \(\{ remote = false \} = \{\}\) => \[\.\.\.screenParts\(\), \.\.\.profiles\.statusParts\(\), \.\.\.graphicsStatus\(\{ remote \}\), \.\.\.\(network\?\.statusParts\(st\.session\) \|\| \[\]\)\],$/m);
  assert.match(context, /^\s+keepAlive, keepAliveStart,$/m);
  const status = src("serve/tools/status.mjs");
  assert.match(status, /if \(!context\.crashLoop\?\.\(\) && !context\.networkRefusal\?\.\(\)\) await context\.getContext\(\)/);
  assert.match(status, /statusLine\(SELECTED, CONFIG_WARNINGS, SANDBOX, updateNote\(\), \[\.\.\.\(context\.statusParts\?\.\(\{ remote: !!conn\.remote \}\) \|\| \[\]\)\]\)/);
});

test("isServer answers serverMode for the launch's sandbox rule", () => {
  for (const server of [true, false]) {
    const sup = createSupervisor({ unexpectedCloses: [] }, { config: {}, log: () => {}, needsScreen: () => false, server: () => server });
    assert.equal(sup.isServer(), server);
  }
  const native = readFileSync(new URL("../scripts/native/check.mjs", import.meta.url), "utf8");
  assert.match(native, /\{ server: serverMode\(config, env\) \}\);/, "the install self-check holds its launch to the same rule");
});

// A supervisor with keep-alive: a clock and timers the test runs by hand, getContext counted, and
// switching, shutting down and the browser in use set on st or in the test.
function kept({ keepAlive = true, server = true } = {}) {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  const logs = [], timers = [], starts = [], marks = [];
  const clock = { t: 1_000_000 };
  const flags = { shutting: false, fail: null };
  const api = { getContext: () => { starts.push(clock.t); if (flags.fail) return Promise.reject(new Error(flags.fail)); st.contextPromise = Promise.resolve({}); return st.contextPromise; } };
  const setTimer = (fn, ms) => { const t = { fn, ms, unrefd: false, unref() { t.unrefd = true; } }; timers.push(t); return t; };
  const sup = createSupervisor(st, { config: { server: { keepAlive } }, log: (l) => logs.push(l), needsScreen: () => false, server: () => server, now: () => clock.t, setTimer, mark: () => marks.push(1), shuttingDown: () => flags.shutting }, api);
  // The planned start comes: the clock moves to it and its timer runs.
  const fire = async () => { const t = timers.shift(); clock.t += t.ms; t.fn(); await new Promise((r) => setImmediate(r)); return t; };
  // The browser closes by itself after running ran ms; returns relaunchSoon's pause.
  const closed = (ran) => { st.contextPromise = null; return sup.noteUnexpectedClose(clock.t - ran) ? 0 : sup.relaunchSoon(clock.t - ran); };
  return { st, sup, logs, timers, starts, marks, clock, flags, fire, closed };
}

test("keepAlive relaunches with backoff, never while shutting down, switching or in a crash loop", async () => {
  const k = kept();
  assert.equal(k.closed(1000), 2000, "the first start after a close waits 2 s");
  assert.equal(k.timers.length, 1);
  assert.ok(k.timers[0].unrefd, "a planned start never keeps the helper's process alive");
  assert.equal(k.sup.relaunchSoon(k.clock.t), 0, "one planned start at a time");
  await k.fire();
  assert.equal(k.starts.length, 1, "the browser starts again");
  assert.equal(k.st.relaunchAt, 0);
  assert.equal(k.closed(1000), 10_000, "a second early close: 10 s");
  await k.fire();
  assert.equal(k.starts.length, 2);
  assert.equal(k.closed(1000), 0, "the third early close: the crash-loop guard holds, nothing planned");
  assert.equal(k.timers.length, 0);
  assert.ok(k.sup.crashLoop());
  // After the hold, the next early close waits the longest pause.
  k.clock.t += 5 * MIN;
  assert.equal(k.sup.crashLoop(), null);
  assert.equal(k.closed(1000), 30_000, "then 30 s");
  await k.fire();
  assert.equal(k.closed(1000), 30_000, "and 30 s from then on");
  await k.fire();
  assert.equal(k.closed(2 * MIN), 2000, "a browser that ran past a minute starts the pauses over");
  assert.ok(k.logs.some((l) => l === "keep-alive: the browser closed by itself; it starts again in 2 s"), k.logs.join("\n"));

  // A planned start never comes while the helper stops, a session switch is under way, a browser
  // already runs, or the guard holds.
  for (const [name, set] of [
    ["shutting down", (x) => { x.flags.shutting = true; }],
    ["switching", (x) => { x.st.switching = true; }],
    ["a browser runs", (x) => { x.st.contextPromise = Promise.resolve({}); }],
    ["crash loop", (x) => { x.st.crashLoopUntil = x.clock.t + 10 * MIN; }],
  ]) {
    const x = kept();
    x.closed(1000);
    set(x);
    await x.fire();
    assert.equal(x.starts.length, 0, name);
  }
  const s = kept();
  s.flags.shutting = true;
  assert.equal(s.sup.relaunchSoon(s.clock.t), 0, "nothing is planned while the helper stops");
});

test("keepAlive off: no start with the helper and none after a close; a failed start is logged once", async () => {
  const off = kept({ keepAlive: false });
  assert.equal(off.sup.keepAlive(), false);
  assert.equal(off.sup.keepAliveStart(), false);
  assert.equal(off.closed(1000), 0);
  assert.equal(off.timers.length, 0);
  assert.equal(off.starts.length, 0);
  const on = kept();
  assert.equal(on.sup.keepAlive(), true);
  on.flags.fail = "no screen";
  assert.equal(on.sup.keepAliveStart(), true, "the browser starts with the helper");
  await new Promise((r) => setImmediate(r));
  assert.equal(on.starts.length, 1);
  assert.ok(on.logs.includes("keep-alive: the browser didn't start: no screen"), on.logs.join("\n"));
  assert.equal(on.timers.length, 0, "a failed start is not tried again by itself");
});

test("statusParts names keep-alive and its planned start", async () => {
  const k = kept();
  assert.deepEqual(k.sup.statusParts(), ["keep-alive on"]);
  k.closed(1000);
  assert.deepEqual(k.sup.statusParts(), ["keep-alive: the browser starts again in 2 s"]);
  k.clock.t += 1500;
  assert.deepEqual(k.sup.statusParts(), ["keep-alive: the browser starts again in 1 s"]);
  await k.fire();
  assert.deepEqual(k.sup.statusParts(), ["keep-alive on"]);
  assert.deepEqual(kept({ keepAlive: false }).sup.statusParts(), []);
});

test("the supervisor marks a server for where() (A11), never a desktop", () => {
  assert.equal(kept({ server: true }).marks.length, 1);
  assert.equal(kept({ keepAlive: false, server: false }).marks.length, 0);
  const sup = readFileSync(new URL("../scripts/daemon/browser/supervise.mjs", import.meta.url), "utf8");
  assert.match(sup, /import \{ markServer \} from "\.\.\/where\.mjs";/);
});

// The helper's wiring (daemon.mjs needs a whole helper): a browser closed with nobody connected
// ends the helper only without keep-alive, and the browser starts once the runtime has loaded.
test("daemon.mjs: keep-alive keeps the helper when the browser closes and starts the browser at once", () => {
  const daemon = readFileSync(new URL("../scripts/daemon.mjs", import.meta.url), "utf8");
  assert.match(daemon, /else if \(!context\.keepAlive\(\)\) shutdown\(0\);/);
  const runtimeAt = daemon.indexOf("try { runtime(); }");
  assert.ok(runtimeAt > 0 && runtimeAt < daemon.indexOf("context.keepAliveStart();"), "after the runtime loads");
});
