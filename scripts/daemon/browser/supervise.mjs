// Supervising the browser's surroundings on a server (spec server-mode A4): the private virtual
// screen it runs on, started before each launch that needs one and ended at shutdown. Event-driven,
// no polling: an Xvfb that exits by itself clears st.screen and closes the browser that ran on it,
// so the existing close path runs (calls in flight hear "browser closed") and the next getContext()
// starts a new screen and brings the tabs back. On a server the browser that keeps crashing soon
// after each start is not started again for a while (A5, the crash-loop guard): on a desktop a
// person closing the window looks the same, so nothing is counted there. With server.keepAlive (A9)
// the browser is started as the helper starts and again after it closes by itself, with a growing
// pause, so a server with nobody connected keeps its browser up.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { needsVirtualDisplay, screenGeometry, serverMode, startVirtualDisplay } from "../../display.mjs";
import { testMs } from "../../testenv.mjs";
import { within } from "../../util.mjs";
import { markServer } from "../where.mjs";

// How long the browser that lost its screen gets to close before it is left to its own exit.
const LOST_CLOSE_MS = 5000;
// The crash-loop guard (A5): CRASH_LIMIT unexpected closes within CRASH_WINDOW_MS, each within
// EARLY_MS of its launch, and getContext() refuses for CRASH_WINDOW_MS (or until the helper restarts).
// The live test shortens the window (PAIRBROWSE_TEST_CRASH_WINDOW_MS).
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = testMs("CRASH_WINDOW_MS", 5 * 60_000);
const EARLY_MS = 60_000;
export const CRASH_LOOP = "the browser keeps crashing on this machine: see daemon.log";
// Keep-alive's pauses before each start after the browser closed by itself (A9): the first, the
// second, then every later one, until a browser stays up past EARLY_MS. The crash-loop guard ends
// the run of starts before the pauses grow past these. The live test gives one short pause for all
// (PAIRBROWSE_TEST_RELAUNCH_MS).
const RELAUNCH_TEST_MS = testMs("RELAUNCH_MS", 0);
export const RELAUNCH_MS = RELAUNCH_TEST_MS ? [RELAUNCH_TEST_MS] : [2000, 10_000, 30_000];
// A span for the log: "5 minutes", or seconds when shorter than a minute or not whole minutes.
const span = (ms) => (ms % 60_000 ? `${ms / 1000} s` : `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`);

