// The browser itself: launching it (and the native PairBrowse build), the pages it opens, the
// tabs it brings back, downloads, the tab cap, and switching between browser sessions.
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.mjs";
import { ensureBrowser, launchOptions, prepareProfile, panelExtensionId, resetPanelWorker, writeHelperKeyFile, dropHelperKeyFile, CAPTURE_KEY_PREFIX } from "../browser.mjs";
import { chooseBrowser, engineConfig, shellOf } from "../browser/choice.mjs";
import { engineProfile, nativeProfile, launchEngine, validateEngine } from "../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout, notChosen, pinnedAsset } from "../native-install.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "../display.mjs";
import { readSavedTabs } from "../tabs.mjs";
import { validName, isTemporary, profileDir, tabsFile, currentSession, rememberSession, listSessions, createSession, deleteSession, renameSession, sessionFilesExist, profileInUse, sweepTemporary, readPeople, recordPerson } from "../sessions.mjs";
import { renameRunsSession } from "../runs.mjs";
import { sleep, readJson, within } from "../util.mjs";
import { pruneStaleContexts } from "./contexts.mjs";
import { MEASURING } from "../native-engine.mjs";
import { isChromePage, CHROME_PICKER, extensionUrl } from "../../ui/urls.js";
import { createPersonTabs } from "./tools.mjs";
import { OPEN_ACCEPT_MS } from "../opener.mjs";
import { where } from "./where.mjs";
import { createDownloads } from "./browser/downloads.mjs";
import { createBrowserState } from "./browser/state.mjs";
import { createTabs, stopRequestMirroring } from "./browser/tabs.mjs";

export { stopRequestMirroring };

// While a throwaway session is open, a marker says so: if the helper restarts, the session is
// gone and the next result tells Claude it's back on a kept one (with its logins).
const CLEAN_MARKER = join(paths.home, "run", "clean-session");
// The session picker: agents' first browser action waits this long for the person's pick, then
// says what it waits for, so the agent tells them in chat instead of hanging silently.
const PICK_WAIT_MS = Number(process.env.PAIRBROWSE_TEST_PICK_WAIT_MS) || 15_000;
// An extension page: web pages can't open, frame or script it (no web_accessible_resources).
// A build with its own pages shows its own picker instead (CHROME_PICKER, ui/urls.js).
// The shell of the browser an engine config launches (browser/choice.mjs shellOf): whether it is a
// native build that declares its own pages (its manifest's `chrome` field), whether that build also
// declares its capture page, and whether that page reads a key of its own. Tests pass their own.
const chromePagesIn = (engine) => shellOf(engine).ownPages;
const capturePagesIn = (engine) => shellOf(engine).capturePage;
const captureKeyedIn = (engine) => shellOf(engine).captureKeyed;

// Where the browser runs ("Local", or "Server" over SSH): daemon/where.mjs.
export { where };

// This Mac's one-time capture (native-engine.mjs MEASURING): the first launch of a browser version
// waits up to a minute for it, and says so in the live view's status line and a notification (no
// browser yet, so no side panel or strip to show it). The launch's log, passing every line on;
// done(badge): the launch ended, the status line goes back to the badge.
// Each of its steps is bounded at 90 s (native-engine CAPTURE_STEP_MS); together they usually take under a minute.
export const MEASURING_STATUS = "Measuring this Mac once (usually under a minute, sometimes a few): the browser opens after that.";
export function measuringLog({ log, status, notify }) {
  let measuring = false;
  const launchLog = (text, ...more) => {
    log(text, ...more);
    if (text !== MEASURING || measuring) return;
    measuring = true;
    status({ text: MEASURING_STATUS, kind: "claude" });
    notify(MEASURING_STATUS);
  };
  launchLog.done = (badge) => { if (measuring) status(badge); measuring = false; };
  return launchLog;
}