// deps: config, log, shuttingDown(); onCrashLoop(): the guard stopped launches (once per stop; Phase
// B sends its "ended" message from it); startScreen, needsScreen, server, now, setTimer and mark for
// tests (display.mjs, Date.now, setTimeout and where.mjs markServer by default). api: getContext.
export function createSupervisor(st, deps, api = {}) {
  const { config, log, shuttingDown = () => false, onCrashLoop = () => {}, startScreen = startVirtualDisplay, needsScreen = () => needsVirtualDisplay(config), server = () => serverMode(config), now = Date.now, setTimer = setTimeout, mark = markServer } = deps;
  // On a server the live view's links and the session's place say "Server" (where.mjs, A11).
  if (server()) mark();

  // The screen ended without being asked to: forgotten (its cookie is gone, its record stays for
  // the next start's reap), and the browser on it closed, unless a stop is under way or a newer
  // screen already took its place.
  function lost(screen, { code, signal }) {
    if (st.screenStopping || st.screen !== screen) return;
    st.screen = null;
    log(`virtual screen ${screen.display} ended by itself (${signal || `code ${code}`}); the browser closes and the next action starts a new screen`);
    const ctx = st.contextPromise;
    if (!ctx) return;
    Promise.resolve(ctx).then(async (c) => {
      if (!(await within(LOST_CLOSE_MS, c.close().then(() => true, () => true)))) log("the browser didn't close after losing its screen");
    }, () => {});
  }

  // Before each launch: a virtual screen when this machine needs one (display.mjs
  // needsVirtualDisplay) and none runs. Returns the screen in use, or null.
  async function ensureScreen() {
    if (st.screen || !needsScreen()) return st.screen;
    // An exit is heard in a later turn than the start's return, so screen is always set by then. A
    // screen that ends while the browser starts is caught by launch() (launch.mjs), which kept it.
    let screen = null;
    screen = await startScreen(log, { geometry: screenGeometry(config), onExit: (why) => { if (screen) lost(screen, why); } });
    st.screenStopping = false;
    st.screen = screen;
    return screen;
  }

  // At shutdown: Xvfb ended (at most about 2 s), its cookie and record removed.
  async function stopScreen() {
    const screen = st.screen;
    if (!screen) return;
    st.screenStopping = true;
    try { await screen.stop(); } finally { if (st.screen === screen) st.screen = null; st.screenStopping = false; }
  }

  // At process exit, where nothing can wait: the screen is told to end now.
  function stopScreenNow() {
    st.screenStopping = true;
    st.screen?.stopNow?.();
  }

  // The browser closed without being asked to (launch.mjs: not a session switch, not a shutdown;
  // a launch that fails before its browser is handed out never gets here). Counted only on a
  // server and only when it came within EARLY_MS of its launch: a browser that ran for a while and
  // then closed is not a loop. Returns whether launches now stop.
  function noteUnexpectedClose(launchedAt) {
    if (!server()) return false;
    const t = now();
    if (crashLoop()) return true;
    if (!(t - launchedAt <= EARLY_MS)) return false;
    st.unexpectedCloses = [...st.unexpectedCloses.filter((at) => t - at < CRASH_WINDOW_MS), t];
    if (st.unexpectedCloses.length < CRASH_LIMIT) return false;
    st.crashLoopUntil = t + CRASH_WINDOW_MS;
    log(`the browser closed by itself ${st.unexpectedCloses.length} times within ${span(CRASH_WINDOW_MS)}, each soon after it started: no new start for ${span(CRASH_WINDOW_MS)} (or until PairBrowse restarts)`);
    try { onCrashLoop(); } catch (e) { log(`crash loop: ${e?.message || e}`); }
    return true;
  }

  // The refusal getContext() gives while the guard holds, else null. Once the hold is over the
  // count starts again from nothing.
  function crashLoop() {
    if (!st.crashLoopUntil) return null;
    if (now() < st.crashLoopUntil) return CRASH_LOOP;
    st.crashLoopUntil = 0;
    st.unexpectedCloses = [];
    log("crash loop: the hold is over; the next action starts the browser");
    return null;
  }

  // Keep-alive (server.keepAlive, A9): read at each use; the config file is the only place it's set.
  const keepAlive = () => config?.server?.keepAlive === true;

  // Starts the browser now, unless one runs or starts, the helper stops, a session switch is
  // under way (it opens the next browser itself) or the crash-loop guard holds. A start that fails
  // is logged and not tried again: the next action tries.
  function startKept(why) {
    if (shuttingDown() || st.switching || st.contextPromise || crashLoop()) return false;
    log(`keep-alive: ${why}`);
    Promise.resolve().then(() => api.getContext()).catch((e) => log(`keep-alive: the browser didn't start: ${e?.message || e}`));
    return true;
  }

  // As the helper starts: with keep-alive the browser starts at once and its saved tabs come back.
  const keepAliveStart = () => keepAlive() && startKept("starting the browser with the helper");

  // The browser closed by itself (launch.mjs, after noteUnexpectedClose said launches go on): with
  // keep-alive it starts again after RELAUNCH_MS's next pause. One start waits at a time. A browser
  // that ran past EARLY_MS before it closed starts the pauses over. Returns the pause, or 0 when
  // nothing is planned.
  function relaunchSoon(launchedAt) {
    if (!keepAlive() || shuttingDown() || st.relaunchAt) return 0;
    if (!(now() - launchedAt <= EARLY_MS)) st.relaunches = 0;
    const ms = RELAUNCH_MS[Math.min(st.relaunches, RELAUNCH_MS.length - 1)];
    st.relaunches++;
    st.relaunchAt = now() + ms;
    log(`keep-alive: the browser closed by itself; it starts again in ${ms / 1000} s`);
    const timer = setTimer(() => { st.relaunchAt = 0; startKept("starting the browser again"); }, ms);
    timer?.unref?.();
    return ms;
  }

  // What pairbrowse_status adds about the browser's surroundings (serve/tools/status.mjs more):
  // the virtual screen in use, a crash loop and keep-alive.
  function statusParts() {
    const parts = [];
    const g = st.screen?.geometry;
    if (st.screen) parts.push(`virtual screen ${st.screen.display}${g ? ` ${g.width}x${g.height}` : ""}`);
    if (crashLoop()) {
      const left = Math.max(1, Math.ceil((st.crashLoopUntil - now()) / 60_000));
      parts.push(`warning: ${CRASH_LOOP}; no new start for ${left} more minute${left === 1 ? "" : "s"} (or until PairBrowse restarts)`);
    }
    if (keepAlive()) {
      const left = st.relaunchAt ? Math.max(1, Math.ceil((st.relaunchAt - now()) / 1000)) : 0;
      parts.push(left ? `keep-alive: the browser starts again in ${left} s` : "keep-alive on");
    }
    return parts;
  }

  // Whether this helper is in server mode (display.mjs serverMode): the launch keeps the browser's
  // sandbox required then (engine.mjs launchEngine).
  const isServer = () => server();

  return { ensureScreen, stopScreen, stopScreenNow, noteUnexpectedClose, crashLoop, statusParts, isServer, keepAlive, keepAliveStart, relaunchSoon };
}