// hud, presence, popups: the other parts that watch each page. hostNote(text): a note for the
// host's agent's next result. onTabClosed(page). status(badge): the live view's status line.
// shuttingDown(): no new browser then. onStarted(ctx) / onClosed(): the browser came up / went
// away by itself (not for a session switch).
// liveOthers(): who else is in this browser's session right now ({ who, app, computer }).
// chromePagesOf(config): whether the browser it launches has its own pages. helperFor(): the live view's
// { origin, key } for those pages (started then), or null: the address goes in its launch switch,
// the key in an owner-only file named by the other switch, deleted on first use (dropHelperKey).
// beforeRename(): awaited before a rename moves the session's files (the timeline's last writes).
// onRenamed(from, to): the session was renamed (the goal log follows).
// onDownload({ op: "start", name, page }) -> id, then { op: "done", id, path } or { op: "failed", id }:
// the Tools tab's Downloads (daemon/tools.mjs), in memory only.
// personTabs: the person's own tabs (daemon/tools.mjs createPersonTabs), shared with serve.mjs:
// openForPerson opens one, and no agent's fallback tab is ever one.
export function createContext({ personTabs = createPersonTabs(), config, log, chromium, driver = "patchright", hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed, liveOthers = () => [], notify = () => {}, chromePagesOf = chromePagesIn, capturePagesOf = capturePagesIn, captureKeyedOf = captureKeyedIn, helperFor = async () => null,
  beforeRename = async () => {}, onRenamed = () => {}, onDownload = () => null }) {
  const st = createBrowserState({ session: currentSession(), pick: null }); // browser/state.mjs
  // What the browser's parts (browser/*.mjs, sessions/*.mjs) are given, and the functions they
  // read from each other when called (api).
  const deps = { personTabs, config, log, hud, presence, popups, hostNote, onTabClosed, status, notify };
  const api = { getContext };
  // The driver's browser type: the object, or a getter (the helper loads its runtime after its socket listens).
  const browserType = () => (typeof chromium === "function" ? chromium() : chromium);

  // Sync and idempotent: a path given is one launch's own file (its close drops only that one).
  // The capture page's file goes with the pages' (the browser reads both as it starts).
  function dropHelperKey(path = st.helperKeyPath, capturePath = path === st.helperKeyPath ? st.captureKeyPath : null) {
    if (capturePath) { dropHelperKeyFile(capturePath); if (capturePath === st.captureKeyPath) st.captureKeyPath = null; }
    if (!path) return;
    dropHelperKeyFile(path);
    if (path === st.helperKeyPath) st.helperKeyPath = null;
  }
  const pickerUrl = () => (st.chrome ? CHROME_PICKER : extensionUrl(panelExtensionId(), "picker/index.html"));
  // Which browser runs ("browser" in config.json, chooseBrowser in browser/choice.mjs). Every launch
  // reads the choice anew (a change in Settings takes effect at the next start) and keeps it here
  // (engine, shell): config itself is never written, so the older names a person wrote stay as
  // they wrote them.
  const choiceConfig = () => config;
  // The shell of the browser an engine config launches, read once per choice.
  const shellFor = (e) => {
    const ownPages = !!chromePagesOf(e);
    const capturePage = ownPages && !!capturePagesOf(e);
    return { kind: ownPages ? "pages" : "extension", ownPages, capturePage, captureKeyed: capturePage && !!captureKeyedOf(e) };
  };
  const said = new Set(); // lines about the choice, logged once per helper run
  const once = (line) => { if (!said.has(line)) { said.add(line); log(line); } };
  const installWaiters = new Set();
  // The session picker (config sessionPicker, on by default): the browser's first tab asks the
  // person which session to use, unless an agent chose first. Never on the very first start
  // (nothing to go back to) or in a cloud container (nobody sees the window).
  // pick.state: "off", "pending" (shown at the next launch), "showing", "done".
  // Something to go back to: a browser that ran before (Chrome's "Default" folder, in the Chromium
  // profile or the native build's own: engine.mjs engineProfile), saved tabs or another kept session.
  const ranBefore = (dir) => existsSync(join(dir, "Default")) || existsSync(join(nativeProfile(dir), "Default"));
  const hasHistory = () => ranBefore(profileDir(st.session)) || listSessions().some((s) => !s.temporary && (s.name !== "default" || s.tabs > 0));
  const pick = { state: config.sessionPicker !== false && process.env.CLAUDE_CODE_REMOTE !== "true" && hasHistory() ? "pending" : "off", page: null, text: "" };
  pick.done = new Promise((r) => { pick.resolve = r; });
  st.pick = pick;

  const profile = () => engineProfile(st.engine || config, profileDir(st.session));



  // Downloads: kept in the Downloads folder, and Playwright's temporary ones forgotten (browser/downloads.mjs).
  const { forgetTemporaryDownloads } = Object.assign(api, createDownloads({ personTabs, config, hostNote, log, onDownload, profile: () => profile() }));
  // The tabs: finding them, the cap, what watches each page, saved tabs coming back (browser/tabs.mjs).
  const { focusing, findPage, openPages, pageAt, touch, capTabs, adopt, notePlaces, successorOf, restore, takeRestoredActive, openForPerson } = Object.assign(api, createTabs(st, deps, api));

  // The browser the person chose ("browser"): the native PairBrowse browser (the pinned build,
  // installed and checked when it's missing or a new version is pinned, scripts/native-install.mjs),
  // "chromium" (ensureBrowser at launch) or a browser of their own. Unset: the native build where
  // one is pinned for this computer, else chromium; the helper never records that default. Never a
  // quiet switch from the native build to Chromium: only "browser": "chromium" picks that.
  async function chooseEngine() {
    const asset = pinnedAsset();
    const spec = chooseBrowser(config, { native: !!asset, pinnedExec: () => nativeDirs().exec });
    if (spec.problem) once(spec.problem);
    if (!spec.set) once(`browser: no choice recorded yet; using ${spec.browser} (Settings, or "browser" in ~/.pairbrowse/config.json)`);
    st.inUse = spec.browser;
    let executablePath = spec.executablePath; // a native build of your own (the older names), a path of your own, or null
    if (spec.install) {
      const optOut = 'To use Chromium instead, set "browser": "chromium" in ~/.pairbrowse/config.json.';
      const installLog = (m) => {
        log(m);
        if (st.installing || !/^(downloading|unpacking)/.test(m)) return;
        st.installing = true;
        notify("Installing the PairBrowse browser. It takes a minute or two, once.");
        for (const fn of installWaiters) fn();
      };
      let native = null;
      try {
        native = nativeLayout() ? await ensureNative(installLog, { asset, config }) : null;
      } catch (e) {
        if (st.installing) notify("The PairBrowse browser couldn't be installed. Ask Claude what happened.");
        throw new Error(`The PairBrowse browser couldn't be installed: ${e.message} ${optOut}`);
      } finally {
        if (st.installing && native) notify("The PairBrowse browser is installed.");
        st.installing = false;
      }
      if (!native) throw new Error(`There's no PairBrowse browser build for ${process.platform} ${process.arch} yet. ${optOut}`);
      executablePath = native;
    } else if (spec.binary !== "native") {
      // A recorded chromium or path of your own: the log says why nothing is installed, once.
      const why = spec.set && !spec.problem ? notChosen(config, !!asset) : null;
      if (why) once(why);
    }
    // null for chromium: the PairBrowse Chromium (ensureBrowser at launch).
    const next = engineConfig(config, { binary: spec.binary, executablePath });
    validateEngine(next);
    st.engine = next;
    return next;
  }




  async function launch() {
    const own = st.byHand;
    st.byHand = false;
    st.chosen = false;
    // Each launch step's time (plans/555 item 4), logged as "launch: <step> <ms> ms".
    let stepAt = Date.now();
    const step = (name) => { const now = Date.now(); log(`launch: ${name} ${now - stepAt} ms`); stepAt = now; };
    const next = await chooseEngine();
    step("engine");
    st.shell = shellFor(next);
    st.chrome = st.shell.ownPages;
    st.capture = st.shell.capturePage;
    st.chosen = true;
    // The profile settings PairBrowse needs (blank start tab, pinned and enabled side panel,
    // colors; see prepareProfile in browser.mjs), written before each launch.
    const firstRun = prepareProfile(profile(), undefined, { chromePages: st.chrome, layout: config.layout });
    step("prepare");
    // A side panel worker from another build (an update): the browser would keep running its
    // cached copy, so it's loaded anew from disk (resetPanelWorker in browser.mjs).
    if (!st.chrome) try { if (resetPanelWorker(profile())) log("side panel: its worker changed since the last start; the browser loads it anew"); } catch (e) { log(`side panel: ${e?.message || e}`); }
    // The browser's own pages reach the live view with the address in their launch switch and the
    // key in an owner-only file the other switch names (neither the key nor the path is logged).
    const helper = st.chrome ? await helperFor().catch((e) => { log("live view", e?.message || e); return null; }) : null;
    if (st.chrome && !helper) log("the browser's own pages have no helper address");
    step("live view");
    forgetTemporaryDownloads();
    if (!st.screen && needsVirtualDisplay(config)) st.screen = await startVirtualDisplay(log);
    createSession(st.session);
    // The PairBrowse browser (scripts/browser.mjs), or another Chromium browser from config.
    let keyFile = null, captureKeyFile = null;
    if (helper) try { keyFile = st.helperKeyPath = writeHelperKeyFile(helper.key); } catch (e) { log(`the browser's own pages have no helper address (key file: ${e?.code || "refused"})`); }
    // A capture page that reads its own key gets a new one now (and the helper requires it); a
    // file that can't be written leaves the capture page without one (it is refused: fail closed).
    const ck = helper?.newCaptureKey?.(!!(keyFile && st.capture && st.shell.captureKeyed)) || null;
    if (ck) try { captureKeyFile = st.captureKeyPath = writeHelperKeyFile(ck, undefined, CAPTURE_KEY_PREFIX); } catch (e) { log(`the capture page has no key (key file: ${e?.code || "refused"})`); }
    const launchLog = measuringLog({ log, status, notify });
    let ctx;
    try {
      ctx = await launchEngine(browserType(), next, profile(), {
        // The helper's own shutdown closes the browser (daemon.mjs shutdown -> close below).
        // Playwright's signal handlers would start a close of their own on the same SIGTERM, and
        // then treat the helper's close as a second one: a SIGKILL of Chromium inside 50 ms, before
        // it wrote its cookies (it writes them every ~30 s and on a clean exit): logins lost.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        // The launch itself, as the install self-check makes it too (browser.mjs launchOptions).
        ...launchOptions(config, {
          shell: st.shell, firstRun,
          env: { ...process.env, ...(st.screen?.env || {}) },
          executablePath: next.executablePath || await ensureBrowser(browserType(), log),
          helper: helper && keyFile ? { origin: helper.origin, keyFile, ...(captureKeyFile ? { captureKeyFile } : {}) } : null,
        }),
      }, launchLog);
    } catch (e) { dropHelperKey(keyFile, captureKeyFile); throw e; } // a failed launch leaves no key file
    finally { launchLog.done(hud.badge()); }
    step("browser (fingerprint and launchPersistentContext inside)");
    pruneStaleContexts(ctx, { driver, log }); // the driver forgets a tab's old execution contexts as it navigates
    await ctx.addInitScript({ content: hud.source });
    // Never into the browser's own pages (its new tab page among them: plans/555 D1.3).
    for (const p of ctx.pages()) { adopt(p, ctx); if (!isChromePage(p.url())) hud.ensure(p); }
    // A tab can arrive already loaded (one the side panel opened at its address): its page
    // script comes now, since under Patchright it isn't there until ensure adds it.
    ctx.on("page", (p) => { adopt(p, ctx); p.waitForLoadState("domcontentloaded").then(() => { if (!isChromePage(p.url())) hud.onPageLoad(p); }, () => {}); setTimeout(() => capTabs(ctx, p).catch(() => {}), 300); });
    step(`first page (${ctx.pages().length} open)`);
    if (pick.state === "pending") showPicker(ctx, { own });
    else restore(ctx, null, { own });
    const mine = st.contextPromise;
    ctx.on("close", () => {
      dropHelperKey(keyFile, captureKeyFile); // this launch's own file: an older browser closing late keeps the next one's
      log("browser closed");
      // Closed for good (by hand, a crash, the turn cap), not on the way to another session: the
      // calls in flight hear of it.
      if (!st.switching) for (const fn of closeWatchers) try { fn(); } catch {}
      // Closed while asking: the next browser asks again.
      if (pick.state === "showing") { pick.state = "pending"; pick.page = null; }
      // Only the browser in use: an older one closing late never drops the next one.
      if (st.contextPromise === mine) st.contextPromise = null;
      hud.clearSparks();
      if (!st.switching) onClosed(); // switching sessions: the next one opens right away
    });
    log(`browser started (session ${st.session})`);
    onStarted(ctx);
    return ctx;
  }

  function getContext() {
    if (shuttingDown() && !st.contextPromise) return Promise.reject(new Error("PairBrowse is restarting. Retry in a moment."));
    if (st.switching) return st.switched.then(() => getContext());
    if (!st.contextPromise) {
      st.launching = true;
      st.contextPromise = launch().catch((e) => {
        st.contextPromise = null;
        throw e;
      }).finally(() => { st.launching = false; installWaiters.clear(); });
    }
    if (!st.launching) return st.contextPromise;
    const busy = () => new Error("PairBrowse is installing its browser (the first start or a new version: a minute or two). Tell the user, then retry the last action in a minute.");
    if (st.installing) return Promise.reject(busy());
    return Promise.race([st.contextPromise, new Promise((_, reject) => installWaiters.add(() => reject(busy())))]);
  }

  // The browser, once saved tabs are back.
  // Calls in flight when the browser closes (closed by hand, or crashed) are told at once.
  const closeWatchers = new Set();
  const watchClose = (fn) => { closeWatchers.add(fn); return () => closeWatchers.delete(fn); };
  async function ready() {
    while (st.pickSwitch) await st.pickSwitch; // never the old browser after the person picked another
    const ctx = await getContext();
    if (st.restoring) await st.restoring;
    return ctx;
  }

  // ---- the session picker ----------------------------------------------------------------

  // Its tab, instead of the saved tabs (they come back once the person chose this session).
  // reopened: asked for again from the side panel, in a tab of its own; the open tabs stay.
  function showPicker(ctx, { reopened = false, own = false } = {}) {
    pick.state = "showing";
    if (!reopened) st.tabTracker = null; // the saved tabs stay as they were until the person chose
    (async () => {
      // The browser may start without a window and open its first one a moment later: use that.
      for (let i = 0; !reopened && i < 20 && !ctx.pages().length; i++) await sleep(150);
      const page = reopened ? await ctx.newPage() : ctx.pages()[0] || (await ctx.newPage());
      pick.page = page;
      // The extension may still be loading right after launch: try a few times.
      for (let i = 0; i < 20 && pick.state === "showing" && !page.isClosed(); i++) {
        const at = Date.now();
        const went = await page.goto(pickerUrl(), { waitUntil: "domcontentloaded", timeout: 5000 }).then(() => "ok", (e) => String(e?.message || e).split("\n")[0].slice(0, 80));
        log(`launch: picker goto try ${i + 1} ${Date.now() - at} ms: ${went}`);
        if (went === "ok") break;
        await sleep(250);
      }
      await focusing(own, () => page.bringToFront().catch(() => {}));
      log("session picker shown");
    })().catch((e) => log("session picker", e?.message || e));
  }

  // The person asked to switch (the side panel's "End session", the right dock in the browser): the picker opens again in a
  // new tab, and agents' next actions wait for the pick as at the start. Agents can't ask for it.
  async function reopenPicker() {
    if (pick.state === "showing") { await within(3000, Promise.resolve(pick.page?.bringToFront()).catch(() => {})); return { text: "The session picker is open." }; }
    const ctx = await getContext();
    pick.reopened = true;
    pick.text = "";
    pick.done = new Promise((r) => { pick.resolve = r; });
    showPicker(ctx, { reopened: true });
    return { text: "Pick a session in the new tab." };
  }

  // A choice was made (by the person in the picker, or by an agent): waiting agents go on.
  function picked(text) {
    if (pick.state === "done" || pick.state === "off") { pick.state = "done"; return; }
    pick.state = "done";
    pick.text = text;
    pick.resolve(text);
    log(`session picked: ${text}`);
  }

  // Before an agent's first browser action: starts the browser (which shows the picker) and waits
  // for the person's pick, at most PICK_WAIT_MS. Returns the pick's text, "" when there was no
  // picker, or { waiting } when it timed out.
  async function waitForPick(signal) {
    if (pick.state === "off" || pick.state === "done") return "";
    await getContext();
    if (pick.state !== "showing") return pick.state === "done" ? pick.text : "";
    let timer;
    let onAbort;
    const aborted = new Promise((r) => { onAbort = () => r(null); signal?.addEventListener("abort", onAbort, { once: true }); });
    const r = await Promise.race([pick.done, new Promise((ok) => { timer = setTimeout(() => ok(null), PICK_WAIT_MS); }), aborted]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    return r === null ? { waiting: true } : r;
  }

  // What the picker shows: the kept sessions, most recently used first, with their saved tabs'
  // sites, who used them (people and agents, their app and kind of computer) and, for the open
  // one, who is in it right now.
  function pickerState() {
    const sessions = listSessions().filter((s) => !s.temporary).map((s) => {
      const { tabs } = readSavedTabs(tabsFile(s.name));
      const sites = [...new Set(tabs.map((t) => { try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean))];
      const people = readPeople(s.name);
      const used = Math.max(Date.parse(readJson(tabsFile(s.name))?.savedAt || "") || 0, people[0]?.at || 0);
      return { name: s.name, tabs: tabs.length, sites: sites.slice(0, 4), current: s.name === st.session, used,
        people: people.map(({ who, app, computer, kind }) => ({ who, app, computer, kind })),
        live: s.name === st.session ? liveOthers().slice(0, 8) : [] };
    });
    // The open one (the last used) first, then by when they were used.
    sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.used - a.used || a.name.localeCompare(b.name));
    return { picking: pick.state === "showing", where: where(), sessions };
  }

  function switchFromPicker(name) {
    st.pickSwitch = switchTo(name).catch((e) => log("pick", e?.message || e)).finally(() => { st.pickSwitch = null; });
  }

  // The person's pick: { action: "use", name } (a saved session) or { action: "new" } (fresh and
  // clean). Joining is wired in daemon.mjs (it needs the join code checks). Returns { text, error }.
  async function pickSession({ action, name } = {}) {
    if (pick.state !== "showing") return { text: "A session is already chosen.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === st.session && pick.reopened) {
        // Asked for again, and the person kept the open session: the picker just closes.
        pick.reopened = false;
        picked(`The person kept session "${name}" in the browser's session picker.`);
        await pick.page?.close().catch(() => {});
        return { text: `Staying in session "${name}".` };
      }
      pick.reopened = false;
      if (name === st.session) {
        // Back to the session that's open: the picker's tab shows its tabs coming back.
        const ctx = await getContext();
        picked(`The person picked session "${name}" in the browser. Its tabs are reopening.`);
        await pick.page?.goto("about:blank").catch(() => {});
        restore(ctx);
        return { text: `Opening session "${name}".` };
      }
      // Waiting agents go on at once; their next action waits for the new browser (ready()).
      switchFromPicker(name);
      picked(`The person picked session "${name}" in the browser. Its tabs are reopening.`);
      return { text: `Opening session "${name}".` };
    }
    if (action === "new") {
      pick.reopened = false;
      const target = `clean-${Date.now()}`;
      createSession(target);
      switchFromPicker(target);
      picked("The person started a fresh session in the browser: a clean, throwaway browser with no logins, deleted when you switch away.");
      return { text: "Starting a fresh session." };
    }
    return { text: 'Use action "use" or "new".', error: true };
  }

  // The person joined a shared session from the picker: this session stays, without its saved
  // tabs (the shared ones open in a window of their own).
  // The picker's tab stays, saying what happens next; the saved tabs open after it.
  function pickedJoin(text) {
    if (pick.state !== "showing") return;
    picked(text);
    if (pick.reopened) { pick.reopened = false; return; } // the open tabs are still there
    st.contextPromise?.then(async (ctx) => restore(ctx, await ctx.newPage())).catch((e) => log("restore", e?.message || e));
  }

  // The person switches away from the session that's open (POST pick while no picker shows: the
  // session switcher, the new tab page's chips; daemon/pick.mjs checks who else is at work first):
  // { action: "use", name } or { action: "new" }. Checked here at once, then the browser restarts
  // on the other session after the answer went out (the page that asked closes with the window).
  // Returns { text } or { text, error: true }.
  async function switchForPerson({ action, name } = {}) {
    if (pick.state === "showing") return pickSession({ action, name });
    if (st.switching) return { text: "The browser is switching sessions; try again in a moment.", error: true };
    if (st.restoring) return { text: "Tabs are still reopening; switch once they're back.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === st.session) return { text: `You're in session "${name}" already.` };
      setImmediate(() => switchTo(name).catch((e) => log("switch", e?.message || e)));
      return { text: `Opening session "${name}".` };
    }
    if (action === "new") {
      const target = `clean-${Date.now()}`;
      createSession(target);
      setImmediate(() => switchTo(target).catch((e) => log("switch", e?.message || e)));
      return { text: "Starting a fresh session." };
    }
    return { text: 'Use action "use" or "new".', error: true };
  }

  // ---- browser sessions ----------------------------------------------------------------

  const sessionInfo = () => ({ name: isTemporary(st.session) ? "Clean session" : st.session, where: where(), temporary: isTemporary(st.session) });

  // renameFrom: a person's rename of the open session (renameCurrent): the browser closes, the
  // session's files move to the new name, and the same session reopens with its tabs.
  async function switchTo(name, { renameFrom = null } = {}) {
    if (!renameFrom && name === st.session && st.contextPromise) {
      // The open session, chosen by an agent while the picker is up: the picker goes, its tabs come back.
      if (pick.state === "showing") {
        const ctx = await st.contextPromise;
        picked(`Session "${name}" was chosen by an agent. Its tabs are reopening.`);
        await pick.page?.goto("about:blank").catch(() => {});
        restore(ctx);
      }
      return;
    }
    while (st.switching) await st.switched; // one switch at a time
    let done;
    st.switched = new Promise((r) => { done = r; });
    st.switching = true;
    let renamed = false;
    try {
      // Another switch ran first: this rename is over (nothing closed, nothing moved).
      if (renameFrom && st.session !== renameFrom) { log(`rename of session ${renameFrom} dropped: the browser is on session ${st.session} now`); return; }
      const ctx = st.contextPromise && (await st.contextPromise);
      if (ctx) {
        await st.tabTracker?.saveNow();
        await notePlaces();
        st.tabTracker?.stop();
        await ctx.close().catch(() => {});
      }
      if (renameFrom) {
        // Only once the browser is closed: a running Chromium keeps writing into its profile folder.
        await beforeRename().catch(() => {});
        try {
          renameSession(renameFrom, name);
          try { renameRunsSession(renameFrom, name); } catch (e) { log(`rename: runs: ${e?.message || e}`); }
          try { onRenamed(renameFrom, name); } catch {}
          renamed = true;
        } catch (e) {
          log(`rename of session ${renameFrom} failed: ${e?.message || e}`);
          hostNote(`Renaming the browser session "${renameFrom}" to "${name}" didn't work (${e?.message || e}); the browser reopened on "${renameFrom}".`);
          notify(`Renaming the session to "${name}" didn't work; it reopened as "${renameFrom}".`);
          name = renameFrom;
        }
      }
      const previous = st.session;
      st.session = name;
      rememberSession(name);
      if (isTemporary(name)) writeFileSync(CLEAN_MARKER, name);
      else rmSync(CLEAN_MARKER, { force: true });
      if (!renameFrom && isTemporary(previous) && previous !== name) deleteSession(previous);
      st.contextPromise = null;
    } finally {
      st.switching = false;
      done();
    }
    // An agent switching is a choice too: no picker in the next browser.
    if (!renameFrom) picked(`Session "${isTemporary(name) ? "clean" : name}" was chosen by an agent.`);
    if (renamed) hostNote(`The person renamed this browser session "${renameFrom}" to "${name}"; the browser restarted on it and its tabs are reopening (pairbrowse_session use ${name}).`);
    await getContext();
    log(renameFrom ? `session ${renameFrom} renamed to ${name}` : `switched to session ${name}`);
  }

  // A person renames the open session (the session card's pencil, POST session): checked here
  // at once, then the browser restarts on the renamed session (switchTo's rename mode) after the
  // answer went out. Returns { ok, name, from, restarting } or { error }.
  function renameCurrent(given) {
    const from = st.session;
    const to = String(given ?? "").trim();
    if (!st.contextPromise) return { error: "The browser isn't open; open it first, then rename its session." };
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (st.restoring) return { error: "Tabs are still reopening; rename the session once they're back." };
    if (pick.state === "showing") return { error: "The session picker is open; pick a session first." };
    if (from === "default") return { error: "The default session keeps its name; start a named session to name it." };
    if (isTemporary(from)) return { error: "A clean session can't be renamed: it is deleted when you switch away." };
    if (to === from) return { ok: true, name: from, from, restarting: false };
    if (!validName(to)) return { error: "Session names use letters, numbers, - and _ (up to 40)." };
    if (to === "default" || isTemporary(to)) return { error: `"${to}" is a name PairBrowse keeps for itself; choose another.` };
    const caseOnly = to.toLowerCase() === from.toLowerCase();
    if (!caseOnly && (listSessions().some((s) => s.name.toLowerCase() === to.toLowerCase()) || sessionFilesExist(to))) return { error: `Session "${to}" already exists; choose another name.` };
    setImmediate(() => switchTo(to, { renameFrom: from }).catch((e) => log("rename", e?.message || e)));
    return { ok: true, name: to, from, restarting: true };
  }

  // A person renames a saved session that isn't open (the sessions page, POST session with from):
  // its files move now, nothing restarts. Refused while the browser switches (it may be opening
  // that one) and while a browser has its profile open (profileInUse); the open session goes
  // through renameCurrent. Returns { ok, name, from, restarting: false } or { error }.
  function renameSaved(fromGiven, given) {
    const from = String(fromGiven ?? "").trim();
    const to = String(given ?? "").trim();
    if (from === st.session) return renameCurrent(to);
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (from === "default") return { error: "The default session keeps its name; start a named session to name it." };
    if (isTemporary(from)) return { error: "A clean session can't be renamed: it is deleted when you switch away." };
    if (!validName(from) || !listSessions().some((s) => s.name === from)) return { error: `No session "${from}".` };
    if (to === from) return { ok: true, name: from, from, restarting: false };
    if (profileInUse(from)) return { error: `Session "${from}" is open in another browser; close it there, then rename it.` };
    try { renameSession(from, to); } catch (e) { return { error: String(e?.message || e) }; }
    try { renameRunsSession(from, to); } catch (e) { log(`rename: runs: ${e?.message || e}`); }
    try { onRenamed(from, to); } catch {}
    hostNote(`The person renamed the saved browser session "${from}" to "${to}" (pairbrowse_session use ${to}).`);
    log(`saved session ${from} renamed to ${to} by the person`);
    return { ok: true, name: to, from, restarting: false };
  }

  // A person's Save on the session card: the open session's tabs written now (the same write a
  // person's session switch and the shutdown make). Returns { ok } or { error }.
  async function saveTabs() {
    if (!st.contextPromise) return { error: "The browser isn't open." };
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (st.restoring) return { error: "Tabs are still reopening; save once they're back." };
    if (isTemporary(st.session)) return { error: "A clean session isn't kept: there is nothing to save." };
    if (!st.tabTracker) return { error: "Pick a session first." };
    await st.tabTracker.saveNow();
    return { ok: true };
  }

  // pairbrowse_session. Returns { text, error }.
  async function sessionCommand({ action, name } = {}) {
    const fail = (text) => ({ text, error: true });
    const exists = () => validName(name) && listSessions().some((s) => s.name === name);
    const list = () => listSessions().map((s) => `${s.name === st.session ? "* " : "  "}${s.temporary ? "clean (throwaway)" : s.name}${s.tabs ? `, ${s.tabs} saved tab${s.tabs === 1 ? "" : "s"}` : ""}`).join("\n");
    // The open session's count is its tabs now (its file may be up to a save behind).
    if (action === "list" && st.tabTracker && !st.switching) await within(3000, st.tabTracker.saveNow()).catch(() => {});
    if (action === "list") return { text: `Browser sessions (* = in use, ${where().toLowerCase()} browser):\n${list()}` };
    if (action === "use") {
      if (!exists()) return fail(`No session "${name}".\n${list()}`);
      await switchTo(name);
      return { text: `Now using session "${name}" (${where().toLowerCase()} browser). Its tabs are reopening.` };
    }
    if (action === "new") {
      if (name !== undefined && !validName(name)) return fail("Session names use letters, numbers, - and _ (up to 40).");
      if (name && listSessions().some((s) => s.name === name)) return fail(`Session "${name}" already exists. Use it with action "use".`);
      const target = name || `clean-${Date.now()}`;
      createSession(target);
      await switchTo(target);
      return {
        text: name
          ? `Created and switched to the new session "${name}": an empty browser with no logins.`
          : "Switched to a clean, throwaway browser: no logins, no history. It's deleted when you switch away or the browser shuts down.",
      };
    }
    if (action === "delete") {
      if (!exists()) return fail(`No session "${name}".`);
      if (name === st.session) return fail("That session is in use. Switch to another one first.");
      if (name === "default") return fail("The default session can't be deleted.");
      // Not while the browser switches (it may be opening that one), nor while a browser has its
      // profile open (another PairBrowse, a browser started by hand on it).
      if (st.switching) return fail("The browser is switching sessions; try again in a moment.");
      if (profileInUse(name)) return fail(`Session "${name}" is open in another browser; close it there, then delete it.`);
      deleteSession(name);
      return { text: `Deleted session "${name}" and its logins.` };
    }
    return fail('Use action "list", "use", "new" or "delete".');
  }


  // At startup: throwaway sessions a crash left behind, and the note that a clean one ended.
  // The person opened the PairBrowse browser by hand, and its bare start handed itself to this
  // helper (scripts/open.mjs; plans/555 item 6): the browser opens as the helper's, or the window
  // already open comes to the front. { ok } once it's up, or after acceptMs while it still starts
  // (the launch goes on; a failure after that is logged). { ok: false, why } when the browser this
  // helper uses isn't a PairBrowse build with its own pages (then the person's start opens as a
  // plain window, as before), while the helper stops, or when the launch failed at once.
  async function openByHand({ acceptMs = OPEN_ACCEPT_MS } = {}) {
    if (shuttingDown()) return { ok: false, why: "PairBrowse is restarting" };
    const pages = nextShell().ownPages;
    if (!pages) return { ok: false, why: "the browser in use here isn't the PairBrowse browser (\"browser\" in ~/.pairbrowse/config.json)" };
    if (!st.contextPromise) st.byHand = true; // this start is the person's: it may come to the front
    const up = getContext().then(async (ctx) => {
      const page = pick.state === "showing" && pick.page && !pick.page.isClosed() ? pick.page : ctx.pages().findLast((p) => !p.isClosed()) || null;
      if (page) await within(3000, page.bringToFront().catch(() => {}));
      return { ok: true };
    }, (e) => ({ ok: false, why: e?.message || String(e) }));
    const answer = await within(acceptMs, up);
    if (answer) return answer;
    // Still starting: taken (the opener's browser won't open a window of its own). A start that
    // fails from here on is said where the person looks, since nothing else would show it.
    up.then((a) => {
      if (a.ok) return;
      log(`the browser opened by hand didn't start: ${a.why}`);
      try { notify(`The PairBrowse browser didn't start: ${String(a.why).slice(0, 200)}. Open it again.`); } catch {}
    });
    return { ok: true };
  }

  function startUp() {
    try { sweepTemporary(); } catch {}
    if (!existsSync(CLEAN_MARKER)) return;
    rmSync(CLEAN_MARKER, { force: true });
    hostNote(`The clean session ended when the browser restarted. This is session "${st.session}" now, with its logins: switch to a new clean one (pairbrowse_session new, clean: true) if you need it.`);
  }

  // At shutdown: remember the tabs before they close; a clean close writes cookies to disk.
  async function close() {
    try {
      const ctx = st.contextPromise && (await st.contextPromise);
      await st.tabTracker?.saveNow();
      st.tabTracker?.stop();
      await ctx?.close();
    } catch {}
    dropHelperKey();
    try { sweepTemporary(); } catch {}
    st.screen?.stop();
  }

  // Before the browser runs: the shell the next launch would have (the build chooseEngine would
  // pick, without installing anything). Read from disk once per choice.
  function predict() {
    let next = st.engine || config;
    try {
      const spec = chooseBrowser(config, { native: !!pinnedAsset(), pinnedExec: () => nativeDirs().exec });
      next = engineConfig(config, { binary: spec.binary, executablePath: spec.install ? nativeDirs().exec : spec.executablePath });
    } catch {}
    const sig = `${next.browserEngine}\u0001${next.executablePath}`;
    if (st.predicted?.sig !== sig) st.predicted = { sig, shell: shellFor(next) };
    return st.predicted.shell;
  }
  // This launch's shell, or the next one's while no browser runs (what it will be once it runs).
  const nextShell = () => (st.contextPromise && st.chosen ? st.shell : predict());

  return {
    // The shell of the browser in use (browser/choice.mjs: "extension" or "pages", with its
    // capture page or not), and its parts as they were read before (aliases).
    shell: () => st.shell,
    chromePages: () => st.chrome,
    capturePages: () => st.capture,
    // The same, before the browser has started too (what it will be once it runs): an invite made
    // first says what the share will really carry.
    nextShell,
    willHaveChromePages: () => nextShell().ownPages,
    willHaveCapturePages: () => nextShell().capturePage,
    openForPerson, isPersonTab: (p) => personTabs.has(p), openByHand,
    // The browser of the window open now ("pairbrowse", "chromium" or a path), null when none is.
    browserInUse: () => (st.contextPromise ? st.inUse : null),
    // The settings the choice is read from (config with the older names as the person wrote them).
    choiceConfig,
    getContext, watchClose, current: () => st.contextPromise, profile, openPages, findPage, pageAt, ready, takeRestoredActive, touch,
    isRestoring: () => st.restoring !== null, isSwitching: () => st.switching,
    currentUrl: () => st.lastCurrentUrl, setCurrentUrl: (url) => { st.lastCurrentUrl = url; },
    sessionInfo, sessionCommand, startUp, close, sessionName: () => st.session, renameSaved, renameCurrent, saveTabs,
    // The browser's pages used their key (or the helper stops): its file has done its job.
    dropHelperKey: () => dropHelperKey(),
    // The tab a page came back as after its session's browser restarted (a session switch and
    // back), or null.
    successorOf,
    waitForPick, pickerState, pickSession, pickedJoin, switchForPerson, // In the session being opened, when the person just picked another.
    recordPerson: async (person) => { while (st.pickSwitch) await st.pickSwitch; recordPerson(st.session, person); }, picking: () => pick.state === "showing", reopenPicker,
    // An agent chose (pairbrowse_join): the picker goes, the saved tabs come back.
    agentChose(text) {
      if (pick.state !== "showing") { if (pick.state === "pending") pick.state = "done"; return; }
      picked(text);
      const page = pick.page;
      st.contextPromise?.then(async (ctx) => { await page?.goto("about:blank").catch(() => {}); restore(ctx); }).catch(() => {});
    },
  };
}
